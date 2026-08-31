/* ========== LLM 解析引擎（OpenAI 兼容接口） ========== */
const LLM = (() => {

  const DEFAULT_CONFIG = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.1,
    concurrency: 4
  };

  async function getConfig() {
    const saved = await DB.metaGet('llmConfig');
    return Object.assign({}, DEFAULT_CONFIG, saved || {});
  }
  async function saveConfig(cfg) {
    await DB.metaSet('llmConfig', cfg);
  }

  /* ---- 单次 chat 调用 ---- */
  async function chat(messages, { onRetry, raw = false } = {}) {
    const cfg = await getConfig();
    if (!cfg.apiKey) throw new Error('请先在「设置」中配置 API Key');

    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const payload = { model: cfg.model, messages, temperature: cfg.temperature, max_tokens: 8192 };
    if (!raw) {
      // 要求 JSON 输出（兼容不同实现；DeepSeek 要求提示词含 'json' 才能启用）
      payload.response_format = { type: 'json_object' };
    }
    const body = JSON.stringify(payload);

    const maxRetry = 4;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        // 全局限流阀：上一请求撞 429 时，先等冷却结束再发
        const wait = _throttleUntil - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        // 请求级超时：手机网络弱时 fetch 可能挂起几分钟，90s 强制断开重试
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort('timeout'), 90000);
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cfg.apiKey
          },
          body,
          signal: ctl.signal
        });
        clearTimeout(timer);
        if (!resp.ok) {
          if (resp.status === 429) {
            // 撞限流：读 Retry-After（秒），无头默认 15s；整段冷却时间翻倍逐次递增
            const ra = parseInt(resp.headers.get('retry-after'), 10);
            const cool = (ra > 0 ? ra * 1000 : 15000) * (attempt + 1);
            _throttleUntil = Date.now() + cool;
            if (onRetry) onRetry(attempt + 1, Math.round(cool / 1000));
            lastErr = new Error('API 429 限流');
            continue;
          }
          const errText = await resp.text().catch(() => '');
          throw new Error(`API ${resp.status}: ${errText.slice(0, 300)}`);
        }
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('API 返回为空');
        return content;
      } catch (e) {
        lastErr = e;
        // 网络错误 / 超时 / 5xx → 重试；400/401/403/404 配置错误直接抛
        if (/API (400|401|403|404)/.test(e.message)) throw e;
        if (attempt < maxRetry) {
          if (onRetry) onRetry(attempt + 1, 0);
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

  /* ---- 解析提示词（两步走 · 第一步：只提取题目，不解答） ---- */
  const SYSTEM_PROMPT = `你是专业的题目结构化引擎。从用户给的资料文本中【只提取】题目结构，【不要自己解答】。

【提取规则】
1. 题型 type：single=单选题、multi=多选题、judge=判断题、fill=填空题
2. no 是题目的原始题号（整数），原文没有题号时省略该字段
3. 判断题转换为 single，options 固定为 {"A":"正确","B":"错误"}
4. options 是对象 {"A":"...","B":"...","C":"...","D":"..."}，键为字母
5. answer 只在原文明确给出时填写（题后标注、括号内、或随附答案表）；原文没有答案时【必须省略 answer 字段，严禁自己解答或猜测】
6. 填空题 answer 为原文标注的标准答案文本，多空用 ||| 分隔；原文没有则省略
7. explanation 提取原文解析文字，没有则省略
8. stem 要完整（含材料、图表描述文字如有）
9. 残缺题（缺题干/缺选项）直接丢弃
10. 多选题如果无法确认，默认 single
11. 逐行扫描，不要遗漏任何一道题；也不要把同一道题输出两次

【输出格式】严格输出json（不要markdown代码块、不要任何解释文字）：
{"questions":[{"no":1,"type":"single","stem":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"answer":"C","explanation":"可选"}]}
没有答案时：{"no":1,"type":"single","stem":"...","options":{...}}
本块没有题目时输出 {"questions":[]}`;

  const ANSWER_TABLE_PROMPT = `\n\n【随附答案表】以下是本文件的答案汇总（题号→答案）。仅当题号能对应上时才把 answer 填入对应题目；对应不上的题目保持省略 answer：`;

  /* ---- 单块解析 ---- */
  async function parseChunk(chunkText, answerTable, onRetry) {
    let user = '资料文本：\n' + chunkText;
    const trimmed = sliceAnswerTable(answerTable, chunkText);
    if (trimmed && trimmed.trim()) {
      user += ANSWER_TABLE_PROMPT + '\n' + trimmed;
    }
    const raw = await chat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user }
    ], { onRetry });
    const obj = parseJSON(raw);
    if (!obj) throw new Error('LLM 返回无法解析为 JSON');
    const qs = obj.questions || obj;
    if (!Array.isArray(qs)) throw new Error('LLM 返回格式异常');
    return normalize(qs);
  }

  /* ---- 答案表按块内题号裁剪：只发本块相关的行，大幅省 token ---- */
  function sliceAnswerTable(table, chunkText) {
    if (!table || !table.trim()) return table;
    // 提取本块出现的题号（行首 "12." "12、" "12）"）
    const nums = new Set();
    const re = /(?:^|\n)\s*(\d{1,3})\s*[.、．)）]/g;
    let m;
    while ((m = re.exec(chunkText)) !== null) nums.add(+m[1]);
    if (!nums.size) return table;
    // 一行行过滤：行内出现的题号若与块内题号有交集则保留；标题/说明行保留
    const kept = [];
    for (const line of table.split('\n')) {
      if (!line.trim()) continue;
      if (/参考答案|答案速查|答案表|答案汇总/.test(line)) { kept.push(line); continue; }
      const lineNums = [];
      const pr = /(\d{1,3})\s*[.、．:：)]?\s*[A-D]/g;
      let pm;
      while ((pm = pr.exec(line)) !== null) lineNums.push(+pm[1]);
      if (!lineNums.length) { kept.push(line); continue; }
      if (lineNums.some(n => nums.has(n))) kept.push(line);
    }
    return kept.join('\n');
  }

  /* ---- 标准化/校验（答案可空：noAnswer 标记，等待第二步补答案） ---- */
  function normalize(qs) {
    const valid = [];
    for (const q of qs) {
      if (!q || typeof q !== 'object') continue;
      const stem = String(q.stem || '').trim();
      if (!stem) continue;
      const answer = String(q.answer ?? '').trim();
      const no = parseInt(q.no, 10) || null;

      let type = String(q.type || 'single').toLowerCase();
      if (!['single', 'multi', 'judge', 'fill'].includes(type)) type = 'single';

      if (type === 'fill') {
        valid.push({ no, type, stem, options: null, answer: answer || null, explanation: String(q.explanation || '').trim() || null });
        continue;
      }

      // 选项处理
      let options = q.options;
      if (options && !Array.isArray(options) && typeof options === 'object') {
        const keys = Object.keys(options).sort();
        if (keys.length >= 2) {
          const opt = {};
          for (const k of keys) opt[k.toUpperCase()] = String(options[k]).trim();
          let ans = answer.toUpperCase().replace(/[^A-Z]/g, '');
          if (type === 'single' && ans.length > 1) type = 'multi';
          if (type === 'multi' && ans.length === 1) type = 'single';
          // 校验答案字母必须在选项键内，防止幻觉答案
          if (ans && [...ans].some(c => !opt[c])) ans = '';
          valid.push({ no, type, stem, options: opt, answer: ans || null, explanation: String(q.explanation || '').trim() || null });
        }
      } else if (Array.isArray(options) && options.length >= 2) {
        // 数组形式选项转对象
        const letters = 'ABCDEFGH';
        const opt = {};
        options.forEach((v, i) => opt[letters[i]] = String(v).trim());
        let ans = answer.toUpperCase().replace(/[^A-Z]/g, '');
        if (ans && [...ans].some(c => !opt[c])) ans = '';
        valid.push({ no, type, stem, options: opt, answer: ans || null, explanation: String(q.explanation || '').trim() || null });
      } else if (type === 'judge') {
        // 无选项判断题兜底
        if (answer) {
          const a = answer.replace(/[^A-Za-z对错正误]/g, '');
          const isA = /a|对|正/i.test(a);
          valid.push({ no, type: 'single', stem, options: { 'A': '正确', 'B': '错误' }, answer: isA ? 'A' : 'B', explanation: String(q.explanation || '').trim() || null });
        } else {
          valid.push({ no, type: 'single', stem, options: { 'A': '正确', 'B': '错误' }, answer: null, explanation: null });
        }
      }
    }
    return valid;
  }

  /* ---- 从全文提取文末答案表（启发式） ---- */
  function findAnswerTable(text) {
    const lines = text.split('\n');
    const tableLines = [];
    let inTable = false;
    // 匹配 "1.C 2.A" / "1、C" / "答案：1.C" 等密集答案行
    const pair = /(\d{1,3})\s*[.、．:：)]?\s*([A-D])\b/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/参考答案|答案速查|答案表|答案汇总/.test(line)) { inTable = true; tableLines.push(line); continue; }
      let count = 0; let m;
      pair.lastIndex = 0;
      while ((m = pair.exec(line)) !== null) count++;
      if (count >= 3) { inTable = true; tableLines.push(line); }
      else if (inTable && line.trim() === '') { /* 表中空行跳过 */ }
      else if (inTable && count === 0 && tableLines.length > 0 && !/^答案/.test(line)) {
        // 表结束条件：连续非答案行
        if (!lines[i + 1] || !/(参考答案|答案)/.test(lines[i + 1])) inTable = false;
      }
    }
    return tableLines.join('\n');
  }

  /* ---- 整体解析 · 本地优先：正则解析全部题目，仅疑难题送 AI ----
     opts.mode: 'smart'（默认，快）| 'ai'（纯AI录入：AI 全文扫描 + 本地切割双路合并，最全但慢） ---- */
  async function parseDocument(fullText, onProgress, onRetry, opts = {}) {
    const text = Extractor.cleanText(fullText);
    const answerTable = findAnswerTable(text);

    // 1) 确定性切题
    const split = Extractor.splitQuestions(text);

    // ===== 纯 AI 模式：AI 全文扫描 + 本地解析 双路合并 =====
    if (opts.mode === 'ai') {
      // 本地一路（瞬间完成，免费）——透传节题型/节键
      const localQs = [];
      for (const it of split.items) {
        const q = Extractor.parseOneQuestion(it.no, it.text, it.type, it.key);
        if (q) localQs.push(q);
      }
      if (answerTable && answerTable.trim()) {
        const { map, mode } = parseAnswerMap(answerTable);
        if (mode !== 'none') matchAnswers(localQs.filter(q => !q.answer), map, mode);
      }

      // AI 一路：LLM 分块全文扫描（题目数多、慢）——persist 支持断点续扫
      const legacy = await parseDocumentLegacy(text, answerTable, onProgress, onRetry, opts.persist);
      let aiQs = legacy.questions || [];
      // 续扫：把上次已扫块落的题并入（它们不在本轮 all 里）
      if (opts.persist && opts.persist.loadHistory) {
        try {
          const hist = await opts.persist.loadHistory();
          if (Array.isArray(hist) && hist.length) aiQs = [...hist, ...aiQs];
        } catch (e) { /* 忽略 */ }
      }

      // 合并：key 对齐（同 key 取"有答案"者优先，答案互补）→ 无 key 按题干去重
      const byKey = new Map();
      const byStem = new Map();
      const put = q => {
        if (q.key != null) {
          const old = byKey.get(q.key);
          if (!old) { byKey.set(q.key, q); }
          else {
            if (!old.answer && q.answer) { q.explanation = q.explanation || old.explanation; byKey.set(q.key, q); }
            else if (!old.explanation && q.explanation) old.explanation = q.explanation;
          }
        } else {
          const skey = 'S' + String(q.stem || '').replace(/\s+/g, '').slice(0, 60);
          if (!byStem.has(skey)) byStem.set(skey, q);
        }
      };
      aiQs.forEach(put);
      localQs.forEach(put); // 本地后放：题干信息更可靠，同 key 时本地覆盖（若本地有答案）

      let questions = [...byKey.values(), ...byStem.values()].filter(q => q.stem);
      questions.sort((a, b) => (a.no ?? 9999) - (b.no ?? 9999));
      for (const q of questions) delete q._local;

      const answered = questions.filter(q => q.answer).length;
      return {
        questions, answered, noAnswer: questions.length - answered,
        mode: 'ai',
        splitTotal: split.total, aiCount: aiQs.length, localCount: localQs.length,
        degraded: questions.filter(q => q._degraded).length,
        missingNos: split.missingNos, dupNos: split.dupNos, problems: split.problems,
        sections: split.sections,
        dropped: Math.max(0, split.total - questions.filter(q => q.no != null).length)
      };
    }

    if (split.total >= 5) {
      // 2) 本地正则解析（毫秒级、零费用）——透传节题型/节键
      const local = [];
      const needAI = [];
      for (const it of split.items) {
        const q = Extractor.parseOneQuestion(it.no, it.text, it.type, it.key);
        if (q) local.push(q);
        else needAI.push(it);
      }

      // 3) 答案表本地匹配：给本地解析成功但无答案的题填答案
      let tableFilled = 0;
      if (answerTable && answerTable.trim()) {
        const { map, mode } = parseAnswerMap(answerTable);
        if (mode !== 'none') {
          // 只对"整个文件答案都缺"的情况做序列匹配（题号模式按题号）
          const localNoAns = local.filter(q => !q.answer);
          tableFilled = matchAnswers(localNoAns, map, mode);
        }
      }

      // 4) AI 兜底：仅解析失败的题
      const cfg = await getConfig();
      const concurrency = Math.max(1, Math.min(8, parseInt(cfg.concurrency, 10) || 4));
      const aiQuestions = [];
      let aiDone = 0;

      if (needAI.length) {
        if (!cfg.apiKey) {
          // 没配 Key：跳过 AI 兜底，只返回本地结果（带提示）
          if (onProgress) onProgress(1, 1, local.length);
        } else {
          const BATCH = 6;
          const batches = [];
          for (let i = 0; i < needAI.length; i += BATCH) batches.push(needAI.slice(i, i + BATCH));

          const STRUCT_PROMPT = `你是题目结构化转换器。输入是已按题号切割好的题目原文数组（本地正则无法解析的疑难格式），每项含 idx、no、sec（小节题型提示，可能为 null）、raw。把每道 raw 转成结构化 JSON。

【规则】
1. 每项必须输出，idx/no 原样返回
2. type：single/multi/judge/fill；sec 非空时 type 必须与 sec 一致（如 sec="judge" 则输出判断题，options 固定 {"A":"正确","B":"错误"}）；sec 为 null 时自行判断
3. PDF转制的 raw 中选项可能乱序（如 D 出现在 A 前），请按选项字母标记识别并在 options 中按字母正确归位
4. 若选项确实缺失，不要编造选项；无法解析输出 {"idx":..,"skip":true}
5. options {"A":"..."}；填空题省略
6. answer 仅原文明确给出时填；严禁自己解答

【输出】严格 json：{"questions":[{"idx":0,"no":1,"type":"single","stem":"...","options":{...},"answer":"C"}]}`;

          let idx = 0;
          let lastError = null;
          async function worker() {
            while (idx < batches.length) {
              const my = idx++;
              const batch = batches[my];
              const body = batch.map((q, i) => ({ idx: i, no: q.no, sec: q.type || null, raw: q.text }));
              for (let round = 0; round < 2; round++) {
                try {
                  let user = '题目数组：\n' + JSON.stringify(body, null, 1);
                  const trimmed = sliceAnswerTable(answerTable, body.map(b => b.no + '. x').join('\n'));
                  if (trimmed && trimmed.trim()) user += ANSWER_TABLE_PROMPT + '\n' + trimmed;
                  const raw = await chat([
                    { role: 'system', content: STRUCT_PROMPT },
                    { role: 'user', content: user }
                  ], { onRetry: (a, c) => onRetry && onRetry(my, a, c) });
                  const obj = parseJSON(raw);
                  const arr = obj?.questions || obj;
                  if (Array.isArray(arr)) {
                    for (const item of arr) {
                      if (item.skip) continue;
                      const src = batch[item.idx] || batch.find(b => b.no === item.no);
                      if (!src) continue;
                      // sec 提示优先（本地切割的节题型更可靠）
                      const hint = src.type && item.type !== src.type ? src.type : item.type;
                      const qs = normalize([{ ...item, no: src.no, key: src.key, type: hint }]);
                      if (qs.length) aiQuestions.push(qs[0]);
                    }
                  }
                  break;
                } catch (e) {
                  lastError = e;
                  if (round === 0) await new Promise(r => setTimeout(r, 8000));
                }
              }
              aiDone++;
              if (onProgress) onProgress(aiDone, batches.length, local.length + aiQuestions.length);
            }
          }
          await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
          if (!local.length && !aiQuestions.length && lastError) throw lastError;
        }
      } else {
        if (onProgress) onProgress(1, 1, local.length);
      }

      // 5) 合并 + 排序（清 _local；去重键=节-题号，修复各节同号覆盖）
      const all = [...local, ...aiQuestions];
      for (const q of all) delete q._local;
      const byKey = new Map();
      for (const q of all) if (!byKey.has(q.key ?? 'N' + q.no)) byKey.set(q.key ?? 'N' + q.no, q);
      const questions = split.items.map(it => byKey.get(it.key)).filter(Boolean)
        .sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '', 'zh', { numeric: true }));

      const answered = questions.filter(q => q.answer).length;
      return {
        questions, answered, noAnswer: questions.length - answered,
        splitTotal: split.total, localCount: local.length, aiCount: aiQuestions.length,
        degraded: all.filter(q => q._degraded).length,
        missingNos: split.missingNos, dupNos: split.dupNos, problems: split.problems,
        sections: split.sections,
        dropped: split.total - questions.length,
        mode: 'split'
      };
    }

    // fallback：题号不规整的文件（<5 题），走旧分块扫描
    return await parseDocumentLegacy(text, answerTable, onProgress, onRetry);
  }

  /* ---- 旧模式：LLM 扫描分块（题号不规整时的兜底；persist 支持断点续扫） ---- */
  async function parseDocumentLegacy(text, answerTable, onProgress, onRetry, persist) {
    const chunks = Extractor.chunk(text);
    const all = [];
    let done = 0;
    let failed = 0;
    let lastError = null;

    const cfg = await getConfig();
    const concurrency = Math.max(1, Math.min(8, parseInt(cfg.concurrency, 10) || 4));
    // 断点续扫：跳过已完成块（persist.doneSet），每块完成回调 persist.save 落库
    let startIdx = 0;
    if (persist && persist.doneSet) {
      while (startIdx < chunks.length && persist.doneSet.has(startIdx)) startIdx++;
    }
    let idx = startIdx;
    async function worker() {
      while (idx < chunks.length) {
        const my = idx++;
        for (let round = 0; round < 2; round++) {
          try {
            const qs = await parseChunk(chunks[my], answerTable, (attempt, coolSec) => {
              if (onRetry) onRetry(my, attempt, coolSec);
            });
            all.push(...qs);
            if (persist && persist.save) {
              try { await persist.save(my, qs); } catch (e) { /* 保存失败不中断扫描 */ }
            }
            break;
          } catch (e) {
            if (round === 0) {
              await new Promise(r => setTimeout(r, 8000));
              continue;
            }
            failed++;
            lastError = e;
          }
        }
        done++;
        if (onProgress) onProgress(done + startIdx, chunks.length, all.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, chunks.length - startIdx)) }, worker));

    if (!all.length && lastError) throw lastError;

    const seen = new Set();
    const unique = all.filter(q => {
      const key = q.no != null ? 'N' + q.no : 'S' + q.stem.replace(/\s+/g, '').slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const answered = unique.filter(q => q.answer).length;
    return { questions: unique, answered, noAnswer: unique.length - answered, failedChunks: failed, totalChunks: chunks.length, mode: 'legacy' };
  }

  /* ================= 第二步 · 答案补全 ================= */

  /* ---- 把答案文件文本解析成 { 题号: 答案 } 映射 ----
     支持："1.C 2.A 3.B" / "1、C" / "题号:1 答案:C" / "A B C D"（纯序列按顺序） ---- */
  function parseAnswerMap(text) {
    const map = new Map();
    // 形式1：带题号（\b 对中文无效，用 (?![A-Za-z]) 断言）
    const re = /(\d{1,3})\s*[.、．:：)）=\-]?\s*([A-D]{1,4}|对|错|正确|错误)(?![A-Za-z])/g;
    let m, count = 0;
    while ((m = re.exec(text)) !== null) {
      let ans = m[2];
      if (/^(对|正确)$/i.test(ans)) ans = 'A';
      else if (/^(错|错误)$/i.test(ans)) ans = 'B';
      map.set(+m[1], ans.toUpperCase());
      count++;
    }
    if (count >= 3) return { map, mode: 'numbered' };
    // 形式2：纯答案序列（无题号，按顺序）
    const seq = [];
    const re2 = /(?<![A-Za-z])([A-D])(?![A-Za-z])/g;
    while ((m = re2.exec(text)) !== null) seq.push(m[1]);
    if (seq.length >= 3) {
      seq.forEach((a, i) => map.set(i + 1, a));
      return { map, mode: 'sequence' };
    }
    return { map, mode: 'none' };
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

  /* ---- AI 批量解答（第二步 · 明确告知用户答案来自 AI）
     断点续传设计：每批答完立即回调 onBatchSave 落库；失败批次自动重试（最多 3 轮）；
     中途退出再进来，已答的题自动跳过，从剩余继续 ---- */
  async function solveQuestions(questions, onProgress, onRetry, onBatchSave) {
    const BATCH = 10;
    const MAX_ROUNDS = 3;
    const cfg = await getConfig();
    const concurrency = Math.max(1, Math.min(4, parseInt(cfg.concurrency, 10) || 4));

    const SOLVE_PROMPT = `你是答题专家。解答下列题目，严格按json输出（不要markdown、不要解释文字）：
{"answers":[{"idx":0,"answer":"C","explanation":"简短解析"}]}
- idx 是输入里每题的序号（从0开始）
- 选择题 answer 为字母串如 "C" / "ACD"（必须是给定选项中的字母）
- 填空题 answer 为答案文本，多空用 ||| 分隔
- explanation 一句话即可`;

    let solved = 0;
    let pool = questions.filter(q => !q.answer); // 已答的（上次中断续跑）直接跳过
    let round = 0;
    while (pool.length && round < MAX_ROUNDS) {
      round++;
      if (round > 1) {
        if (onProgress) onProgress(0, 1, solved, `网络波动，第 ${round} 轮重试（10s 后）`);
        await new Promise(r => setTimeout(r, 10000));
        pool = pool.filter(q => !q.answer);
        if (!pool.length) break;
      }
      const batches = [];
      for (let i = 0; i < pool.length; i += BATCH) batches.push(pool.slice(i, i + BATCH));
      const failed = [];
      let done = 0;
      let idx = 0;
      async function worker() {
        while (idx < batches.length) {
          const my = idx++;
          const batch = batches[my];
          const body = batch.map((q, i) => ({
            idx: i, type: q.type, stem: q.stem,
            options: q.options || undefined
          }));
          let ok = true;
          try {
            const raw = await chat([
              { role: 'system', content: SOLVE_PROMPT },
              { role: 'user', content: JSON.stringify(body) }
            ], { onRetry });
            const obj = parseJSON(raw);
            const arr = obj?.answers || obj;
            if (Array.isArray(arr)) {
              for (const a of arr) {
                const q = batch[a.idx];
                if (!q || q.answer) continue;
                let ans = String(a.answer ?? '').trim();
                if (!ans) continue;
                if (q.options) {
                  ans = ans.toUpperCase().replace(/[^A-Z]/g, '');
                  if (!ans || [...ans].some(c => !q.options[c])) continue;
                }
                q.answer = ans;
                if (a.explanation) q.explanation = String(a.explanation).trim();
                solved++;
              }
            }
          } catch (e) { ok = false; }
          // 增量落盘：本批有结果的立即保存，断网/退出不丢
          if (onBatchSave && batch.some(q => q.answer)) {
            try { await onBatchSave(batch); } catch (e) { /* 保存失败不中断 */ }
          }
          if (!ok) failed.push(batch);
          done++;
          if (onProgress) onProgress(done, batches.length, solved, round > 1 ? `第 ${round} 轮` : '');
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
      pool = failed.flat().filter(q => !q.answer);
    }
    return solved;
  }

  /* ---- AI 校验：重做一遍已答题目，比对答案 + 给解析 ----
     返回 { checked, agree, conflicts:[{no, stem, orig, ai}], explained }
     不修改 q.answer（原答案保留），只写 q.aiAnswer / 补 q.explanation ---- */
  async function verifyQuestions(questions, onProgress, onRetry, onBatchSave) {
    const BATCH = 10;
    const cfg = await getConfig();
    const concurrency = Math.max(1, Math.min(4, parseInt(cfg.concurrency, 10) || 4));
    // 断点续跑：跳过已校验过的题（上次中断的部分不再重做）
    const batches = [];
    const todo = questions.filter(q => !q.aiAnswer);
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

    const VERIFY_PROMPT = `你是答题专家。独立解答下列题目（不要猜原答案，凭知识自己做），严格按json输出：
{"answers":[{"idx":0,"answer":"C","explanation":"解题过程，2-3句"}]}
- idx 是输入每题的序号（从0开始）
- 选择题 answer 为字母串如 "C"/"ACD"（必须是给定选项字母）
- 填空题 answer 为答案文本，多空用 ||| 分隔
- explanation 写清推理依据，2-3 句`;

    let done = 0, checked = 0, agree = 0, explained = 0;
    const conflicts = [];
    let idx = 0;
    async function worker() {
      while (idx < batches.length) {
        const my = idx++;
        const batch = batches[my];
        const body = batch.map((q, i) => ({
          idx: i, type: q.type, stem: q.stem,
          options: q.options || undefined
        }));
        try {
          const raw = await chat([
            { role: 'system', content: VERIFY_PROMPT },
            { role: 'user', content: JSON.stringify(body) }
          ], { onRetry });
          const obj = parseJSON(raw);
          const arr = obj?.answers || obj;
          if (Array.isArray(arr)) {
            for (const a of arr) {
              const q = batch[a.idx];
              if (!q) continue;
              let ai = String(a.answer ?? '').trim();
              if (!ai) continue;
              if (q.options) {
                ai = ai.toUpperCase().replace(/[^A-Z]/g, '');
                if (!ai || [...ai].some(c => !q.options[c])) continue;
              } else {
                // 填空：宽松归一后再比对
              }
              q.aiAnswer = ai;
              // 比对
              let same;
              if (q.type === 'fill') {
                same = QuizSession.normalizeFill(ai) === QuizSession.normalizeFill(q.answer);
              } else {
                const nrm = s => String(s).toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
                same = nrm(ai) === nrm(q.answer);
              }
              checked++;
              if (same) agree++;
              else conflicts.push({ no: q.no, stem: q.stem.slice(0, 40), orig: q.answer, ai });
              // 补解析（原本没有的）
              if (!q.explanation && a.explanation) {
                q.explanation = String(a.explanation).trim();
                explained++;
              }
            }
          }
        } catch (e) { /* 单批失败跳过，已答的已即时落盘 */ }
        // 增量落盘：本批有结果的立即保存，断网/退出不丢
        if (onBatchSave && batch.some(q => q.aiAnswer)) {
          try { await onBatchSave(batch); } catch (e) { /* 保存失败不中断 */ }
        }
        done++;
        if (onProgress) onProgress(done, batches.length, checked);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    return { checked, agree, conflicts, explained };
  }

  /* ---- 测试连接 ---- */
  async function testConnection() {
    const raw = await chat([{ role: 'user', content: '请直接回复：OK' }], { raw: true });
    return raw.trim();
  }

  return { getConfig, saveConfig, parseDocument, parseAnswerMap, matchAnswers, solveQuestions, verifyQuestions, testConnection, chat };
})();
