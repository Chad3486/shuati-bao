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

    // 3) 答案表本地匹配：给解析出来但没带答案的题填答案
    if (answerTable && answerTable.trim()) {
      const { map, mode } = parseAnswerMap(answerTable);
      if (mode !== 'none') matchAnswers(questions.filter(q => !q.answer), map, mode);
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
          let parseFailPreview = '';
          try {
            const raw = await chat([
              { role: 'system', content: SOLVE_PROMPT },
              { role: 'user', content: JSON.stringify(body) }
            ], { onRetry });
            const obj = parseJSON(raw);
            const arr = obj?.answers || obj;
            let solvedHere = 0;
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
                solvedHere++;
              }
            }
            // LLM 静默失败修复：返回非 JSON 或一题都没解出，标失败进入重试队列
            // （原 v1.0.0 只在 catch 才 ok=false，导致 parseJSON 返回 null 时
            //   静默成功，failed 永远不进队列 → 表现为"什么都不出")
            if (!Array.isArray(arr) || solvedHere === 0) {
              ok = false;
              parseFailPreview = (raw || '(空)').replace(/\s+/g, ' ').slice(0, 80);
            }
          } catch (e) {
            ok = false;
            parseFailPreview = '请求错误：' + (e.message || '').slice(0, 60);
          }
          // 增量落盘：本批有结果的立即保存，断网/退出不丢
          if (onBatchSave && batch.some(q => q.answer)) {
            try { await onBatchSave(batch); } catch (e) { /* 保存失败不中断 */ }
          }
          if (!ok) failed.push(batch);
          done++;
          // 失败时把 GLM 实际返回的前 80 字反馈到 UI，方便诊断
          const note = parseFailPreview
            ? `解析失败 · GLM 返回: ${parseFailPreview}`
            : (round > 1 ? `第 ${round} 轮` : '');
          if (onProgress) onProgress(done, batches.length, solved, note);
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
