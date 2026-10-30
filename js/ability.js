/* ========== 本地能力估分（1PL / Elo 风格）· 纯函数、无依赖、不碰 DB ==========
   解决的问题：练习记录里只有「对/错」，看不出「我现在能考多少分」。
   这里把 history 拍平后的逐题作答当成一串观测，回放一遍单参数逻辑模型（1PL），
   估出能力值 theta（题目难度 b 顺手也估出来），再拿题库里的一份「预测卷」算预计分。

   API：
   - estimate({ questions, rows, examShape, opts })
       → { insufficient, n, theta, predicted, sections, items }
   - DEFAULT_SHAPE   缺省卷型 { single:6, multi:2, judge:1, fill:1 }
   - PASS_LINE       及格线 60（通过概率用这条线）

   算法（确定性、可复现，两次调用结果必然一致）：
   - 1PL：p = 1/(1+exp(-(theta - b)))；theta 与每题 b 初始 0
   - 按 rows 时间升序逐条回放：y = status==='ok' ? 1 : 0
       lr = 0.5/(1 + seen/20)，下限 0.08（seen = 该题此前已作答次数）
       theta += lr*(y - p) ；b -= lr/2*(y - p)
   - 回放完把 b 去均值（按每题作答次数加权），theta 同步减去同一个均值：
        theta' - b' = theta - b 不变，但 b 变成「相对本题库」的难度，
        theta 也就不再随题库整体偏难/偏易而漂移
   - 预测卷抽题必须确定性：按 (bankId, no, id) 排序，每个题型取前 k 题，
     该题型不够就从其他题型补，总题量 = sum(examShape)
   - 预计分 = round(100 × 平均 p)；区间用二项方差近似；及格概率用正态近似（erf）

   边界（一律不抛错，insufficient 时也返回数值，UI 自己决定展不展示）：
   - rows 为空 / questions 为空 / qid 在题库里找不到 / answer 为 null / 题量不够一张卷
   - rows 里 status 不是 ok|bad（如未作答 'none'）不计入能力更新：未作答不是「答错」
   - rows.length < opts.minRows（默认 30）→ insufficient = true，n 仍是 rows.length ========== */
const Ability = (() => {

  /* ---- 缺省卷型与及格线（调用方可用 examShape / PASS_LINE 覆盖展示口径） ---- */
  const DEFAULT_SHAPE = { single: 6, multi: 2, judge: 1, fill: 1 };
  const PASS_LINE = 60;
  const TYPES = ['single', 'multi', 'judge', 'fill'];

  /* ---- 学习率与区间参数（调过：单遍足够收敛，lr 下限防止老题学不动） ---- */
  const LR_BASE = 0.5;      // 首答学习率
  const LR_SEEN = 20;       // 答过 20 次后学习率减半
  const LR_MIN = 0.08;      // 学习率下限（老题也要能微调）
  const MIN_ROWS = 30;      // 判「数据不足」的默认阈值
  const MAX_PAPER = 200;    // 一张预测卷最多抽这么多题（防呆）
  const Z_BAND = 1.28;      // ≈80% 区间半宽系数
  const MAX_BAND = 8;       // 区间半宽上限（分）

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v, d) { const x = Number(v); return Number.isFinite(x) ? x : d; }
  /* 逻辑函数（夹一下指数，避免极端 theta 时溢出） */
  function sig(x) { return 1 / (1 + Math.exp(-clamp(x, -40, 40))); }

  /* ---- erf / 正态 CDF（Abramowitz-Stegun 7.1.26，误差 < 1.5e-7） ---- */
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * a);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
    return sign * y;
  }
  function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

  /* ---- 确定性排序键：数字按数值、文字按码点（不用 localeCompare，跨环境才稳定） ---- */
  function cmp(a, b) {
    const an = Number(a), bn = Number(b);
    const aNum = String(a).trim() !== '' && Number.isFinite(an);
    const bNum = String(b).trim() !== '' && Number.isFinite(bn);
    if (aNum && bNum && an !== bn) return an - bn;
    if (aNum !== bNum) return aNum ? -1 : 1;
    const sa = String(a), sb = String(b);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }
  /* 题目排序：bankId → no → id（抽预测卷、补题都靠它保证同一份题库永远抽同一张卷） */
  function qcmp(a, b) {
    return cmp(a.bankId, b.bankId) || cmp(a.no, b.no) || cmp(a.id, b.id) || 0;
  }

  /* ---- 卷型归一：缺省/全 0/非法 → DEFAULT_SHAPE；单题型最多 MAX_PAPER 题 ---- */
  function normShape(examShape) {
    const src = (examShape && typeof examShape === 'object') ? examShape : null;
    const shape = {};
    let total = 0;
    for (const t of TYPES) {
      const k = src ? Math.min(MAX_PAPER, Math.max(0, Math.floor(num(src[t], 0)))) : DEFAULT_SHAPE[t];
      shape[t] = k;
      total += k;
    }
    if (!total) {                       // 传了但全是 0 / 传了奇怪对象 → 退回默认卷型
      total = 0;
      for (const t of TYPES) { shape[t] = DEFAULT_SHAPE[t]; total += shape[t]; }
    }
    return { shape, total };
  }

  /* ---- 抽预测卷：先按题型各取前 k，缺的从其他题型补；结果完全由题库决定 ---- */
  function pickPaper(questions, shape, total) {
    const pools = {};
    for (const t of TYPES) pools[t] = [];
    for (const q of questions) {
      const t = TYPES.indexOf(q.type) >= 0 ? q.type : 'fill';   // 未知题型按填空兜底
      pools[t].push(q);
    }
    for (const t of TYPES) pools[t].sort(qcmp);

    const picked = [];
    const used = new Set();
    for (const t of TYPES) {
      const k = shape[t];
      for (let i = 0; i < k && i < pools[t].length; i++) {
        picked.push(pools[t][i]);
        used.add(pools[t][i]);
      }
    }
    if (picked.length < total) {        // 某题型不够 → 按同一排序从剩余题里补
      const spare = [];
      for (const t of TYPES) for (const q of pools[t]) if (!used.has(q)) spare.push(q);
      spare.sort(qcmp);
      for (let i = 0; i < spare.length && picked.length < total; i++) picked.push(spare[i]);
    }
    return picked;
  }

  /* ---- 章节标题：key 与 app.js 一致（bankId:secIdx），优先用 opts.sectionTitle ---- */
  function secKey(q) { return String(q.bankId) + ':' + String(q.secIdx == null ? '' : q.secIdx); }
  function titleOf(key, q, map) {
    let t = null;
    if (map && typeof map.get === 'function') t = map.get(key);
    else if (map && typeof map === 'object') t = map[key];
    if (t) return String(t);
    const s = q.secIdx;
    return (s == null || s === '') ? '未分节' : ('第 ' + s + ' 节');
  }

  /** 估算能力。
   *  @param {{questions?:Array, rows?:Array, examShape?:object, opts?:object}} input
   *  @returns {{insufficient:boolean, n:number, theta:number,
   *             predicted:{score:number, low:number, high:number, passRate:number, paperSize:number},
   *             sections:Array<{key:string,title:string,bankId:string,secIdx:any,score:number,n:number}>,
   *             items:Object<string,{b:number,n:number}>}}
   */
  function estimate(input) {
    const inp = input || {};
    const src = Array.isArray(inp.questions) ? inp.questions : [];
    const rows = Array.isArray(inp.rows) ? inp.rows : [];
    const opts = (inp.opts && typeof inp.opts === 'object') ? inp.opts : {};
    const minRows = Math.max(0, Math.floor(num(opts.minRows, MIN_ROWS)));
    const passes = clamp(Math.floor(num(opts.passes, 1)) || 1, 1, 6);

    /* ---- 1. 建 qid → 题目索引（id 是主键，重复的只认第一次），逐条回放作答 ---- */
    const byId = new Map();
    const questions = [];
    for (const q of src) {
      if (!q || q.id == null) continue;
      const id = String(q.id);
      if (byId.has(id)) continue;
      byId.set(id, q);
      questions.push(q);
    }

    const diffs = new Map();   // qid → b（相对难度）
    const seen = new Map();    // qid → 已作答次数
    const graded = [];         // 有效观测 {id, y}
    for (const r of rows) {
      if (!r) continue;
      const q = byId.get(String(r.qid));
      if (!q) continue;                              // 题被删了 / id 对不上 → 跳过，不抛错
      if (r.status !== 'ok' && r.status !== 'bad') continue;  // 未作答不算答错
      const id = String(q.id);
      if (!diffs.has(id)) { diffs.set(id, 0); seen.set(id, 0); }
      graded.push({ id, y: r.status === 'ok' ? 1 : 0 });
    }

    let theta = 0;
    for (let pass = 0; pass < passes; pass++) {
      for (const g of graded) {
        const b = diffs.get(g.id);
        const n = seen.get(g.id) || 0;
        const p = sig(theta - b);
        const lr = Math.max(LR_MIN, LR_BASE / (1 + n / LR_SEEN));
        theta += lr * (g.y - p);
        diffs.set(g.id, b - lr / 2 * (g.y - p));
        seen.set(g.id, n + 1);
      }
    }

    /* ---- 2. b 去均值（按作答次数加权），theta 同步补偿 → 能力值相对本题库 ---- */
    let wsum = 0, wcnt = 0;
    diffs.forEach((b, id) => { const n = seen.get(id) || 0; wsum += b * n; wcnt += n; });
    const meanB = wcnt ? wsum / wcnt : 0;
    diffs.forEach((b, id) => diffs.set(id, b - meanB));
    theta -= meanB;

    /* ---- 3. 预测卷：同一份 questions + examShape 永远抽出同一张卷 ---- */
    const { shape, total } = normShape(inp.examShape);
    const paper = pickPaper(questions, shape, total);
    const bOf = (q) => { const v = diffs.get(String(q.id)); return v == null ? 0 : v; };  // 未作答按题库平均难度

    let pSum = 0, vSum = 0;
    for (const q of paper) {
      const p = sig(theta - bOf(q));
      pSum += p;
      vSum += p * (1 - p);
    }
    const N = paper.length;
    let score, sd;
    if (N > 0) {
      score = clamp(Math.round(100 * pSum / N), 0, 100);
      sd = 100 * Math.sqrt(vSum) / N;
    } else {
      // 题量不够一张卷（甚至题库为空）：拿「平均水平的一道题」给个数值，不抛错
      const p = sig(theta);
      score = clamp(Math.round(100 * p), 0, 100);
      sd = 100 * Math.sqrt(p * (1 - p));
    }
    const band = Math.min(Math.round(Z_BAND * sd), MAX_BAND);
    const predicted = {
      score,
      low: clamp(score - band, 0, 100),
      high: clamp(score + band, 0, 100),
      // P(分数 ≥ PASS_LINE)：X ~ N(score, sd²)，正态近似；clamp 到 0.01~0.99 免得出现 0%/100%
      passRate: clamp(normCdf((score - PASS_LINE) / Math.max(sd, 1e-6)), 0.01, 0.99),
      paperSize: N
    };

    /* ---- 4. 章节：按 bankId:secIdx 分组，分数 = 该组题目 p 的均值，n = 该组作答题数 ---- */
    const groups = new Map();
    for (const q of questions) {
      const key = secKey(q);
      let g = groups.get(key);
      if (!g) {
        g = { key, bankId: q.bankId, secIdx: q.secIdx == null ? '' : q.secIdx, pSum: 0, cnt: 0, n: 0 };
        groups.set(key, g);
      }
      g.pSum += sig(theta - bOf(q));
      g.cnt += 1;
    }
    for (const g of graded) {
      const q = byId.get(g.id);
      const grp = groups.get(secKey(q));
      if (grp) grp.n += 1;
    }
    const sections = [];
    for (const g of groups.values()) {
      if (!g.n) continue;               // 没作答过的章节不出分（避免大题库刷出一屏 0 题章节）
      sections.push({
        key: g.key,
        title: titleOf(g.key, { secIdx: g.secIdx }, opts.sectionTitle),
        bankId: g.bankId,
        secIdx: g.secIdx,
        score: clamp(Math.round(100 * g.pSum / Math.max(1, g.cnt)), 0, 100),
        n: g.n
      });
    }
    sections.sort((a, b) => cmp(a.bankId, b.bankId) || cmp(a.secIdx, b.secIdx) || cmp(a.key, b.key));

    /* ---- 5. 每题难度（只回作答过的题：没作答的 b 就是 0，列出来只是噪声） ---- */
    const items = {};
    diffs.forEach((b, id) => { items[id] = { b, n: seen.get(id) || 0 }; });

    return {
      insufficient: rows.length < minRows,
      n: rows.length,
      theta,
      predicted,
      sections,
      items
    };
  }

  return { estimate, DEFAULT_SHAPE, PASS_LINE };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Ability;