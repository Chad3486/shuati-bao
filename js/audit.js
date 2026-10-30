/* ========== 题库体检 · 纯本地规则扫描（零依赖，浏览器 / Node 共用） ==========
   解决的问题：题库来自 Word/PDF/各种导入渠道，脏数据肉眼看不出来（答案字母越界、
   选项字母跳号、答案解析对不上、题干没写完、同一道题重复导入两遍……），等刷到才发现就晚了。
   这里用一组纯函数规则做一次全量体检，产出「可直接改」的清单，不联网、不写库、不改题。

   API：
   - bank(questions, opts)  题库 → { summary: { error, warn, info, total, questions }, issues: [...] }
   - report(issues, meta)   issues → Markdown 体检报告（meta = { bankName, date, total }）
   - LEVELS                 级别顺序：['error', 'warn', 'info']

   issue = { code, level, qid, no, message, hint }
   · message / hint 一律中文短句，说清「哪里错、怎么改」；qid 取题目 id，no 取题号
   · issues 排序：error→warn→info → 同级别按题号升序 → 同一题内按规则执行先后

   规则（code / level）：
   - ans-out-of-range            error  答案字母不在选项键集合里（判断题按 A/B 校验）
   - dup-option-text             error  同一题两个选项文本完全相同（去空白后比较）
   - missing-option-key          warn   选项字母跳号（如只有 A、C 没有 B）
   - single-multi-mismatch       warn   单选却有 ≥2 个答案字母；多选却只有 1 个
   - answer-explanation-conflict warn   解析里「答案：X / 选 X / 正确的是 X / 答案是 X」与 answer 不一致
   - judge-shape                 warn   判断题 answer 不是 A/B，或 options 不是「正确/错误」
   - stem-truncated              info   题干以（ ( ， , 、 ：结尾，或长度 < 6
   - empty-explanation           info   有答案但没有解析（opts.checkExplanation === false 时不报）
   - duplicate-question          warn   题干归一化后 3-gram Jaccard ≥ 0.85（按更小的题号报，一对只报一次）

   几个「宁可不报也不误报」的取舍（都有注释）：
   · 答案解析冲突只在「解析字母不是答案字母子集」时报：多选题解析写「答案：A（C 也正确）」
     这种部分表述不算冲突；「不选A」「错误的是A」不会被当成答案声明。
   · 判重先按「归一化题干前 2 字 + 长度每 8 字一桶」分桶，桶内两两比较；单桶上限 200、
     总比较上限 200000，超限直接跳过判重（绝不 O(n²) 全量比）。
   · 通用题干（下列说法 / 以下说法 / 下列各项 / 关于…的说法 / 以下…中 等）必须先过题干
     相似度，再要求选项也高度相似才报——否则 2000 题能刷出几十条「下列说法」互相重复的噪音。
   · 只差数字的题干（220V / 380V 这类同模板参数题）同样要求选项相似才报，避免把计算题
     的不同参数当成重复题。
   · 题号前缀只认「1.」「第 1 题」「（1）」这类带标点的写法，避免把「220V 电源」的 220 吃掉后
     误判成和「380V 电源」重复。
   · 历史脏数据（答案小写 / 全角字母 / 带标点分隔）先归一化再校验，所以不会误报。
====================================================================== */
const Audit = (() => {
  'use strict';

  const LEVELS = Object.freeze(['error', 'warn', 'info']);
  const LEVEL_RANK = { error: 0, warn: 1, info: 2 };
  const LEVEL_LABEL = { error: '错误', warn: '警告', info: '提示' };

  const CODE_ORDER = [
    'ans-out-of-range',
    'dup-option-text',
    'missing-option-key',
    'single-multi-mismatch',
    'answer-explanation-conflict',
    'judge-shape',
    'stem-truncated',
    'empty-explanation',
    'duplicate-question'
  ];
  const CODE_LABEL = {
    'ans-out-of-range': '答案超出选项',
    'dup-option-text': '选项内容重复',
    'missing-option-key': '选项字母跳号',
    'single-multi-mismatch': '题型与答案不符',
    'answer-explanation-conflict': '答案与解析冲突',
    'judge-shape': '判断题格式异常',
    'stem-truncated': '题干疑似截断',
    'empty-explanation': '缺少解析',
    'duplicate-question': '题目重复'
  };

  const MAX_TABLE_ROWS = 50;      // 报告中每个 code 最多展示的行数
  const DUP_THRESHOLD = 0.85;     // 3-gram Jaccard 判重阈值
  const DUP_MIN_LEN = 8;          // 归一化题干至少 8 字符才参与判重
  const DUP_BUCKET_CAP = 200;     // 单个桶最多 200 题
  const DUP_MAX_COMPARE = 200000; // 本次体检判重比较次数总上限
  const DUP_LEN_BUCKET = 8;       // 题干长度分桶粒度

  /* ---------------- 文本归一化 ---------------- */

  /* 全角转半角（数字/字母/标点），全角空格照常变普通空格。
   绝大多数题都不含全角字符，先做一次快速判断，避免每题都逐字符重建字符串。 */
  const FULLWIDTH_RE = /[\uFF01-\uFF5E\u3000]/;
  function toHalf(value) {
    const s = String(value == null ? '' : value);
    if (!FULLWIDTH_RE.test(s)) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code === 0x3000) out += ' ';
      else if (code >= 0xFF01 && code <= 0xFF5E) out += String.fromCharCode(code - 0xFEE0);
      else out += s[i];
    }
    return out;
  }

  /* 去所有空白（含全角空格），用于选项文本查重 */
  const SPACE_RE = /\s/;
  function collapseSpace(value) {
    const s = toHalf(value);
    return SPACE_RE.test(s) ? s.replace(/\s+/g, '') : s;
  }

  /* 只留字母 / 数字 / 汉字，再转大写；用于题干与选项的相似度比对 */
  function normalizeText(value) {
    return toHalf(value).replace(/[^\p{L}\p{N}]+/gu, '').toUpperCase();
  }

  /* 题干归一化：去题型标记、去带标点的序号前缀、去标点空白、转大写 */
  function normalizeStem(value) {
    let s = toHalf(value);
    const first = s.charCodeAt(0);
    // 行首可能是空白 / 数字 / 第 / （ / ( / [ / 【 时才需要清序号，普通中文题干直接跳过
    const maybePrefix = first === 0x3000 || first === 0x20 || first === 0x09 || first === 0x0a
      || first === 0x0d || (first >= 0x30 && first <= 0x39) || first === 0x7B2C
      || first === 0x0028 || first === 0xFF08 || first === 0x005B || first === 0x3010;
    if (maybePrefix) {
      s = s.replace(/^\s*(?:【[^】]{1,8}】|\[[^\]]{1,8}\])+\s*/, '');
      // 只吃「1. / 第1题 / （1）」这类明显是序号的写法；「1.5倍」这种小数不动
      s = s.replace(/^\s*(?:第\s*\d+\s*题\s*[.、:：]?|[(（]\s*\d+\s*[)）]|\d+\s*[.、,，:：)）](?!\d))\s*/, '');
    }
    return normalizeText(s);
  }

  function isBlank(value) {
    return value == null || String(value).trim() === '';
  }

  function displayText(value, max) {
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const limit = max || 20;
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  }

  /* ---------------- 题目字段解析 ---------------- */

  function noOf(q, index) {
    const n = Number(q && q.no);
    return Number.isFinite(n) ? n : index + 1;
  }

  function qidOf(q) {
    if (!q) return null;
    if (q.id != null) return q.id;
    if (q.key != null) return q.key;
    return null;
  }

  /* options 规范成「按字母排序的条目 + 大写键集合」；null / 数组一律视为没有可用选项 */
  function readOptions(q) {
    const raw = q && q.options;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const entries = [];
    for (const rawKey of Object.keys(raw)) {
      const key = toHalf(rawKey).trim().toUpperCase();
      if (!key) continue;
      entries.push({ key: key, text: raw[rawKey] });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { entries: entries, keySet: new Set(entries.map(e => e.key)) };
  }

  /* answer 里的字母（大写、去重、保留顺序）：'aｃ' → ['A','C']，填空文字 → [] */
  function answerLetters(value) {
    const s = toHalf(value);
    const out = [];
    const re = /[A-Za-z]/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const letter = m[0].toUpperCase();
      if (!out.includes(letter)) out.push(letter);
    }
    return out;
  }

  /* ---------------- 答案解析冲突：只认第一个「答案声明」 ---------------- */

  /* 在解析里找第一处像「答案：C」的声明，返回 { letters, text }；找不到返回 null。
     每条模式都跳过「不 / 非 / 错 / 误」开头的否定式（不选A、错误的是A、不正确答案是C）。
     只取紧跟关键字的那一个连续字母串：「答案：A，B项错误」只当解析在说 A，不会把后面的
     B 也算进答案，避免中文逗号后的正文被误伤。 */
  function firstAnswerMention(text) {
    const src = String(text == null ? '' : text);
    const t = toHalf(src);
    const patterns = [
      { re: /(?:正确答案|参考答案|答案)\s*[:：]\s*([A-Za-z]{1,4})/g, neg: /[不非错误]/ },
      { re: /(?:正确答案|参考答案|答案)\s*[是为]\s*([A-Za-z]{1,4})/g, neg: /[不非错误]/ },
      { re: /正确的是\s*([A-Za-z]{1,4})/g, neg: /[不非]/ },
      { re: /选\s*([A-Za-z]{1,4})/g, neg: /[不勿别]/ }
    ];
    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(t)) !== null) {
        const before = t[m.index - 1] || '';
        if (p.neg.test(before)) continue;
        const letters = answerLetters(m[1]);
        // 命中片段从原文里截（toHalf 是 1:1 换字符，下标可对齐），保留「：」这类中文标点的原样
        if (letters.length) return { letters: letters, text: src.slice(m.index, m.index + m[0].length).trim() };
      }
    }
    return null;
  }

  /* ---------------- 判重：3-gram + 分桶 ---------------- */

  /* 3-gram：编码成整数（charCode 组合）比字符串切片快很多，也不产生垃圾。
   进制取 65536，保证三个 charCode 一一对应、不撞车（最大约 2.8e14，double 能精确表示）。 */
  function grams3(s) {
    const set = new Set();
    for (let i = 0; i + 3 <= s.length; i++) {
      set.add(s.charCodeAt(i) * 4294967296 + s.charCodeAt(i + 1) * 65536 + s.charCodeAt(i + 2));
    }
    return set;
  }

  /* Jaccard 相似度；先用「大小比例」做剪枝（Jaccard 不可能超过短集合/长集合） */
  function jaccard(a, b) {
    if (!a || !b || !a.size || !b.size) return 0;
    const aSmall = a.size <= b.size;
    const small = aSmall ? a : b;
    const big = aSmall ? b : a;
    if (small.size < big.size * DUP_THRESHOLD) return 0;
    let inter = 0;
    for (const g of small) if (big.has(g)) inter++;
    if (!inter) return 0;
    return inter / (a.size + b.size - inter);
  }

  /* 选项签名：文本归一化后排序拼接，用于「通用题干」场景的二次确认 */
  function optionSignature(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return '';
    return Object.keys(options)
      .map(k => normalizeText(options[k]))
      .filter(Boolean)
      .sort()
      .join('|');
  }

  /* 通用题干白名单：说法/叙述/各项/关于…的说法/以下…中，这类题干天然长得像 */
  function isGenericStem(norm) {
    if (!/^(?:下列|以下|下述|如下|下面|有关|关于)/.test(norm)) return false;
    return /(?:说法|叙述|表述|描述|各项|选项|内容|中|的是|正确|错误)/.test(norm);
  }

  function optionsSimilar(a, b) {
    const ga = optionGramsOf(a);
    const gb = optionGramsOf(b);
    return !!ga && !!gb && jaccard(ga, gb) >= DUP_THRESHOLD;
  }

  /* 以下三个都是惰性求值：绝大多数题不会进到比较环节，没必要先算 */
  function gramsOf(c) {
    return c.grams || (c.grams = grams3(c.norm));
  }

  function optionGramsOf(c) {
    if (c.optGrams === undefined) {
      const sig = optionSignature(c.rawOptions);
      c.optGrams = sig.length >= 3 ? grams3(sig) : null;
    }
    return c.optGrams;
  }

  function genericOf(c) {
    return c.generic === undefined ? (c.generic = isGenericStem(c.norm)) : c.generic;
  }

  /* 去掉数字后的「题干骨架」：只差数字的两题（220V / 380V）多半是同一模板的不同参数题，
   不能当重复；只有选项也高度相似时才报（见 findDuplicates）。 */
  function stripDigits(s) {
    return s.replace(/\d+/g, '');
  }

  /* 判重主流程：分桶 → 桶内两两比较 → 记录「题号小的一题」和谁重复（一对只记一次） */
  function findDuplicates(list) {
    const cands = [];
    for (let i = 0; i < list.length; i++) {
      const norm = normalizeStem(list[i].stem);
      if (norm.length < DUP_MIN_LEN) continue;
      cands.push({
        index: i,
        no: noOf(list[i], i),
        norm: norm,
        rawOptions: list[i].options,
        bucket: norm.slice(0, 2) + '#' + Math.floor(norm.length / DUP_LEN_BUCKET),
        grams: null,
        generic: undefined,
        optGrams: undefined
      });
    }
    if (cands.length < 2) return [];

    const buckets = new Map();
    const dupMap = new Map(); // 锚点题下标 → { partners: [候选], best: 最高相似度 }
    let comparisons = 0;
    let stopped = false;

    for (const c of cands) {
      if (stopped) break;
      const arr = buckets.get(c.bucket);
      if (!arr) {
        buckets.set(c.bucket, [c]);
        continue;
      }
      if (arr.length >= DUP_BUCKET_CAP) continue; // 单桶超限：这一题跳过判重
      for (const p of arr) {
        comparisons++;
        if (comparisons > DUP_MAX_COMPARE) {
          stopped = true;
          break;
        }
        const sim = jaccard(gramsOf(c), gramsOf(p));
        if (sim < DUP_THRESHOLD) continue;
        // 「下列说法」这类通用题干、以及只差数字的同模板参数题，都要选项也像才算重复
        const genericOrParam = genericOf(c) || genericOf(p)
          || (c.norm !== p.norm && stripDigits(c.norm) === stripDigits(p.norm));
        if (genericOrParam && !optionsSimilar(c, p)) continue;
        const anchor = c.no <= p.no ? c : p;
        const partner = anchor === c ? p : c;
        let rec = dupMap.get(anchor.index);
        if (!rec) {
          rec = { partners: [], best: 0 };
          dupMap.set(anchor.index, rec);
        }
        rec.partners.push(partner);
        if (sim > rec.best) rec.best = sim;
      }
      if (!stopped) arr.push(c);
    }

    const out = [];
    for (const [anchorIndex, rec] of dupMap) {
      const q = list[anchorIndex];
      const partnerNos = [];
      for (const p of rec.partners) {
        if (!partnerNos.includes(p.no)) partnerNos.push(p.no);
      }
      if (!partnerNos.length) continue;
      partnerNos.sort((a, b) => a - b);
      const ref = partnerNos.length <= 3
        ? `第 ${partnerNos.join('、')} 题`
        : `第 ${partnerNos.slice(0, 3).join('、')} 题等 ${partnerNos.length} 题`;
      out.push({
        code: 'duplicate-question',
        level: 'warn',
        qid: qidOf(q),
        no: noOf(q, anchorIndex),
        message: `题干与${ref}高度相似（约 ${Math.round(rec.best * 100)}%），疑似重复`,
        hint: '保留一题，删掉重复的那道'
      });
    }
    return out;
  }

  /* ---------------- 规则扫描 ---------------- */

  function bank(questions, opts) {
    const options = opts || {};
    const list = Array.isArray(questions)
      ? questions.filter(q => q && typeof q === 'object')
      : [];
    const checkExplanation = options.checkExplanation !== false;
    const issues = [];

    for (let index = 0; index < list.length; index++) {
      const q = list[index];
      const no = noOf(q, index);
      const qid = qidOf(q);
      const opt = readOptions(q);
      const answerRaw = q.answer;
      const hasAnswer = !isBlank(answerRaw);
      const ansLetters = hasAnswer ? answerLetters(answerRaw) : [];
      const ansSet = new Set(ansLetters);
      const type = typeof q.type === 'string' ? q.type.trim() : '';
      const explanation = q.explanation == null ? '' : String(q.explanation);
      // 选择题/判断题显示归一化后的字母；填空/未知题型显示原文（避免把英文答案拆成「字母」）
      const answerDisplay = (type === 'single' || type === 'multi' || type === 'judge') && ansLetters.length
        ? ansLetters.join('')
        : displayText(answerRaw, 16);

      const push = (code, level, message, hint) => {
        issues.push({ code: code, level: level, qid: qid, no: no, message: message, hint: hint });
      };

      /* 1. 答案超出选项范围（选项缺失/为空时不校验，避免把「没有选项的填空」误报） */
      if (hasAnswer && opt && opt.entries.length && ansLetters.length) {
        const out = ansLetters.filter(l => !opt.keySet.has(l));
        if (out.length) {
          push(
            'ans-out-of-range', 'error',
            `答案「${answerDisplay}」含选项之外的字母 ${out.join('、')}（可选：${opt.entries.map(e => e.key).join('/')}）`,
            '改成选项里存在的字母，或补上对应选项'
          );
        }
      }

      /* 2. 同一题选项文本重复（只去空白后比较，标点差异不报） */
      if (opt && opt.entries.length) {
        const groups = new Map();
        for (const e of opt.entries) {
          const v = collapseSpace(e.text);
          if (!v) continue;
          if (!groups.has(v)) groups.set(v, []);
          groups.get(v).push(e.key);
        }
        const duplicated = [...groups.entries()].filter(x => x[1].length > 1);
        if (duplicated.length) {
          const desc = duplicated.slice(0, 2)
            .map(x => `选项 ${x[1].join('、')} 内容相同：「${displayText(x[0], 18)}」`)
            .join('；') + (duplicated.length > 2 ? ' 等' : '');
          push(
            'dup-option-text', 'error',
            desc,
            '删掉重复选项，或把内容改成不同选项'
          );
        }

        /* 3. 选项字母跳号（从 A 开始连续） */
        const keys = opt.entries.map(e => e.key);
        const expected = keys.map((x, i) => String.fromCharCode(65 + i));
        const missing = expected.filter(k => !opt.keySet.has(k));
        const weird = keys.filter(k => !/^[A-Z]$/.test(k));
        if (missing.length || weird.length) {
          const parts = [];
          if (missing.length) parts.push(`缺少 ${missing.join('、')}`);
          if (weird.length) parts.push(`出现非字母键 ${weird.slice(0, 3).map(k => `「${k}」`).join('、')}`);
          push(
            'missing-option-key', 'warn',
            `选项字母不连续：${parts.join('，')}`,
            '补齐缺少的选项，或按 A/B/C 连续重排'
          );
        }
      }

      /* 4. 题型与答案个数不符 */
      if (type === 'single' && ansLetters.length >= 2) {
        push(
          'single-multi-mismatch', 'warn',
          `题型标为单选，但答案有 ${ansLetters.length} 个字母（${answerDisplay}）`,
          '改成多选，或只保留一个答案字母'
        );
      } else if (type === 'multi' && ansLetters.length === 1) {
        push(
          'single-multi-mismatch', 'warn',
          `题型标为多选，但答案只有 1 个字母（${ansLetters[0]}）`,
          '确认是否漏选；只有一个答案时改为单选'
        );
      }

      /* 5. 答案解析冲突（解析字母不是答案字母的子集才算冲突，保守） */
      if (hasAnswer && ansSet.size && explanation.trim() && /答案|选|正确/.test(explanation)) {
        const mention = firstAnswerMention(explanation);
        if (mention) {
          const extra = mention.letters.filter(l => !ansSet.has(l));
          if (extra.length) {
            push(
              'answer-explanation-conflict', 'warn',
              `解析写「${displayText(mention.text, 22)}」，与答案「${answerDisplay}」不一致`,
              '核对答案，保留一个正确说法'
            );
          }
        }
      }

      /* 6. 判断题格式（答案 A/B、选项 正确/错误） */
      if (type === 'judge') {
        const problems = [];
        if (hasAnswer) {
          const ok = ansLetters.length === 1 && (ansLetters[0] === 'A' || ansLetters[0] === 'B');
          if (!ok) problems.push(`答案应为 A/B（当前「${displayText(answerRaw, 12)}」）`);
        }
        const optOk = !!opt && opt.entries.length === 2 && opt.keySet.size === 2
          && opt.keySet.has('A') && opt.keySet.has('B')
          && collapseSpace(opt.entries.find(e => e.key === 'A').text).replace(/[。.!！]+$/, '') === '正确'
          && collapseSpace(opt.entries.find(e => e.key === 'B').text).replace(/[。.!！]+$/, '') === '错误';
        if (!optOk) problems.push('选项应为 A=正确、B=错误');
        if (problems.length) {
          push(
            'judge-shape', 'warn',
            `判断题格式异常：${problems.join('；')}`,
            '按 A=正确、B=错误 的标准判断题格式修正'
          );
        }
      }

      /* 7. 题干疑似截断 / 过短 */
      const stem = q.stem == null ? '' : String(q.stem);
      const trimmed = stem.replace(/\s+$/, '');
      const stemLen = trimmed.length; // 题干基本是中文/ASCII（BMP），length 足够且比 spread 快
      const tail = trimmed.slice(-1);
      const badTail = '（(，,、：:'.includes(tail);
      if (!trimmed) {
        push('stem-truncated', 'info', '题干为空', '补上题干后重新导入');
      } else if (stemLen < 6 && badTail) {
        push('stem-truncated', 'info', `题干过短（${stemLen} 字）且以「${tail}」结尾，疑似没写完`, '补全题干后重新导入');
      } else if (stemLen < 6) {
        push('stem-truncated', 'info', `题干过短（${stemLen} 字），可能没写完`, '补全题干后重新导入');
      } else if (badTail) {
        push('stem-truncated', 'info', `题干以「${tail}」结尾，疑似没写完（缺选项或补充内容）`, '补全题干后重新导入');
      }

      /* 8. 有答案但没解析（可关） */
      if (checkExplanation && hasAnswer && isBlank(explanation)) {
        push(
          'empty-explanation', 'info',
          `答案已填（${answerDisplay}），但没有解析`,
          '补一句解析，方便复习时理解为什么选它'
        );
      }
    }

    /* 9. 题干重复（最后统一做，需要全量视图） */
    for (const it of findDuplicates(list)) issues.push(it);

    const summary = { error: 0, warn: 0, info: 0, total: 0, questions: list.length };
    for (const it of issues) {
      if (summary[it.level] != null) summary[it.level]++;
    }
    summary.total = summary.error + summary.warn + summary.info;

    return { summary: summary, issues: sortIssues(issues) };
  }

  /* 排序：级别 → 题号升序 → 同题内按规则执行先后（稳定） */
  function sortIssues(issues) {
    const wrapped = issues.map((issue, seq) => {
      const rank = LEVEL_RANK[issue.level] != null ? LEVEL_RANK[issue.level] : 3;
      const n = Number(issue.no);
      return { issue: issue, seq: seq, rank: rank, noVal: Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER };
    });
    wrapped.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.noVal !== b.noVal) return a.noVal - b.noVal;
      return a.seq - b.seq;
    });
    return wrapped.map(w => w.issue);
  }

  /* ---------------- Markdown 报告 ---------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatDate(value) {
    if (value instanceof Date && !isNaN(value.getTime())) {
      return value.getFullYear() + '-' + pad2(value.getMonth() + 1) + '-' + pad2(value.getDate());
    }
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    const now = new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  function escapeCell(value) {
    return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  }

  function report(issues, meta) {
    const list = Array.isArray(issues) ? issues : [];
    const m = meta || {};
    const counts = { error: 0, warn: 0, info: 0 };
    for (const it of list) {
      if (it && counts[it.level] != null) counts[it.level]++;
    }
    const total = counts.error + counts.warn + counts.info;
    const bankName = m.bankName == null || String(m.bankName).trim() === ''
      ? '未命名题库'
      : String(m.bankName).trim();
    const lines = [];

    lines.push(`# 题库体检报告 · ${escapeCell(bankName)}`);
    lines.push('');
    const metaBits = [`日期：${formatDate(m.date)}`];
    if (m.total != null && Number.isFinite(Number(m.total))) metaBits.push(`题目：${Number(m.total)} 道`);
    metaBits.push(`问题：${total} 条`);
    lines.push(`> ${metaBits.join(' · ')}`);
    lines.push('');

    lines.push('## 概览');
    lines.push('');
    lines.push('| 级别 | 数量 |');
    lines.push('| --- | ---: |');
    for (const level of LEVELS) lines.push(`| ${LEVEL_LABEL[level]} | ${counts[level]} |`);
    lines.push('');

    if (!total) {
      lines.push('## 结论');
      lines.push('');
      lines.push('未发现需要处理的问题 ✅');
      return lines.join('\n');
    }

    lines.push('## 问题清单');
    lines.push('');
    for (const level of LEVELS) {
      const levelIssues = list.filter(it => it && it.level === level);
      if (!levelIssues.length) continue;
      const codes = CODE_ORDER.filter(code => levelIssues.some(it => it.code === code));
      const unknown = [...new Set(levelIssues.map(it => it.code))]
        .filter(code => !CODE_ORDER.includes(code))
        .sort();
      for (const code of codes.concat(unknown)) {
        const group = levelIssues.filter(it => it.code === code);
        const label = CODE_LABEL[code] || code || '其他问题';
        lines.push(`### ${LEVEL_LABEL[level]} · ${label}（${group.length} 条）`);
        lines.push('');
        lines.push('| 题号 | 问题 | 建议 |');
        lines.push('| ---: | --- | --- |');
        for (const it of group.slice(0, MAX_TABLE_ROWS)) {
          lines.push(`| ${escapeCell(it.no)} | ${escapeCell(it.message)} | ${escapeCell(it.hint)} |`);
        }
        lines.push('');
        if (group.length > MAX_TABLE_ROWS) {
          lines.push(`> 已省略 ${group.length - MAX_TABLE_ROWS} 条同类问题（每组最多展示 ${MAX_TABLE_ROWS} 条）。`);
          lines.push('');
        }
      }
    }
    return lines.join('\n');
  }

  return { bank: bank, report: report, LEVELS: LEVELS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Audit;