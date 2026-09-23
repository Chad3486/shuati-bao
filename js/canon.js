/* ========== 范式（标准导入格式）· 一题一块、答案随题，导入零对齐 ==========
   解决的问题：配套答案文件靠「章/节/题号」对齐，格式一乱就有题扫不上；
   1000 题再用 AI 对位又太慢。范式把答案直接写进题目块里（答案：X），
   导入时不需要任何匹配/对齐，一次线性扫描搞定，零 API 调用。

   API：
   - SPEC            格式说明文本（App 内展示 / 复制）
   - template()      可直接照抄的模板示例
   - parse(text)     严格解析范式文本 → { questions, errors, warns, sections, stats }
   - fromQuestions() 题库 → 范式文本（导出到 Word 改完再导回）
   - convert(text)   任意文档（旧格式/Word 粘贴）→ 范式文本（本地规则，含缺答案提示）
   - TYPE_ALIAS/TYPE_LABEL  题型别名与显示名
===================================================================== */
const Canon = (() => {

  /* ---- 题型标记别名 → 内部题型（App 内部只有 single/multi/judge/fill） ---- */
  const TYPE_ALIAS = {
    '单选': 'single', '单选题': 'single', '单项选择题': 'single', '选择': 'single', '选择题': 'single',
    '多选': 'multi', '多选题': 'multi', '多项选择': 'multi', '多项选择题': 'multi',
    '判断': 'judge', '判断题': 'judge',
    '填空': 'fill', '填空题': 'fill',
    '简答': 'fill', '简答题': 'fill', '问答': 'fill', '问答题': 'fill',
    '名词解释': 'fill', '计算': 'fill', '计算题': 'fill', '论述': 'fill', '论述题': 'fill'
  };
  const TYPE_LABEL = { single: '单选', multi: '多选', judge: '判断', fill: '填空' };

  const FULL_LETTER = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'Ｅ': 'E', 'Ｆ': 'F', 'Ｇ': 'G', 'Ｈ': 'H' };
  const BLANK_RE = /（\s*）|\(\s*\)|（[\s\u3000]+）|＿{2,}|_{2,}/;
  const JUDGE_YES = /^(对|正确|是|√|✓|T|TRUE|Y|YES)$/i;
  const JUDGE_NO = /^(错|错误|否|×|✗|X|F|FALSE|N|NO)$/i;

  /* ---- 格式说明（App 内「格式说明」按钮展示） ---- */
  const SPEC = `范式（标准导入格式）· 一题一块，答案跟着题目走，导入零对齐

一、每题三要素（关键：答案行）
1. 题号行：1. 题干…        ← 题号可省略，省略时自动按顺序编号
2. 选项行：A. 内容  B. 内容  ← 选择题才需要，每行一个，从 A 开始连续
3. 答案行：答案：B          ← 有这一行，导入时就不需要任何"答案对齐"

二、完整写法（推荐，照抄即可）
# 第1章 电力电子器件
## 1.1 电力二极管
【单选】1. 电力二极管属于（ ）器件。
A. 不可控器件
B. 半控器件
C. 全控器件
答案：B
解析：电力二极管只有通、断两种状态，属于不可控器件。

三、题型标记（可省略，省略时自动判定）
【单选】【多选】【判断】【填空】
【简答】【问答】【名词解释】【计算】按填空题处理（答案写文字，多空用 ||| 分隔）
也可把题型写在节标题里，如「## 判断题」，该节题目默认按判断题处理。

四、答案怎么写
单选：答案：B
多选：答案：ABC        （字母连着写，不分顺序）
判断：答案：对 / 答案：错   （也接受 √ × T F 正确 错误）
填空：答案：阳极|||阴极|||门极   （多个空用三个竖线 ||| 分隔）

五、注意
· 一题从「题号行」开始，到下一个「题号行」结束；题干换行会自动并入题干
· 选项必须从 A 开始连续（A、B、C、D…），中间缺字母会报错提示
· 解析写一行；紧跟在答案后的普通文字行会自动并入解析
· Word 自动编号可以关掉：题号省略后程序按出现顺序自动编号
· 题型标记省略时的判定：有选项 + 多个答案字母 = 多选；选项正好是「正确/错误」= 判断；无选项 = 填空
· 支持 .txt / .md / .docx（Word 里写好存为 .docx 直接导入）
· 老格式文档不用重写：用「Word 转换器」一键转成范式，再检查缺答案处即可`;

  /* ---- 模板示例（复制/下载用） ---- */
  function template() {
    return `# 第1章 电力电子器件
## 1.1 电力二极管

【单选】1. 电力二极管属于（ ）器件。
A. 不可控器件
B. 半控器件
C. 全控器件
答案：B
解析：电力二极管只有通、断两种状态，属于不可控器件。

【多选】2. 下列属于全控型器件的有（ ）。
A. 晶闸管
B. 门极可关断晶闸管
C. 电力MOSFET
答案：BC
解析：晶闸管只能由门极开通、不能由门极关断，属半控型。

【判断】3. 晶闸管属于全控型器件。
答案：错

【填空】4. 晶闸管的三个电极是＿＿、＿＿、＿＿。
答案：阳极|||阴极|||门极

（以下为最简写法：无题型标记、无题号，程序自动判定与编号）

下列属于不可控器件的是（ ）。
A. 电力二极管
B. 晶闸管
C. IGBT
答案：A
`;
  }

  /* ================= 解析 ================= */

  function normLine(s) {
    return String(s == null ? '' : s)
      .replace(/^\uFEFF/, '')
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/[\u200b-\u200f\u2028\u2029]/g, '')
      .replace(/\t/g, ' ')
      .replace(/\s+$/, '');
  }

  /* 从答案文本里取选项字母（全角兼容、去重、排序） */
  function lettersOf(s) {
    const raw = String(s == null ? '' : s);
    let out = '';
    for (const ch of raw) {
      const c = FULL_LETTER[ch] || ch.toUpperCase();
      if (c >= 'A' && c <= 'H') out += c;
    }
    return [...new Set(out.split(''))].sort().join('') || null;
  }

  /* 节标题 → 默认题型（「## 判断题」这类写法） */
  function detectSecType(title) {
    const t = String(title || '').replace(/\s/g, '');
    if (!t) return null;
    if (/判断/.test(t)) return 'judge';
    if (/多选|多项/.test(t)) return 'multi';
    if (/单选|单项|选择/.test(t)) return 'single';
    if (/填空|简答|问答|名词解释|计算|论述/.test(t)) return 'fill';
    return null;
  }

  /* 无题号/无标记的「裸行」是否像一道题的题干（用于最简写法；不像的按标题/噪声忽略） */
  function looksLikeStem(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (BLANK_RE.test(t)) return true;              // 含（ ）/＿＿ 空位
    if (/[。？！?！…：:]$/.test(t)) return true;      // 句子结尾标点
    if (/^[（(]/.test(t)) return true;
    return t.replace(/\s/g, '').length >= 12;       // 够长的一整句
  }

  /* 主解析：范式文本 → 题目数组（带行号级错误/警告） */
  function parse(text, opts = {}) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const questions = [], errors = [], warns = [], sections = [];
    let secIdx = -1, secType = null;
    let cur = null, nextNo = 1, blankBefore = false;

    const err = (ln, msg) => { if (errors.length < 300) errors.push({ line: ln, msg }); };
    const warn = (ln, msg) => { if (warns.length < 300) warns.push({ line: ln, msg }); };

    function startQuestion(no, forcedType, ln) {
      const auto = no == null;
      const useNo = auto ? nextNo : no;
      nextNo = useNo + 1;
      cur = {
        no: useNo, _auto: auto, line: ln, type: forcedType || secType || null,
        stemLines: [], options: {}, optionOrder: [], answerRaw: null, expLines: []
      };
    }

    /* 题干入列：顺带抽取内联答案「…（答案：A）」 */
    function pushStemBody(t) {
      const s = String(t == null ? '' : t).trim();
      if (!s) return;
      const im = s.match(/[（(]\s*(?:参考答案|正确答案|答案)\s*[:：]\s*([^）)]{1,60}?)\s*[）)]\s*[。.；;，,]?\s*$/);
      if (im && cur && cur.answerRaw == null) {
        cur.answerRaw = im[1].trim();
        const cleaned = s.slice(0, im.index).trim();
        if (cleaned) cur.stemLines.push(cleaned);
        return;
      }
      cur.stemLines.push(s);
    }

    /* 收题：判定题型 / 归一答案 / 校验 → 入库 */
    function flush() {
      if (!cur) return;
      const q = cur; cur = null;

      const stem = q.stemLines.join('\n').replace(/\s+/g, ' ').trim();
      const optKeys = q.optionOrder;
      const optObj = optKeys.length ? Object.fromEntries(optKeys.map(l => [l, q.options[l]])) : null;

      // 1) 题型判定（无标记时推断）
      let type = q.type;
      if (!type) {
        if (optObj) {
          const vals = Object.values(optObj).map(v => v.replace(/\s/g, ''));
          if (optKeys.length === 2 && JUDGE_YES.test(vals[0]) && JUDGE_NO.test(vals[1])) type = 'judge';
          else if (lettersOf(q.answerRaw) && lettersOf(q.answerRaw).length > 1) type = 'multi';
          else type = 'single';
        } else if (q.answerRaw && (JUDGE_YES.test(q.answerRaw.trim()) || JUDGE_NO.test(q.answerRaw.trim()))) {
          type = 'judge';
        } else {
          type = 'fill';
        }
      }

      // 2) 题干 / 选项校验
      if (!stem) { err(q.line, `第 ${q.no} 题：没有题干，已跳过`); return; }
      if (!optObj && q.optionRejected) {
        err(q.line, `第 ${q.no} 题：有选项行但无法识别（选项必须从 A 开始连续写，如「A. 内容」），已跳过`);
        return;
      }
      if ((type === 'single' || type === 'multi') && !optObj) {
        err(q.line, `第 ${q.no} 题：${TYPE_LABEL[type]}题缺少选项行（选项写成「A. 内容」，每行一个），已跳过`);
        return;
      }
      if (optKeys.length) {
        for (let i = 0; i < optKeys.length; i++) {
          const want = String.fromCharCode(65 + i);
          if (optKeys[i] !== want) {
            warn(q.line, `第 ${q.no} 题：选项字母不连续（${optKeys.join('/')}），缺少 ${want}`);
            break;
          }
        }
        const empty = optKeys.filter(l => !String(q.options[l] || '').trim());
        if (empty.length) { err(q.line, `第 ${q.no} 题：选项 ${empty.join('/')} 没有内容，已跳过`); return; }
      }

      // 3) 答案归一
      let answer = null;
      if (type === 'judge') {
        const v = String(q.answerRaw || '').trim();
        if (v) {
          if (JUDGE_YES.test(v)) answer = 'A';
          else if (JUDGE_NO.test(v)) answer = 'B';
          else {
            const L = lettersOf(v);
            if (L && /^[AB]$/.test(L)) answer = L;
            else err(q.line, `第 ${q.no} 题：判断题答案「${v.slice(0, 12)}」无法识别（写 对 / 错），已按缺答案处理`);
          }
        }
      } else if (type === 'fill') {
        const v = String(q.answerRaw || '').replace(/[｜|]{2,}/g, '|||').trim();
        answer = v || null;
      } else {
        const letters = lettersOf(q.answerRaw);
        if (letters) {
          const bad = [...letters].filter(c => !optObj[c]);
          if (bad.length) {
            err(q.line, `第 ${q.no} 题：答案「${letters}」不在选项内（选项只有 ${optKeys.join('/')}），已忽略该答案`);
          } else {
            answer = letters;
            if (type === 'single' && letters.length > 1) type = 'multi'; // 答案多个字母 → 按多选
          }
        }
      }

      // 4) 填空题空数提示（题干空位 vs 答案分空）
      if (type === 'fill' && answer) {
        const blanks = (stem.match(/＿{2,}|_{2,}|（\s*）|\(\s*\)/g) || []).length;
        const parts = answer.split('|||').length;
        if (blanks && parts !== blanks) warn(q.line, `第 ${q.no} 题：题干有 ${blanks} 个空，答案分成 ${parts} 段（多空用 ||| 分隔）`);
      }

      questions.push({
        no: q.no,
        key: secIdx + '-' + q.no,
        secIdx,
        type,
        stem,
        options: type === 'judge' ? { A: '正确', B: '错误' } : (type === 'fill' ? null : optObj),
        answer,
        explanation: q.expLines.join('\n').replace(/\s+/g, ' ').trim() || null,
        _srcLine: q.line
      });
    }

    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1;
      let s = normLine(lines[i]);
      if (!s.trim()) { blankBefore = true; continue; }
      const prevBlank = blankBefore;
      blankBefore = false;

      // ① 结构行：# 章 / ## 节
      let m = s.match(/^\s*(#{1,6})\s*(.+?)\s*$/);
      if (m) {
        flush();
        const title = m[2].trim();
        secType = detectSecType(title);
        sections.push({ secIdx: ++secIdx, title, type: secType });
        nextNo = 1;
        continue;
      }

      // ② 题型标记【单选】…（不认识的标记剥掉后按普通行继续）
      let rest = s, forcedType = null;
      const tm = s.match(/^\s*[【\[]\s*([^】\]]{1,12}?)\s*[】\]]\s*([\s\S]*)$/);
      if (tm) {
        const key = tm[1].replace(/\s/g, '');
        if (TYPE_ALIAS[key]) { forcedType = TYPE_ALIAS[key]; rest = tm[2]; }
        else if (/^(参考答案|正确答案|答案)$/.test(key)) { if (cur) cur.answerRaw = tm[2].trim(); else warn(ln, '答案出现在题目之外，已忽略'); continue; }
        else if (/^(答案解析|解析|解释|说明)$/.test(key)) { if (cur) cur.expLines.push(tm[2].trim()); continue; }
        else { rest = tm[2]; warn(ln, `未识别的标记「【${key}】」，已忽略标记`); }
      }

      // ③ 题号行（「1. 题干」/「1、题干」/「第1题 题干」；「2.5kV」这类小数点不算题号）
      const qm = rest.match(/^\s*(?:第\s*)?(\d{1,4})\s*(?:题)?\s*[.、．)）](?!\d)\s*([\s\S]*)$/)
        || rest.match(/^\s*第\s*(\d{1,4})\s*题\s*[:：]?\s*([\s\S]*)$/);
      if (qm) {
        const no = +qm[1];
        const body = qm[2].trim();
        const isStart = forcedType != null || !cur || no === nextNo ||
          (cur.answerRaw != null) || cur.optionOrder.length >= 2 ||
          (cur.stemLines.length === 0) ||
          (cur._auto && !cur.optionOrder.length && cur.answerRaw == null && no === cur.no);
        if (isStart) {
          flush();
          startQuestion(no, forcedType, ln);
          if (body) pushStemBody(body);
          continue;
        }
        // 否则视为题干续行（如「2.5kV…」这类以数字开头的换行）
      } else if (forcedType != null) {
        // 只有题型标记、没有题号：新题（题号自动），rest 继续按普通行处理
        flush();
        startQuestion(null, forcedType, ln);
      }

      // ④ 选项行
      const om = rest.match(/^\s*([A-Ha-hＡ-Ｈ])\s*[.、．)）:：]\s*([\s\S]+)$/);
      if (om && cur) {
        const letter = FULL_LETTER[om[1]] || om[1].toUpperCase();
        const content = om[2].trim();
        // 题干里「A、B两系统互联…（ ）」式误判：内容含空括号且较长 → 当题干
        if (BLANK_RE.test(content) && content.replace(/\s/g, '').length > 10) {
          pushStemBody(rest);
          continue;
        }
        if (!cur.optionOrder.length && letter !== 'A') { cur.optionRejected = true; warn(ln, `选项必须从 A 开始，「${letter}.」已忽略`); continue; }
        if (cur.options[letter] != null) { cur.optionRejected = true; warn(ln, `选项 ${letter} 重复出现，已忽略后一个`); continue; }
        cur.optionOrder.push(letter);
        cur.options[letter] = content;
        continue;
      }

      // ⑤ 答案行
      const am = rest.match(/^\s*(?:参考答案|正确答案|答案|答)\s*[:：]\s*([\s\S]*)$/);
      if (am) {
        if (!cur) warn(ln, '答案出现在题目之外，已忽略');
        else if (cur.answerRaw != null) warn(ln, `第 ${cur.no} 题出现多个答案行，以第一个为准`);
        else cur.answerRaw = am[1].trim();
        continue;
      }

      // ⑥ 解析行
      const em = rest.match(/^\s*(?:答案解析|解析|解释|说明)\s*[:：]?\s*([\s\S]*)$/);
      if (em) {
        if (cur) cur.expLines.push(em[1].trim());
        else warn(ln, '解析出现在题目之外，已忽略');
        continue;
      }

      // ⑦ 题干内联答案（兼容「题干…（答案：A）。」）—— 交由 pushStemBody 统一处理
      // ⑧ 普通文字：可能是新题（最简写法：无题号、无标记），否则并入题干/解析
      if (cur) {
        const finished = cur.answerRaw != null || cur.optionOrder.length >= 2;
        // 新题的判据：上一题已收尾 + 这行像题干 + （前面有空行 或 还没写解析 或 行内有空位/问号）
        const canStartNew = finished && looksLikeStem(rest) &&
          (prevBlank || !cur.expLines.length || BLANK_RE.test(rest) || /[？?]\s*$/.test(rest));
        if (canStartNew) {
          flush();
          startQuestion(null, null, ln);
          pushStemBody(rest);
          continue;
        }
        if (cur.answerRaw != null) cur.expLines.push(rest.trim());
        else pushStemBody(rest);
      } else if (looksLikeStem(rest)) {
        startQuestion(null, null, ln);
        pushStemBody(rest);
      } else {
        warn(ln, `题目之外的文字（疑似标题），已忽略：「${rest.trim().slice(0, 24)}」`);
      }
    }
    flush();

    const byType = { single: 0, multi: 0, judge: 0, fill: 0 };
    for (const q of questions) byType[q.type]++;
    const missing = questions.filter(q => !q.answer).length;
    return {
      questions, errors, warns, sections,
      stats: {
        total: questions.length, byType, missing,
        answered: questions.length - missing,
        errors: errors.length, warns: warns.length, sections: sections.length
      }
    };
  }

  /* ================= 序列化（题库 / 转换结果 → 范式文本） ================= */

  function secIdxOf(q) {
    if (q.secIdx != null) return q.secIdx;
    const k = String(q.key || '');
    const i = parseInt(k.split('-')[0], 10);
    return Number.isFinite(i) ? i : 0;
  }

  function serialize(questions, sections, opts = {}) {
    const list = [...questions].sort((a, b) => (secIdxOf(a) - secIdxOf(b)) || ((a.no ?? 0) - (b.no ?? 0)));
    const secMap = new Map((sections || []).map(s => [s.secIdx, s.title]));
    const out = [];
    if (opts.title) out.push('# ' + opts.title, '');
    let lastSec = null;
    for (const q of list) {
      const si = secIdxOf(q);
      if (si !== lastSec) {
        const t = secMap.get(si);
        if (t) out.push('## ' + t, '');
        lastSec = si;
      }
      const head = `【${TYPE_LABEL[q.type] || '填空'}】${q.no != null ? q.no + '. ' : ''}${cleanStem(q.stem)}`;
      out.push(head);
      if (q.options && q.type !== 'judge') {
        for (const k of Object.keys(q.options).sort()) out.push(`${k}. ${q.options[k]}`);
      }
      if (q.type === 'judge') {
        out.push('答案：' + (q.answer === 'A' ? '对' : q.answer === 'B' ? '错' : ''));
      } else {
        out.push('答案：' + (q.answer || ''));
      }
      if (q.explanation) out.push('解析：' + String(q.explanation).replace(/\s+/g, ' ').trim());
      out.push('');
    }
    return out.join('\n');
  }

  /* 题干清洗：单行化 + 去掉转换残留的尾部「答案：」「（答案：）」空壳
     （旧格式文档里「题干。\n答案：」这种断行会让答案行落进题干） */
  function cleanStem(s) {
    return String(s == null ? '' : s)
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s*[（(]?\s*(?:参考答案|正确答案|答案)\s*[:：]?\s*[)）]?\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* 题库 → 范式文本 */
  function fromQuestions(questions, sections, opts = {}) {
    return serialize(questions || [], sections || [], opts);
  }

  /* ================= Word 转换器：任意文档 → 范式文本 =================
     复用成熟的本地解析流水线（cleanText → splitQuestions → parseOneQuestion），
     再按 章/节/题号 做一次本地答案匹配；匹配不到的题答案留空（写「答案：」），
     由用户在文本框里补，或用「AI 解题」批量补。全程零 API 调用。 */

  /* 文本里是否已经带范式特征（题型标记 或 行首答案行） */
  const CANON_MARK_RE = /[【\[]\s*(?:单选|多选|判断|填空|选择|简答|问答|名词解释|计算|论述)题?\s*[】\]]/;
  const CANON_ANS_RE = /^[ \t　]*(?:参考答案|正确答案|答案)\s*[:：]/m;

  function convert(text) {
    if (typeof Extractor === 'undefined') throw new Error('转换器需要 Extractor 模块');
    const src = String(text || '').replace(/\r\n?/g, '\n').trim();

    const clean = Extractor.cleanText(src);
    const split = Extractor.splitQuestions(clean);
    const qs = [];
    for (const it of split.items) {
      const q = Extractor.parseOneQuestion(it.no, it.text, it.type, it.key);
      if (q && q.stem) { q.secIdx = it.secIdx; qs.push(q); }
    }

    /* 已经是范式（带题型标记 / 行首答案行）且范式解析出的题数不少于旧管线
       → 原样保留，不再二次拆改：转换幂等、反复转换不会把范式拆坏。
       注意：只有「题型标记」才能无条件认定；仅凭「答案：」行时还要求范式解析
       零错误且确实解析出答案，否则旧格式文档（题末答案表）会被误当范式吞掉 */
    const marked = CANON_MARK_RE.test(src);
    if (marked || CANON_ANS_RE.test(src)) {
      const pre = parse(src);
      const ok = pre.stats.total > 0 && pre.stats.total >= qs.length &&
        (marked || (pre.errors.length === 0 && pre.stats.answered > 0));
      if (ok) {
        return {
          text: src + '\n',
          stats: {
            total: pre.stats.total, byType: pre.stats.byType, missing: pre.stats.missing,
            answered: pre.stats.answered, filled: 0, explained: 0
          },
          problems: [], passthrough: true,
          errors: pre.errors, warns: pre.warns
        };
      }
    }

    // 文末答案表 / 逐行答案条目：按 章/节/题号 本地匹配（无 AI）
    let filled = 0, explained = 0;
    if (typeof LLM !== 'undefined' && qs.length) {
      try {
        const parsed = LLM.parseAnswerDocument(clean);
        if (parsed.entries.length || parsed.ordered.length) {
          const r = LLM.matchAnswersStructured(qs, split.sections, parsed);
          filled = r.filled; explained = r.explained;
        }
      } catch (e) { /* 答案表匹配失败不影响转换 */ }
    }
    const text2 = serialize(qs, split.sections);
    const missing = qs.filter(q => !q.answer).length;
    const byType = { single: 0, multi: 0, judge: 0, fill: 0 };
    for (const q of qs) byType[q.type]++;
    return {
      text: text2,
      stats: { total: qs.length, byType, missing, answered: qs.length - missing, filled, explained },
      problems: split.problems || []
    };
  }

  return { SPEC, template, parse, fromQuestions, convert, TYPE_ALIAS, TYPE_LABEL };
})();