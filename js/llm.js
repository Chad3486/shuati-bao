/* ========== LLM 解析引擎（OpenAI 兼容接口） ========== */
const LLM = (() => {

  const DEFAULT_CONFIG = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    visionModel: '', // 视觉模型（图片识别用）：留空=跟随主模型；主模型不支持图片时必须单独指定（如 glm-4v / qwen-vl-plus / gpt-4o-mini）
    temperature: 0.1,
    concurrency: 4,
    maxTokens: 8192, // 单次请求输出上限（tok）：答长题/长解析可调大，受模型上限约束
    priceIn: 2,     // 输入价：¥/百万 tok（仅用于预估与实耗显示，可随模型改价调整）
    priceOut: 8,    // 输出价：¥/百万 tok
    capYuan: 0      // 单次费用上限（¥）：>0 时解题实耗达到上限自动暂停，0=不限
  };

  async function getConfig() {
    const saved = await DB.metaGet('llmConfig');
    return Object.assign({}, DEFAULT_CONFIG, saved || {});
  }
  async function saveConfig(cfg) {
    await DB.metaSet('llmConfig', cfg);
  }

  /* ---- 费用换算：按配置单价把 usage 换成 ¥（预估/实耗同一口径） ---- */
  function costOf(u, cfg) {
    const pIn = parseFloat(cfg && cfg.priceIn) || 0;
    const pOut = parseFloat(cfg && cfg.priceOut) || 0;
    return ((u && u.prompt_tokens) || 0) / 1e6 * pIn + ((u && u.completion_tokens) || 0) / 1e6 * pOut;
  }

  /* ---- 流式响应读取：SSE 增量拼接，逐段回调 onDelta（累计全文） ----
     空闲看门狗：每收到一个数据块就重置 90s 计时——慢模型长输出不再被总时长砍断，
     只在「连数据都收不到」时才判超时。首块到达前的等待同样受看门狗保护。 ---- */
  async function readStream(resp, onDelta, ctl) {
    if (!resp.body || !resp.body.getReader) {
      // 兜底：实现不支持流 → 退回整体 JSON
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '', acc = '', idleTimer = null;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      // v1.7.3：首字到达前等 45s 就砍——网关假死（有响应头但一直不出字）早发现、早重试/早降级；
      // 首字之后放宽到 90s，慢模型长输出不被误砍
      idleTimer = setTimeout(() => ctl.abort(Object.assign(
        new Error(acc ? '请求超时（90 秒没收到新数据）' : '请求超时（45 秒没等到首字）'),
        { timeout: true })), acc ? 90000 : 45000);
    };
    try {
      resetIdle();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdle();
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') return acc;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) { acc += delta; onDelta(acc); }
            // 开启 include_usage 时，最后一个 chunk 会带 usage（供费用统计）
            if (j.usage) _lastUsage = j.usage;
          } catch (e) { /* 半截 JSON 行：下个数据块补齐后再解析 */ }
        }
      }
      return acc;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  /* ---- 单次 chat 调用 ---- */
  async function chat(messages, { onRetry, raw = false, signal = null, onDelta = null, modelOverride = null } = {}) {
    const cfg = await getConfig();
    if (!cfg.apiKey) throw new Error('请先在「设置」中配置 API Key');

    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const maxRetry = 4;
    let lastErr = null;
    // 传了 onDelta → 走流式：首字 1~2 秒可见，边生成边显示
    const streaming = typeof onDelta === 'function';
    // v1.7.3：流式连续失败计数——有的网关对 SSE 支持差（长时间「已 0 字」假死），
    // 连续 2 次自动降级为非流式整段接收；重试原因同步透传给任务中心展示
    let streamFails = 0;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      let useStream = streaming && streamFails < 2;
      try {
        // 外部中止（如「暂停」）→ 立即停手，不发请求不烧 token
        if (signal && signal.aborted) throw Object.assign(new Error('已暂停（当前请求已中断）'), { aborted: true });
        // 全局限流阀：上一请求撞 429 时，先等冷却结束再发
        const wait = _throttleUntil - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        // 请求级超时：手机网络弱时 fetch 可能挂起几分钟。
        // 连不通看门狗对流式同样生效（v1.7.1 修复：此前流式在「等响应头」阶段无超时，
        // 弱网下 fetch 挂起 = 永远卡住，重试逻辑走不到）；响应头到达后，
        // 流式交给 readStream 的空闲看门狗（连接挂起同样会被砍）
        const payload = { model: modelOverride || cfg.model, messages, temperature: cfg.temperature, max_tokens: Math.max(256, parseInt(cfg.maxTokens, 10) || 8192) };
        // response_format 仅对支持的 API 生效（DeepSeek/GPT），小米 MiMo 等不支持的 API 跳过
        // 通过 Prompt 约束输出格式，不依赖此参数
        if (!raw && cfg.baseUrl && /deepseek|openai|api\.openai/i.test(cfg.baseUrl)) {
          payload.response_format = { type: 'json_object' };
        }
        if (useStream) {
          payload.stream = true;
          payload.stream_options = { include_usage: true }; // 末端 chunk 附带 usage，保住费用统计
        }
        const body = JSON.stringify(payload);
        const ctl = new AbortController();
        // 解题场景用较短超时（30s），其他场景用原超时
        const timeout = opts._solveMode ? 30000 : (useStream ? 60000 : 90000);
        let timer = null;
        timer = setTimeout(() => ctl.abort(Object.assign(new Error('请求超时（网络连不通）'), { timeout: true })), timeout);
        const onAbort = () => ctl.abort('aborted');
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        let resp;
        try {
          resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + cfg.apiKey
            },
            body,
            signal: ctl.signal
          });
        } finally {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
        if (!resp.ok) {
          if (resp.status === 429) {
            // 撞限流：读 Retry-After（秒），无头默认 15s；整段冷却时间翻倍逐次递增
            const ra = parseInt(resp.headers.get('retry-after'), 10);
            const cool = (ra > 0 ? ra * 1000 : 15000) * (attempt + 1);
            _throttleUntil = Date.now() + cool;
            if (onRetry) onRetry(attempt + 1, Math.round(cool / 1000), 'API 限流');
            lastErr = new Error('API 429 限流');
            continue;
          }
          const errText = await resp.text().catch(() => '');
          throw new Error(`API ${resp.status}: ${errText.slice(0, 300)}`);
        }
        let content;
        if (useStream) {
          if (attempt > 0 && onDelta) onDelta(''); // 重试后清空已显示的残段
          content = await readStream(resp, onDelta, ctl);
          if (!content) throw new Error('API 返回为空');
        } else {
          const data = await resp.json();
          content = data.choices?.[0]?.message?.content;
          if (!content) throw new Error('API 返回为空');
          // 累计 token 用量（DeepSeek/OpenAI 都回 usage），用于费用估算与实际消耗展示
          if (data.usage) _lastUsage = data.usage;
        }
        return content;
      } catch (e) {
        lastErr = e;
        // 调用方暂停（外部 abort）→ 直接抛「已中断」，不重试烧 token
        if (e.aborted || (signal && signal.aborted)) {
          throw Object.assign(new Error('已暂停（当前请求已中断）'), { aborted: true });
        }
        // 网络错误 / 超时 / 5xx → 重试；400/401/403/404 配置错误直接抛
        if (/API (400|401|403|404)/.test(e.message)) throw e;
        // v1.7.3：流式失败计数 + 重试原因透传（任务中心显示「第 N/4 次重试 · 原因」）
        if (useStream) {
          streamFails++;
          if (streamFails === 2) e._degraded = true; // 连续两次流式失败 → 本请求降级整段模式
        }
        if (attempt < maxRetry) {
          const why = e._degraded ? '流式不出字，已切换整段接收模式'
            : /超时|timeout/i.test(e.message) ? '请求超时'
            : /Failed to fetch|NetworkError|network|fetch/i.test(e.message) ? '网络连不上'
            : /^API 5\d\d/.test(e.message) ? '服务过载'
            : '返回异常：' + String(e.message || '').slice(0, 50);
          if (onRetry) onRetry(attempt + 1, 0, why);
          // 弱网退避：3s 起步逐次加长，给手机网络恢复时间
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        }
      }
    }
    const isNet = /Failed to fetch|NetworkError|timeout|aborted|network/i.test(lastErr?.message || '');
    throw new Error(isNet
      ? `网络连不上 API（已重试 ${maxRetry} 次）：请检查手机网络/代理，或稍后再试。也可换个网络（如切流量）`
      : (lastErr?.message || '未知错误'));
  }

  /* 全局限流冷却截止时间（429 后所有 worker 共同遵守） */
  let _throttleUntil = 0;
  /* 最近一次 API 返回的 token 用量（用于费用估算回填） */
  let _lastUsage = null;
  function getLastUsage() { return _lastUsage; }

  /* ---- JSON 容错解析 ---- */
  function parseJSON(text) {
    if (!text) return null;
    let t = text.trim();
    // 去 markdown 代码块
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    // 部分模型会加前后缀说明文字，找最外层 [ ] 或 { }
    const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    let obj = tryParse(t);
    if (obj) return obj;
    const s1 = t.indexOf('['), e1 = t.lastIndexOf(']');
    if (s1 >= 0 && e1 > s1) { obj = tryParse(t.slice(s1, e1 + 1)); if (obj) return obj; }
    const s2 = t.indexOf('{'), e2 = t.lastIndexOf('}');
    if (s2 >= 0 && e2 > s2) { obj = tryParse(t.slice(s2, e2 + 1)); if (obj) return obj; }
    return null;
  }

  /* ---- 从全文提取答案区（启发式），返回 { text, first, last }（first/last 为答案区行区间，可能为 null）：
     A. 逐行答案条目：「2、答案：A（解析：…）」「3.答案：BCD」「4、对」——出现≥5条即认定答案区，
        连同其间的 章/节 标题一起收集（保留结构上下文，供跨节对位）
     B. 传统模式：密集答案行「1.C 2.A」（每行≥3对）或「参考答案」等标题触发 ---- */
  function findAnswerTableSpan(text) {
    const lines = text.split('\n');
    let first = null, last = null;
    const mark = i => { if (first == null) first = i; last = i; };
    const isStruct = t => /^第\s*[一二三四五六七八九十\d]+\s*章/.test(t) ||
      /^[一二三四五六七八九十]+\s*[、.．]/.test(t) ||
      /^(单项选择题|单选题|多项选择题|多选题|判断题|填空题|选择题)\s*[：:]?\s*$/.test(t);
    // 逐行答案条目：题号 + (答案：)? + 字母/对错，尾部仅允许 解析括号 / 少量标点
    const entryRe = /^\d{1,3}\s*[.、．:：)）]?\s*(?:答案\s*[:：]?\s*)?([A-Ha-hＡ-Ｈａ-ｈ]{1,4}|对|错|√|×|正确|错误)(?![A-Za-z0-9])/;
    const tailOk = rest => {
      const r = rest.trim();
      if (!r) return true;
      if (/^[（(【\[]\s*(答案解析|解析|解释|说明)/.test(r)) return true;
      if (/^[）)】,，。;；、\s]{0,2}$/.test(r)) return true;
      return false;
    };
    const entryIdx = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(entryRe);
      if (m && tailOk(lines[i].slice(m.index + m[0].length))) entryIdx.push(i);
    }
    if (entryIdx.length >= 5) {
      const out = [];
      first = entryIdx[0]; last = entryIdx[entryIdx.length - 1];
      for (let i = first; i <= last; i++) {
        const t = lines[i].trim();
        if (!t) continue;
        if (isStruct(t)) { out.push(t); continue; }
        if (entryIdx.includes(i)) out.push(t);
      }
      return { text: out.join('\n'), first, last };
    }
    // 传统模式：密集答案行 / 答案区标题 / 逐行答案条目
    const tableLines = [];
    let inTable = false;
    // 匹配 "1.C 2.A" / "1、C" / "1.对 2.错" 等密集答案行
    const pair = /(\d{1,3})\s*[.、．:：)]?\s*([A-D]|对|错|√|×)(?![A-Za-z0-9])/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/参考答案|答案速查|答案表|答案汇总/.test(line)) { inTable = true; tableLines.push(line); mark(i); continue; }
      // 逐行答案条目（「2、答案：A（解析：…）」）
      const mE = line.match(entryRe);
      if (mE && tailOk(line.slice(mE.index + mE[0].length))) { inTable = true; tableLines.push(line); mark(i); continue; }
      // 多字母密集表（「1.ABD 2.BC」「1.对 2.错」：整行除题号/答案/分隔符外无其他内容）
      if (tryDenseLine(line)) { inTable = true; tableLines.push(line); mark(i); continue; }
      let count = 0; let m;
      pair.lastIndex = 0;
      while ((m = pair.exec(line)) !== null) count++;
      if (count >= 3) { inTable = true; tableLines.push(line); mark(i); }
      else if (inTable && count > 0) { tableLines.push(line); mark(i); } // 表内续行（如「1.B 2.A 3.绝缘栅双极型晶体管」混排填空答案）
      else if (inTable && line.trim() === '') { /* 表中空行跳过 */ }
      else if (inTable && count === 0 && tableLines.length > 0 && !/^答案/.test(line)) {
        // 表结束条件：连续非答案行
        if (!lines[i + 1] || !/(参考答案|答案)/.test(lines[i + 1])) inTable = false;
      }
    }
    return { text: tableLines.join('\n'), first, last };
  }
  function findAnswerTable(text) { return findAnswerTableSpan(text).text; }

  /* ================= 配套答案文件 · 结构化解析与精确匹配 ================= */

  const fullToHalf = s => String(s).replace(/[Ａ-Ｈａ-ｈ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  function normLetters(s) {
    const t = fullToHalf(String(s || '')).replace(/[\s,，、]/g, '');
    return /^[A-Ha-h]+$/.test(t) ? t.toUpperCase() : null;
  }
  function secTypeOfTitle(s) {
    if (/单选|只选/.test(s) && /题/.test(s)) return 'single';
    if (/多选/.test(s)) return 'multi';
    if (/判断/.test(s)) return 'judge';
    if (/填空/.test(s)) return 'fill';
    return null;
  }

  /* ---- 剥出答案值与解析：「A（解析：xx）」→ { A, xx } ---- */
  function splitExplanation(body) {
    const pats = [
      /[（(]\s*(?:答案解析|解析|解释|说明)\s*[:：]?\s*([\s\S]*?)\s*[)）]\s*$/,
      /[【\[]\s*(?:答案解析|解析|解释|说明)\s*[:：]?\s*([\s\S]*?)\s*[】\]]\s*$/,
      /[,，。;；]\s*(?:答案解析|解析|解释|说明)\s*[:：]\s*([\s\S]*)$/,
      /^(?:答案解析|解析)\s*[:：]\s*([\s\S]*)$/
    ];
    for (const re of pats) {
      const m = body.match(re);
      if (m) {
        const explanation = m[1].trim() || null;
        return { answerPart: body.slice(0, m.index).trim(), explanation };
      }
    }
    return { answerPart: body.trim(), explanation: null };
  }

  /* ---- 答案值分类：字母（A/ACD/ＡＢ）→ 判断词（对/错/√/×/正确/错误）→ 文本（填空）
     「AB（存疑）」等尾部标注会剥掉，并把标注并进解析提示 ---- */
  function classifyAnswerToken(part, secType) {
    let t = String(part || '').trim().replace(/^[：:]\s*/, '');
    if (!t) return null;
    let note = null;
    const nm = t.match(/\s*[（(]\s*(存疑|争议|待定|不确定|仅供参考)\s*[)）]\s*$/);
    if (nm) { note = nm[1]; t = t.slice(0, nm.index).trim(); }
    const wrap = t.match(/^[（(]\s*(.+?)\s*[)）]$/); // 答案：（A）
    if (wrap) t = wrap[1].trim();
    const letters = normLetters(t);
    if (letters) return { answer: letters, kind: 'letter', raw: t, note };
    if (/^(对|正确|√|✓|是)$/.test(t)) return { answer: 'A', kind: 'judge', raw: t, note };
    if (/^(错|错误|×|✗|否)$/.test(t)) return { answer: 'B', kind: 'judge', raw: t, note };
    if (secType === 'judge' && /^(T|Y|TRUE)$/i.test(t)) return { answer: 'A', kind: 'judge', raw: t, note };
    if (secType === 'judge' && /^(F|N|FALSE)$/i.test(t)) return { answer: 'B', kind: 'judge', raw: t, note };
    t = t.replace(/[。；;]\s*$/, '').trim();
    if (!t || /^(见解析|略|无)$/.test(t)) return null;
    return { answer: t, kind: 'text', raw: t, note };
  }

  /* ---- 密集答案行：「1.C 2.A 3.B」「1.对 2.错」→ 多条目 ---- */
  function tryDenseLine(t) {
    const re = /(\d{1,3})\s*[.、．:：)）]?\s*([A-H]{1,4}|对|错|√|×)(?![A-Za-z0-9])/g;
    const pairs = [...t.matchAll(re)];
    if (pairs.length < 2) return null;
    const rest = t.replace(re, '').replace(/[\s,，、.。;；:：（()）]/g, '');
    if (rest.length > 0) return null; // 还有别的内容 → 不是纯答案表行
    return pairs.map(p => {
      const v = p[2];
      const isJudge = /^(对|√)$/.test(v) ? 'A' : (/^(错|×)$/.test(v) ? 'B' : v);
      return { no: +p[1], answer: isJudge, kind: isJudge === v ? 'letter' : 'judge', raw: v };
    });
  }

  /* ---- 配套答案文件解析：逐行追踪 章/节 标题，输出带章节上下文的答案条目 ----
     支持「2、答案：A（解析：…）」「3.答案：BCD」「4、对」「1.C 2.A」「第1题 答案：C」「题号：1 答案：C」「答案：A」纯序列 ---- */
  function parseAnswerDocument(text) {
    const lines = String(text || '').split('\n');
    const entries = [];   // 带题号条目 { no, chapter, section, secType, answer, kind, raw, explanation }
    const ordered = [];   // 全部答案按出现顺序（无题号文件的序列兜底）
    let chapter = null, section = null, secType = null;

    const pushEntry = (no, cls, explanation) => {
      // 答案文件里的「（存疑）」等标注并进解析，练习时能看到提示
      let exp = explanation || null;
      if (cls.note) exp = exp ? `${exp}（答案文件标注：${cls.note}）` : `（答案文件标注：${cls.note}）`;
      const e = { no, chapter, section, secType, answer: cls.answer, kind: cls.kind, raw: cls.raw, explanation: exp };
      if (no != null) entries.push(e);
      ordered.push({ answer: cls.answer, kind: cls.kind, raw: cls.raw, explanation: exp });
    };

    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      // 章 / 节 / 题型标题（与题目文件同名结构对齐）
      if (/^第\s*[一二三四五六七八九十\d]+\s*章/.test(t)) { chapter = t.slice(0, 40); section = null; secType = null; continue; }
      if (/^[一二三四五六七八九十]+\s*[、.．]/.test(t) || /^(单项选择题|单选题|多项选择题|多选题|判断题|填空题|选择题)\s*[：:]?\s*$/.test(t)) {
        section = t.slice(0, 20); secType = secTypeOfTitle(t); continue;
      }
      // 题号前缀（三选一）+ 可选「答案：」
      let no = null, rest = null;
      let m = t.match(/^(\d{1,3})\s*[.、．:：)）=－-]\s*/);
      if (m) { no = +m[1]; rest = t.slice(m[0].length); }
      if (no == null && (m = t.match(/^第\s*(\d{1,3})\s*题\s*/))) { no = +m[1]; rest = t.slice(m[0].length); }
      if (no == null && (m = t.match(/^题号\s*[:：]?\s*(\d{1,3})\s*/))) { no = +m[1]; rest = t.slice(m[0].length); }
      if (no == null && (m = t.match(/^(\d{1,3})\s+(?=[A-Ha-hＡ-Ｈａ-ｈ对错√×])/))) { no = +m[1]; rest = t.slice(m[0].length); }
      if (no != null) {
        const mA = rest.match(/^答案\s*[:：]?\s*/);
        const hasMarker = !!mA;
        if (mA) rest = rest.slice(mA[0].length);
        const { answerPart, explanation } = splitExplanation(rest);
        const cls = classifyAnswerToken(answerPart, secType);
        // 无「答案：」标记时只收字母/判断类（避免把题目行当答案）
        if (cls && (hasMarker || cls.kind !== 'text')) { pushEntry(no, cls, explanation); continue; }
      }
      // 密集答案行
      const dense = tryDenseLine(t);
      if (dense) { for (const d of dense) pushEntry(d.no, d, null); continue; }
      // 无题号答案行（序列模式）
      const m2 = t.match(/^(?:答案|答)\s*[:：]\s*([\s\S]+)$/);
      if (m2) {
        const { answerPart, explanation } = splitExplanation(m2[1]);
        const cls = classifyAnswerToken(answerPart, secType);
        if (cls) ordered.push({ answer: cls.answer, kind: cls.kind, raw: cls.raw, explanation: explanation || null });
      }
    }
    return { entries, ordered, hasNos: entries.length >= 3 };
  }

  /* ---- 答案文件判定辅助：答案行占比（导入时区分题目文件 / 答案文件） ---- */
  function answerLineRatio(text) {
    const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return 0;
    let n = 0;
    for (const t of lines) {
      if (/^\d{1,3}\s*[.、．:：)）]?\s*(?:答案\s*[:：]?\s*)?[A-Ha-hＡ-Ｈａ-ｈ](?![A-Za-z0-9])/.test(t) ||
          /^\d{1,3}\s*[.、．:：)）]?\s*(?:答案\s*[:：]?\s*)?(对|错|√|×|正确|错误)/.test(t) ||
          /^(?:答案|答)\s*[:：]/.test(t)) n++;
    }
    return n / lines.length;
  }

  /* ---- 配套答案匹配：按 章+节+题号 精确对位，逐级回退（章+题号 → 节+题号 → 裸题号 → 顺序）
     同时填入解析；按题型校验答案合法性，多候选无法区分时宁缺毋错 ---- */
  function matchAnswersStructured(questions, sections, parsed) {
    const res = { filled: 0, explained: 0 };
    if (!parsed || (!parsed.entries.length && !parsed.ordered.length)) return res;

    const normTitle = s => String(s || '').trim()
      .replace(/单项选择题/g, '单选题').replace(/多项选择题/g, '多选题');

    // 问题侧：secIdx → { chapter, section, type }
    const secMeta = new Map();
    let curChapter = null;
    for (const s of (sections || [])) {
      const title = s.title || null;
      const isChap = title && /^第\s*[一二三四五六七八九十\d]+\s*章/.test(title);
      if (isChap) curChapter = title;
      secMeta.set(s.secIdx, {
        chapter: isChap ? title : curChapter,
        section: isChap ? null : (title ? normTitle(title) : null),
        type: s.type || null
      });
    }

    // 答案侧索引
    const exact = new Map(), chapNo = new Map(), secNo = new Map(), bareNo = new Map();
    const put = (m, k, e) => { if (!m.has(k)) m.set(k, []); m.get(k).push(e); };
    for (const e of parsed.entries) {
      const chap = e.chapter || null;
      const sec = e.section ? normTitle(e.section) : null;
      if (chap && sec) put(exact, chap + '|' + sec + '|' + e.no, e);
      if (chap) put(chapNo, chap + '|' + e.no, e);
      if (sec) put(secNo, sec + '|' + e.no, e);
      put(bareNo, String(e.no), e);
    }

    const valid = (q, e) => {
      if (!e || !e.answer) return false;
      if (!q.options || q.type === 'fill') return String(e.answer).trim().length > 0;
      const letters = normLetters(e.answer);
      if (!letters) return false;                       // 选项题不能配文本答案
      if ([...letters].some(c => !q.options[c])) return false;
      if ((q.type === 'single' || q.type === 'judge') && letters.length !== 1) return false;
      return true;
    };
    const apply = (q, e) => {
      if (!valid(q, e)) return false;
      if (q.type === 'fill' || !q.options) q.answer = String(e.kind === 'text' ? e.answer : (e.raw || e.answer)).trim();
      else q.answer = normLetters(e.answer);
      if (e.explanation && !q.explanation) { q.explanation = e.explanation; res.explained++; }
      res.filled++;
      return true;
    };
    const pick = (cands, q, meta) => {
      if (!cands || !cands.length) return null;
      const ok = cands.filter(e => valid(q, e));
      if (!ok.length) return null;
      if (ok.length === 1) return ok[0];
      const byType = ok.filter(e => e.secType && meta && meta.type && e.secType === meta.type);
      return byType.length === 1 ? byType[0] : null; // 多候选且分不清 → 放弃，宁缺毋错
    };

    const targets = questions.filter(q => !q.answer);
    // P1 章+节+题号 → P2 章+题号 → P3 节+题号 → P4 裸题号
    for (const q of targets) {
      const meta = q.key ? secMeta.get(+String(q.key).split('-')[0]) || null : null;
      let e = null;
      if (meta) {
        if (meta.chapter && meta.section) e = pick(exact.get(meta.chapter + '|' + meta.section + '|' + q.no), q, meta);
        if (!e && meta.chapter) e = pick(chapNo.get(meta.chapter + '|' + q.no), q, meta);
        if (!e && meta.section) e = pick(secNo.get(meta.section + '|' + q.no), q, meta);
      }
      if (!e) e = pick(bareNo.get(String(q.no)), q, meta);
      if (e) apply(q, e);
    }
    // P5 纯序列（答案文件无题号）：按出现顺序对位（已答的也占位，保持对齐）
    if (!parsed.entries.length && parsed.ordered.length) {
      let si = 0;
      for (const q of questions) {
        const e = parsed.ordered[si++];
        if (!e) break;
        if (!q.answer) apply(q, e);
      }
    }
    return res;
  }

  /* ================= AI 辅助录入 · 从答案文件原文智能对位 =================
     定位：本地结构化匹配（matchAnswersStructured）的兜底——格式怪异/题号错位/
     无章节标题导致正则对不上时，交给 AI 按语义从答案原文里找答案照抄填入。
     关键设计（保正确率）：
     1. AI 只做「对位+照抄」，明确禁止自己推理做题——答案文件里就是标准答案
     2. 每题带章节上下文 + 题号 + 题型 + 题干，给 AI 足够对位线索
     3. 回填前过同一套题型校验（single/judge→单字母且在选项内，multi→字母合法，fill→文本）
     4. 答案原文超长自动分片轮询；失败批次重试；并发可配 */
  async function aiMatchAnswers(questions, answerText, sections, onProgress, onRetry, onBatchSave) {
    const res = { filled: 0, explained: 0 };
    let pool = questions.filter(q => !q.answer);
    if (!pool.length || !answerText || !String(answerText).trim()) return res;

    const cfg = await getConfig();
    const concurrency = Math.max(1, Math.min(4, parseInt(cfg.concurrency, 10) || 4));
    const BATCH = 12;      // 每批题数
    const SLICE = 48000;   // 答案原文分片大小（字符）

    // 题目侧章节上下文（与 matchAnswersStructured 同源），给 AI 对位线索
    const secMeta = new Map();
    let curChapter = null;
    for (const s of (sections || [])) {
      const title = s.title || null;
      const isChap = title && /^第\s*[一二三四五六七八九十\d]+\s*章/.test(title);
      if (isChap) curChapter = title;
      secMeta.set(s.secIdx, { chapter: isChap ? title : curChapter, section: isChap ? null : title });
    }
    const contextOf = q => {
      if (!q.key) return null;
      const m = secMeta.get(+String(q.key).split('-')[0]);
      return m ? [m.chapter, m.section].filter(Boolean).join(' / ') || null : null;
    };

    const PROMPT = `你是答案匹配专家。输入包含【题目列表】和【答案文件原文】，答案文件原文里写着每道题的标准答案。
请从答案文件原文中找出每道题对应的答案（按题号、章节标题、题型、题干内容对位），严格按 JSON 输出（不要 markdown、不要解释文字）：
{"answers":[{"idx":0,"answer":"C","explanation":"答案文件原文中该题的解析，没有则留空"}]}
规则：
- idx 是【题目列表】里每题的序号（从 0 开始）
- 选择题 answer 为选项字母串，如 "C"、"ACD"；单选题只填 1 个字母
- 判断题：原文「对/正确/√」→ answer 填 "A"；「错/错误/×」→ answer 填 "B"
- 填空题 answer 为答案文本
- 必须照抄答案文件原文中的答案，禁止自己推理做题
- 答案文件原文里找不到对应答案的题，不要输出该项
- explanation 仅当答案原文带解析时照抄，否则留空`;

    // 一批题目 + 一片答案原文 → AI 对位 → 校验回填
    const fillBatch = async (batch, sliceText) => {
      const body = batch.map((q, i) => ({
        idx: i,
        no: q.no ?? undefined,
        context: contextOf(q) || undefined,
        type: q.type,
        stem: String(q.stem || '').slice(0, 60),
        options: q.options ? Object.keys(q.options).join('') : undefined
      }));
      const raw = await chat([
        { role: 'system', content: PROMPT },
        { role: 'user', content: '【题目列表】\n' + JSON.stringify(body) + '\n\n【答案文件原文】\n' + sliceText }
      ], { onRetry });
      const obj = parseJSON(raw);
      const arr = obj?.answers || obj;
      if (!Array.isArray(arr)) throw new Error('AI 返回非 JSON');
      let got = 0, exp = 0;
      for (const a of arr) {
        const q = batch[a?.idx];
        if (!q || q.answer) continue;
        let ans = String(a.answer ?? '').trim();
        if (!ans || ans === 'null') continue;
        if (q.options && q.type !== 'fill') {
          // 选项题：同结构化匹配的严格校验
          const letters = normLetters(ans);
          if (!letters) continue;                                       // 选项题不收文本答案
          if ([...letters].some(c => !q.options[c])) continue;           // 字母不在选项里
          if ((q.type === 'single' || q.type === 'judge') && letters.length !== 1) continue; // 单选/判断必须单字母
          q.answer = letters;
        } else {
          // 填空/无选项题：收文本，限长
          if (ans.length > 80) ans = ans.slice(0, 80);
          q.answer = ans;
        }
        if (a.explanation && !q.explanation) { q.explanation = String(a.explanation).trim(); exp++; }
        got++;
      }
      return { got, exp };
    };

    // 分片轮询：答案原文超长时逐片查找（前面片找不到的题进入下一片）
    const text = String(answerText).trim();
    const slices = [];
    for (let i = 0; i < text.length; i += SLICE) slices.push(text.slice(i, i + SLICE));

    for (let si = 0; si < slices.length && pool.length; si++) {
      let retriesLeft = 1; // 每片失败批重试 1 次
      while (pool.length) {
        const batches = [];
        for (let i = 0; i < pool.length; i += BATCH) batches.push(pool.slice(i, i + BATCH));
        let bIdx = 0, done = 0;
        const netFailed = [];
        await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
          while (bIdx < batches.length) {
            const batch = batches[bIdx++];
            try {
              const { got, exp } = await fillBatch(batch, slices[si]);
              res.filled += got; res.explained += exp;
              if (got && onBatchSave) { try { await onBatchSave(batch); } catch (e) { /* 保存失败不中断 */ } }
            } catch (e) { netFailed.push(batch); }
            done++;
            if (onProgress) onProgress(done, batches.length, res.filled, si + 1, slices.length);
          }
        }));
        pool = pool.filter(q => !q.answer);
        if (!netFailed.length || !pool.length || retriesLeft-- <= 0) break;
        pool = netFailed.flat().filter(q => !q.answer);
      }
    }
    return res;
  }

  /* ---- 整体解析 · 纯本地：正则切题 + 逐题解析 + 答案表匹配（0 次 API 调用、无需 API Key） ---- */
  async function parseDocument(fullText, onProgress) {
    const text = Extractor.cleanText(fullText);
    const answerTable = findAnswerTable(text);

    // 1) 确定性切题
    const split = Extractor.splitQuestions(text);

    // 2) 本地正则解析（毫秒级、零费用）——透传节题型/节键
    const questions = [];
    for (const it of split.items) {
      const q = Extractor.parseOneQuestion(it.no, it.text, it.type, it.key);
      if (q && q.stem) questions.push(q);
    }
    for (const q of questions) delete q._local;

    // 3) 答案区本地匹配：同文件答案表 / 逐行答案条目 → 按 章+节+题号 填答案与解析
    if (answerTable && answerTable.trim()) {
      const parsedAns = parseAnswerDocument(answerTable);
      if (parsedAns.entries.length || parsedAns.ordered.length) {
        matchAnswersStructured(questions, split.sections, parsedAns);
      }
    }

    if (onProgress) onProgress(1, 1, questions.length);

    const answered = questions.filter(q => q.answer).length;
    return {
      questions, answered, noAnswer: questions.length - answered,
      splitTotal: split.total, localCount: questions.length, aiCount: 0,
      degraded: questions.filter(q => q._degraded).length,
      missingNos: split.missingNos, dupNos: split.dupNos, problems: split.problems,
      sections: split.sections,
      dropped: Math.max(0, split.total - questions.length),
      mode: 'local'
    };
  }

  /* ================= 第二步 · 答案补全 ================= */

  /* ---- 把答案文件文本解析成 { 题号: 答案 } 映射（兼容旧接口，内部走结构化解析器） ----
     支持："1.C 2.A 3.B" / "1、C" / "2、答案：A（解析：…）" / "题号:1 答案:C" / "A B C D"（纯序列按顺序） ---- */
  function parseAnswerMap(text) {
    const parsed = parseAnswerDocument(text);
    if (parsed.entries.length >= 3) {
      const map = new Map();
      for (const e of parsed.entries) if (!map.has(e.no)) map.set(e.no, e.answer);
      return { map, mode: 'numbered' };
    }
    if (parsed.ordered.length >= 3) {
      const map = new Map();
      parsed.ordered.forEach((o, i) => map.set(i + 1, o.answer));
      return { map, mode: 'sequence' };
    }
    return { map: new Map(), mode: 'none' };
  }

  /* ---- 用答案映射给题目填答案（按题号；序列模式按顺序，已答题也消耗序号保持对齐） ---- */
  function matchAnswers(questions, answerMap, mode) {
    let filled = 0;
    let seqIdx = 0;
    for (const q of questions) {
      if (mode === 'sequence') {
        // 序列模式：每道题都占一个位置（答案文件通常是完整的）
        const seq = ++seqIdx;
        if (!q.answer) {
          const ans = answerMap.get(seq);
          if (ans && !(q.options && [...ans].some(c => !q.options[c]))) {
            q.answer = ans;
            filled++;
          }
        }
        continue;
      }
      if (q.answer) continue;
      if (q.no != null) {
        const ans = answerMap.get(q.no);
        if (ans && !(q.options && [...ans].some(c => !q.options[c]))) {
          q.answer = ans;
          filled++;
        }
      }
    }
    return filled;
  }

  /* ---- 长文档切片：累积到目标长度后，尽量在「空行 / 题号行 / 章节标题 / 题型标记行」处断开，
     避免把一道题切成两半（fileToCanon 与 fileToCanonLite 共用） ---- */
  function chunkSource(src, TARGET) {
    const chunks = [];
    let buf = [], size = 0;
    const flush = () => { const t = buf.join('\n').trim(); if (t) chunks.push(t); buf = []; size = 0; };
    for (const line of src.split('\n')) {
      buf.push(line);
      size += line.length + 1;
      if (size < TARGET) continue;
      const t = line.trim();
      const boundary = !t || /^\d{1,3}\s*[.、．]/.test(t) || /^第\s*[一二三四五六七八九十\d]+\s*章/.test(t) ||
        /^[一二三四五六七八九十]+\s*[、.．]/.test(t) || /^【/.test(t) || /^#{1,2}\s/.test(t);
      if (boundary || size >= TARGET * 1.6) flush();
    }
    flush();
    return chunks;
  }

  /* ================= 文件 → 范式（AI 只排版，不做题） =================
     与「AI 解题」相反：答案必须从原卷（题目下方标注 / 文末答案表）照抄，AI 严禁自己推理作答。
     用途：原卷排版太乱、本地规则切不出题时，让 AI 把「正文片段 + 全文答案表」重排成范式文本；
     产物仍是纯文本，交给本地的 Canon.parse 预览 → 导入，导入环节 0 次 API 调用。
     长文档按 空行/题号行/章节标题 就近切片，避免把一道题切成两半。 */
  async function fileToCanon(text, onProgress, onRetry, onDelta, onPiece) {
    const src = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!src) throw new Error('文档里没有可转换的文字');

    // 全文答案表（题目文件、独立答案文件都可能有）：作为每片的共享上下文，供跨片按题号对位
    let answerTable = findAnswerTable(src).trim();
    if (answerTable.length > 40000) answerTable = answerTable.slice(0, 40000);

    const PROMPT = `你是题库排版助手。用户会给你【原卷文档片段】，请把它整理成「范式」格式的纯文本。你只做排版，绝对不做题。

范式格式（严格遵守）：
1. 章标题单独一行，以 # 开头：# 第1章 电力电子器件
2. 节标题单独一行，以 ## 开头：## 1.1 电力二极管；题型小节写成 ## 判断题 也可以
3. 每道题一块，题与题之间空一行
4. 题干行最前面写题型标记：【单选】【多选】【判断】【填空】（简答/问答/名词解释/计算统一按【填空】）
5. 选择题每个选项一行：A. 选项内容，必须从 A 开始连续、不缺字母
6. 答案单独一行：答案：B；多选 答案：ABD；判断 答案：对 或 答案：错；多空填空用 ||| 分隔：答案：阳极|||阴极
7. 解析单独一行：解析：……
8. 题号可写在题干最前面：1. 电力二极管属于（ ）器件。

红线（违反即报废）：
- 答案和解析只能「照抄」原卷：题目下方的答案标注，或【全文答案表】里对应的题号条目
- 严禁自己推理、判断、解答；原卷里没有答案的题，不要写「答案：」行，宁缺毋错
- 题干、选项、答案、解析的文字一律原文照抄，不改写、不缩写、不补充、不翻译
- 丢弃页码、页眉页脚、水印、学校名、装订线等噪声
- 只输出范式文本本身：不要任何解释、前后缀说明、markdown 代码块或 JSON`;

    /* 切片：累积到目标长度后，尽量在「空行 / 题号行 / 章节标题 / 题型标记行」处断开 */
    const chunks = chunkSource(src, 5000);

    /* v1.7.3：片段并发处理（读设置并发数，上限 4）——
       各片段相互独立（共享答案表上下文），逐片排队是「转范式卡半天」的主因之一；
       4 路并发约快 4 倍，费用不变。流式回显只跟随当前「持有者」片段，多片不互相打架 */
    const conc = Math.max(1, Math.min(4, parseInt((await getConfig()).concurrency, 10) || 4));
    const pieces = new Array(chunks.length).fill('');
    let next = 0, done = 0, streamOwner = null;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        const head = `【原卷文档片段 ${i + 1}/${chunks.length}】\n` + chunks[i];
        const user = answerTable
          ? `【全文答案表（只能从这里或正文标注处照抄答案）】\n${answerTable}\n\n${head}`
          : head;
        const mine = streamOwner === null;
        if (mine) streamOwner = i;
        let raw = '';
        try {
          raw = await chat([
            { role: 'system', content: PROMPT },
            { role: 'user', content: user }
          ], { onRetry, raw: true, onDelta: onDelta && mine ? (acc) => onDelta(acc, i + 1, chunks.length) : null });
        } finally {
          if (mine) streamOwner = null;
        }
        const piece = String(raw || '').trim()
          .replace(/^```(?:text|markdown|md)?\s*/i, '')
          .replace(/```\s*$/, '')
          .trim();
        if (piece) { pieces[i] = piece; if (onPiece) onPiece(i, chunks.length, piece); }
        if (onProgress) onProgress(++done, chunks.length, `片段 ${done}/${chunks.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, chunks.length) }, worker));
    const out = pieces.filter(Boolean).join('\n\n').trim();
    if (!out) throw new Error('AI 没有返回可用的范式文本');
    return out;
  }

  /* ================= 乱格式快速通道（v1.7.3 · AI 只出标注，本地装配） =================
     病根：全量转范式要 AI 把题干选项逐字重打一遍，1000 题输出几万字，
     十几分钟是模型打字速度的物理上限，怎么优化流程都绕不过去。
     做法：文字已能提取的文档，AI 只输出「标注」——每题的定位开头(at)/题型/答案/解析，
     题干、选项由本地从原文照抄切块装配成范式文本。AI 输出量降到零头，快 5~10 倍，费用也降。
     红线不变：答案只照抄（原卷标注 / 全文答案表），严禁 AI 自己推理；定位失败的题宁缺毋错。
     适用：原卷文字可提取但排版乱（题号怪、答案分离、噪声多）；纯图片仍走视觉识别。 */
  const LITE_PROMPT = `你是题库标注助手。输入【原卷片段】（可能含多道题）和【全文答案表】，找出片段里的每道题，只输出定位与答案标注。严格按 json 输出（不要 markdown 代码块、不要任何解释文字）：
{"questions":[{"at":"题干第一行开头的连续原文","type":"single","answer":"B","exp":"解析原文"}]}
- at：题干第一行里连续的一段原文（10~25 字，可含题号），逐字照抄；程序靠它在原文里定位题目开头，必须与原文完全一致
- type：single / multi / judge / fill（简答、问答、名词解释、计算一律填 fill）
- answer：只照抄——原卷题目旁的答案标注，或【全文答案表】里对应题号的答案；原文没有就省略该字段，严禁自己推理作答
- 选择题 answer 为字母（如 "C"、"ACD"）；判断题为 "对" 或 "错"；填空题照抄文本答案，多个空用 ||| 分隔
- exp：原卷或答案表里有解析才照抄，没有就省略
- 页眉、页脚、页码、水印、装订线不是题，不要输出
- questions 按原文顺序排列，片段里每道题输出一项，不要遗漏`;

  async function fileToCanonLite(text, opts = {}) {
    const { onProgress, onRetry, onDelta, onPiece } = opts;
    const src = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!src) throw new Error('文档里没有可转换的文字');

    // 全文答案表作为每片的共享上下文（与全量转范式同口径）；并把它从正文剥掉——
    // 否则残留的答案表既会挡住 AI 答案的追加（HAS_ANS 误判），还会被 Canon.parse 误认成题目
    const span = findAnswerTableSpan(src);
    let answerTable = span.text.trim();
    if (answerTable.length > 40000) answerTable = answerTable.slice(0, 40000);
    let bodySrc = src;
    if (answerTable && span.first != null && span.last != null) {
      const ls = src.split('\n');
      const stripped = ls.slice(0, span.first).concat(ls.slice(span.last + 1)).join('\n');
      // 护栏：答案区若散布在全文中（如逐题下方标注），剥离会掏空正文——此时不剥，仅作上下文
      const before = src.replace(/\s/g, '').length;
      const after = stripped.replace(/\s/g, '').length;
      if (after >= before * 0.3) bodySrc = stripped.trim();
    }

    const chunks = chunkSource(bodySrc, 3500); // 标注模式输出短，片也切小些，定位更准
    const conc = Math.max(1, Math.min(4, parseInt((await getConfig()).concurrency, 10) || 4));
    const pieces = new Array(chunks.length).fill('');
    let next = 0, done = 0, streamOwner = null;

    /* 定位：把 AI 给的「题干开头」在片段里按行找（忽略空白差异），只往后找不回头 */
    const norm = s => String(s || '').replace(/\s+/g, '');
    const locate = (lines, needle, from) => {
      const n = norm(needle).slice(0, 30);
      if (!n) return -1;
      for (let i = Math.max(0, from); i < lines.length; i++) {
        if (norm(lines[i]).includes(n)) return i;
      }
      // 兜底：题干开头可能被换行截开，相邻两行拼起来再找一次
      for (let i = Math.max(0, from); i < lines.length - 1; i++) {
        if (norm(lines[i] + lines[i + 1]).includes(n)) return i;
      }
      return -1;
    };

    /* 答案清洗：选择题只留字母并排序，判断归一为 对/错，填空照抄 */
    const ansClean = it => {
      if (!it || it.answer == null) return '';
      const t = String(it.answer).trim();
      if (!t) return '';
      if (it.type === 'single' || it.type === 'multi') {
        const letters = t.toUpperCase().replace(/[^A-H]/g, '');
        return letters ? letters.split('').sort().join('') : '';
      }
      if (it.type === 'judge') {
        if (/对|正确|√|true|^T$/i.test(t)) return '对';
        if (/错|误|×|false|^F$/i.test(t)) return '错';
        return '';
      }
      return t; // fill：照抄文本
    };

    /* 装配：按定位行切出每题的原文块，原卷已有答案/解析就不重复追加。
       块尾若挂着下一节的章节标题，先摘出来、答案行插在它前面——
       否则「答案：X」落在节标题之后，导入解析会把它孤立丢弃 */
    const HAS_ANS = /【\s*答案\s*】|^\s*(?:参考答案|正确答案|答案|答)\s*[:：]/m;
    const HAS_EXP = /【\s*解析\s*】|^\s*(?:参考)?解析\s*[:：]/m;
    // 注意：只认中文数字节标题（「二、填空题」「第一部分」），不能放宽到阿拉伯数字——
    // 否则「3．IGBT…」这类题号行会被误当标题整块摘走，答案也随之丢失
    const SEC_HEAD = /^\s*(?:第\s*[一二三四五六七八九十\d]+\s*[章节部分]|[一二三四五六七八九十]+\s*[、.．]|【(?!答案|解析)[^】]{0,12}】|#{1,3}\s)/;
    const assemble = (chunk, items) => {
      const lines = chunk.split('\n');
      const found = [];
      let cursor = 0;
      for (const it of items || []) {
        const L = locate(lines, it && it.at, cursor);
        if (L < 0) continue; // 定位失败的题：宁缺毋错，不乱插答案
        found.push({ line: L, it });
        cursor = L + 1;
      }
      if (!found.length) return '';
      const out = [];
      if (found[0].line > 0) {
        const head = lines.slice(0, found[0].line).join('\n').trim();
        if (head) out.push(head, ''); // 片段开头没被标注到的文字原样保留，交给 Canon.parse 兜底
      }
      for (let k = 0; k < found.length; k++) {
        const end = k + 1 < found.length ? found[k + 1].line : lines.length;
        const blines = lines.slice(found[k].line, end);
        const after = [];
        while (blines.length && !blines[blines.length - 1].trim()) blines.pop();
        while (blines.length && SEC_HEAD.test(blines[blines.length - 1])) {
          after.unshift(blines.pop());
          while (blines.length && !blines[blines.length - 1].trim()) blines.pop();
        }
        const block = blines.join('\n').trim();
        if (block) {
          out.push(block);
          const answer = ansClean(found[k].it);
          if (answer && !HAS_ANS.test(block)) out.push('答案：' + answer);
          const exp = found[k].it && found[k].it.exp ? String(found[k].it.exp).trim() : '';
          if (exp && !HAS_EXP.test(block)) out.push('解析：' + exp.slice(0, 600));
        }
        if (after.length) out.push(after.join('\n'), '');
        else out.push('');
      }
      return out.join('\n').trim();
    };

    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        const head = `【原卷片段 ${i + 1}/${chunks.length}】\n` + chunks[i];
        const user = answerTable
          ? `【全文答案表（答案只能从这里或正文标注处照抄）】\n${answerTable}\n\n${head}`
          : head;
        const mine = streamOwner === null;
        if (mine) streamOwner = i;
        let raw = '';
        try {
          raw = await chat([
            { role: 'system', content: LITE_PROMPT },
            { role: 'user', content: user }
          ], { onRetry, raw: true, onDelta: onDelta && mine ? (acc) => onDelta(acc, i + 1, chunks.length) : null });
        } finally {
          if (mine) streamOwner = null;
        }
        let items = [];
        try {
          const m = String(raw || '').match(/\{[\s\S]*\}/); // 容错：剥掉可能的说明文字，取 JSON 本体
          if (m) {
            const j = JSON.parse(m[0]);
            items = Array.isArray(j.questions) ? j.questions : [];
          }
        } catch (e) { items = []; }
        const piece = items.length ? assemble(chunks[i], items) : '';
        if (piece) { pieces[i] = piece; if (onPiece) onPiece(i, chunks.length, piece); }
        if (onProgress) onProgress(++done, chunks.length, `片段 ${done}/${chunks.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, chunks.length) }, worker));

    const out = pieces.filter(Boolean).join('\n\n').trim();
    if (!out) throw new Error('标注路线没切出题目（原卷格式太乱或 AI 定位失败）');
    return out;
  }

  /* ================= 图片视觉识别（v1.7 · 第三期） =================
     OCR 走后图片型题库的新路：图片直接交给视觉模型转写成范式文本。
     - 每张图独立一次请求：单张失败不拖垮整批（调用方可按图重试/跳过）
     - 流式回显复用 chat() 的 onDelta；重试/限流冷却同样复用
     - 模型用 cfg.visionModel（留空跟随主模型）；主模型无视觉能力时由设置页单独指定
     - 成本：视觉模型按图片 token 计费，每张图约几百到一千输入 tok，显著低于识别错误人工返工的成本 */
  const VISION_PROMPT = `你是专业的试卷转写员。把图片中的全部题目内容逐字转写为「范式文本」，格式要求：
1. 章节标题行：# 第X章 …（图片里没有章节就省略）
2. 小节标题行：## X.X …
3. 题型标记 + 题号 + 题干：【单选】1. …（单选/多选/判断/填空；简答、名词解释、计算等统一按【填空】）
4. 选择题每个选项一行：A. 选项内容，从 A 开始连续不缺字母
5. 答案单独一行：答案：B（多选 答案：ABD；判断 答案：对 或 答案：错；图片里没有答案的题不要编造答案行）
6. 解析单独一行：解析：……（图片里没有解析就省略）
7. 多空填空用 ||| 分隔：答案：阳极|||阴极

红线：
- 只转写图片里实际存在的内容：逐字照抄，不改写、不缩写、不补充、不解答
- 图片模糊看不清的字用 ▢ 占位，不要猜
- 丢弃页码、页眉页脚、水印、装订线等噪声
- 只输出范式文本本身：不要任何解释、前后缀说明或 markdown 代码块`;

  /**
   * 图片 → 范式文本（逐张识别后拼接）
   * @param {Array<{name:string, dataUrl:string}>} images 已压缩好的图片（data:image/jpeg;base64,...）
   * @param {Object} opts { onProgress(i,total,note), onRetry(attempt,coolSec), onDelta(i,total,acc), onPiece(i,total,txt) }
   * @returns {Promise<string>} 所有图片识别文本，按顺序以空行拼接
   */
  async function visionCanon(images, opts = {}) {
    const list = (images || []).filter(x => x && x.dataUrl);
    if (!list.length) throw new Error('没有可识别的图片');
    const cfg = await getConfig();
    const vModel = (cfg.visionModel || '').trim() || cfg.model;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const img = list[i];
      if (opts.onProgress) opts.onProgress(i, list.length, `识别 ${img.name || `图片${i + 1}`}…`);
      const messages = [
        { role: 'system', content: VISION_PROMPT },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: img.dataUrl } },
          { type: 'text', text: '把这张图片中的全部题目转写为范式文本。' }
        ] }
      ];
      const raw = await chat(messages, {
        raw: true,
        modelOverride: vModel,
        onRetry: opts.onRetry,
        onDelta: opts.onDelta ? (acc) => opts.onDelta(i, list.length, acc) : null
      });
      const piece = String(raw || '').trim()
        .replace(/^```(?:text|markdown|md)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      if (piece) { out.push(piece); if (opts.onPiece) opts.onPiece(i, list.length, piece); }
      if (opts.onProgress) opts.onProgress(i + 1, list.length, `已完成 ${i + 1}/${list.length} 张`);
    }
    const joined = out.join('\n\n').trim();
    if (!joined) throw new Error('视觉模型没有返回可用的文本，请检查「设置」中的视觉模型是否支持图片');
    return joined;
  }

  /* ================= 缺答案 AI 解题（只补空答案，绝不覆盖原卷答案） =================
     与「文件 → AI 转范式」配套：范式文本里的题若「答案：」为空，交给 AI 补出来。
     只对 !q.answer 的题调用 API（已答的一律不动，省钱也不覆盖原卷），
     答案写回 question.answer，再由 Canon.serialize 落成「答案：X」行。

     成本控制设计（v1.3.8）：
     1. 预估费用：调用前先算大概批次/费用，让调用方弹窗确认，避免「一点就烧钱」
     2. 立即中断：opts.shouldStop() 返回 true 时停；再传 opts.signal（AbortController.signal）会立即 abort
        进行中的请求，当前批标成可续跑（不进失败队列），已解的题立即落盘
     3. 断点续传：opts.isDone(q) 返回 true 的题直接跳过（配合进度存档）
     4. 答案来源标注：opts.markAI 为 true 时，q.aiAnswer = true，UI 显示「AI 解答·需核对」
     5. 进度回调：onProgress({done,total,solved,paused,stopReason,usage}) 实时反馈
     6. 并发可控：opts.concurrency 覆盖 cfg.concurrency（默认仍读配置，上限 4）
     7. 实耗与上限：每笔请求的 usage 累计入 usage 字段；opts.capYuan>0 时实耗达到上限自动暂停（stopReason='cap'） */
  async function solveMissing(questions, onProgress, onRetry, opts = {}) {
    let pool = (questions || []).filter(q => !q.answer && !(opts.isDone && opts.isDone(q)));
    if (!pool.length) return { solved: 0, usage: { prompt_tokens: 0, completion_tokens: 0 } };
    const BATCH = 10;
    const MAX_ROUNDS = 3;
    const cfg = await getConfig();
    const concurrency = Math.max(1, Math.min(4, parseInt(opts.concurrency || cfg.concurrency, 10) || 4));

    const PROMPT = `你是答题专家。给下列题目补上正确答案。

请严格按照以下 JSON 格式输出，不要输出任何其他文字：
{"answers":[{"idx":0,"answer":"C"}]}

规则：
- idx 是输入里每题的序号（从0开始）
- 选择题 answer 为选项字母，如 "C" 或 "ACD"，必须是题目给定选项里的字母
- 判断题 answer 为 "对" 或 "错"
- 填空题 answer 为答案文本，多个空用 ||| 分隔
- 只给答案，不要写解析
- 不确定的题不要猜，宁可不答
- 必须输出有效的 JSON，不要 markdown 代码块`;

    let solved = 0, round = 0, lastFailNote = '';
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let paused = false, stopReason = '', capHit = false;
    const capYuan = parseFloat(opts.capYuan) || 0;

    const emit = (done, total, note) => {
      if (onProgress) onProgress({ done, total, solved, usage: { ...usage }, cost: +costOf(usage, cfg).toFixed(4), paused, stopReason, note });
    };

    while (pool.length && round < MAX_ROUNDS) {
      // 调用方要求暂停 / 费用触顶 → 立即停止，不再起新一轮
      if (capHit || (opts.shouldStop && opts.shouldStop())) {
        paused = true; stopReason = capHit ? 'cap' : 'paused'; break;
      }
      round++;
      if (round > 1) {
        emit(0, 1, `网络波动，第 ${round} 轮重试（10s 后）`);
        await new Promise(r => setTimeout(r, 10000));
        pool = pool.filter(q => !q.answer);
        if (!pool.length) break;
      }
      const batches = [];
      for (let i = 0; i < pool.length; i += BATCH) batches.push(pool.slice(i, i + BATCH));
      const failed = [];
      let done = 0, idx = 0;
      async function worker() {
        while (idx < batches.length) {
          // 分批暂停：当前批跑完就停，不抢占新批（capHit 时同样让路）
          if (capHit || (opts.shouldStop && opts.shouldStop())) {
            paused = true; stopReason = capHit ? 'cap' : 'paused'; break;
          }
          const batch = batches[idx++];
          const batchIdx = idx; // 记录当前批次号
          const body = batch.map((q, i) => ({ idx: i, type: q.type, stem: q.stem, options: q.options || undefined }));
          let ok = true, failNote = '', solvedHere = 0;
          console.log(`[解题] 批次 ${batchIdx}/${batches.length} 开始，${batch.length} 题`);
          try {
            const raw = await chat([
              { role: 'system', content: PROMPT },
              { role: 'user', content: JSON.stringify(body) }
            ], { onRetry, signal: opts.signal, _solveMode: true });
            console.log(`[解题] 批次 ${batchIdx} API 返回 ${raw ? raw.length : 0} 字`);
            const u = getLastUsage();
            if (u) {
              usage.prompt_tokens += u.prompt_tokens || 0;
              usage.completion_tokens += u.completion_tokens || 0;
              if (capYuan > 0 && costOf(usage, cfg) >= capYuan) capHit = true;
            }
            const obj = parseJSON(raw);
            /* v1.8 修复「AI 解题没效果」：模型返回形态五花八门，全部兼容——
               ① {"answers":[{"idx":0,"answer":"C"}]}（提示词要求的标准形）
               ② [{"idx":0,"answer":"C"}] / [{"no":1,...}]（数组、题号字段名不同）
               ③ ["C","A","B"]（按位置对位的纯字符串数组）
               ④ {"0":"C","1":"A"}（键为序号的对象）
               ⑤ 都不是 → 兜底从原文抓「1. C / 1、C / 1：C」式答案行
               此前只认①，模型一旦换形态整批作废，表现为「解出 0 题、没效果」 */
            let arr = null;
            if (obj) {
              if (Array.isArray(obj.answers)) arr = obj.answers;
              else if (Array.isArray(obj)) arr = obj;
              else if (typeof obj === 'object') {
                const keys = Object.keys(obj);
                if (keys.length && keys.every(k => /^\d+$/.test(k))) {
                  // 序号键可能是 0 起始或 1 起始：min=1 且 max=N（正好铺满）时按 1 起始处理，防整体错位
                  const nums = keys.map(Number).sort((a, b) => a - b);
                  const oneBased = nums[0] === 1 && nums[nums.length - 1] === nums.length;
                  arr = nums.map(n => ({ idx: oneBased ? n - 1 : n, answer: obj[String(n)] }));
                }
              }
            }
            let pairs = null;
            if (Array.isArray(arr)) {
              pairs = arr.map((a, i) => {
                if (typeof a === 'string') return { idx: i, answer: a };           // ③ 位置数组
                if (a && typeof a === 'object') {
                  const idx = a.idx != null ? +a.idx : (a.no != null ? +a.no - 1 : (a.i != null ? +a.i : i));
                  const ans = a.answer != null ? a.answer : (a.ans != null ? a.ans : (a.result != null ? a.result : ''));
                  return { idx, answer: String(ans) };                             // ①② + 字段名变体
                }
                return null;
              }).filter(Boolean);
            } else if (obj && typeof obj === 'object') {
              // {"answers":{"0":"C","1":"A"}} 这类嵌套键值对
              const inner = obj.answers;
              if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
                const keys = Object.keys(inner);
                if (keys.length && keys.every(k => /^\d+$/.test(k))) {
                  const nums = keys.map(Number).sort((a, b) => a - b);
                  const oneBased = nums[0] === 1 && nums[nums.length - 1] === nums.length;
                  pairs = nums.map(n => ({ idx: oneBased ? n - 1 : n, answer: String(inner[String(n)]) }));
                }
              }
            }
            if (!pairs && raw) {
              // ⑤ 非结构化兜底：从返回文本里抓「1. C」「1、C」「1：C」「1) C」式答案行
              const m = [...String(raw).matchAll(/(\d{1,3})\s*[、.．:：)]\s*([A-D]{1,4}\b|对|错|正确|错误|√|×)/g)];
              if (m.length >= Math.max(1, Math.ceil(batch.length / 2))) {
                pairs = m.map(x => ({ idx: +x[1] - 1, answer: x[2] }));
              }
            }
            if (pairs) {
              for (const a of pairs) {
                const q = batch[+a.idx];
                if (!q || q.answer) continue;
                let ans = String(a.answer == null ? '' : a.answer).trim();
                if (!ans) continue;
                if (q.type === 'judge') {
                  if (/^(对|正确|√|✓|是|T|TRUE|A|1)$/i.test(ans)) ans = 'A';
                  else if (/^(错|错误|×|✗|否|F|FALSE|B|0)$/i.test(ans)) ans = 'B';
                  else continue;
                } else if (q.options) {
                  ans = ans.toUpperCase().replace(/[^A-Z]/g, '');
                  if (!ans || [...ans].some(c => !q.options[c])) continue;
                } else {
                  ans = ans.replace(/[。；;]\s*$/, '').trim();
                  if (!ans || /^(略|见解析|无|不知道|无法确定)$/.test(ans)) continue;
                }
                q.answer = ans;
                if (opts.markAI) q.aiAnswer = true;   // 标记来源：AI 解答，UI 需核对
                solved++; solvedHere++;
              }
            }
            // 返回没解析出任何答案对、或一题都没解出 → 标失败进重试队列（避免静默"什么都不出"）
            if (!pairs || solvedHere === 0) {
              ok = false;
              // 显示详细原因：是解析失败还是校验失败
              if (!pairs) {
                failNote = '解析失败: ' + (raw || '(空)').replace(/\s+/g, ' ').slice(0, 60);
              } else {
                failNote = `校验失败: 返回 ${pairs.length} 个答案，但 0 个通过校验`;
              }
              console.log(`[解题] 批次 ${batchIdx} ${failNote}`);
            } else {
              console.log(`[解题] 批次 ${batchIdx} 成功解出 ${solvedHere} 题`);
            }
          } catch (e) {
            // 暂停/外部中断：当前批标成可续跑（不进失败队列），立即收摊
            if (e.aborted || (opts.signal && opts.signal.aborted)) {
              paused = true; stopReason = 'paused';
              break;
            }
            ok = false;
            failNote = '请求错误：' + String(e.message || '').slice(0, 60);
            console.log(`[解题] 批次 ${batchIdx} 异常: ${e.message}`);
          }
          if (!ok) failed.push(batch);
          done++;
          if (failNote) lastFailNote = failNote;
          emit(done, batches.length, failNote ? `该批未解出 · 返回: ${failNote}` : (round > 1 ? `第 ${round} 轮` : ''));
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
      // 暂停时不再重排 pool，直接跳出
      if (paused) break;
      pool = failed.flat().filter(q => !q.answer);
    }

    return { solved, usage: { ...usage }, cost: +costOf(usage, cfg).toFixed(4), paused, stopReason, lastFailNote };
  }

  /* ---- 测试连接 ---- */
  async function testConnection() {
    const raw = await chat([{ role: 'user', content: '请直接回复：OK' }], { raw: true });
    return raw.trim();
  }

  return { getConfig, saveConfig, costOf, parseDocument, parseAnswerMap, matchAnswers, parseAnswerDocument, matchAnswersStructured, aiMatchAnswers, answerLineRatio, fileToCanon, fileToCanonLite, visionCanon, solveMissing, getLastUsage, testConnection, chat };
})();
