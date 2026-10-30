/* ========== 每日一练 · 选题与连续天数（纯函数：不碰 DB、不读时钟以外的外界状态） ==========
   解决的问题：每天打开 App 不用自己挑题——自动混一组「错题 + 薄弱章节 + 没练过的题 + 该复习的题」；
   同一天中途退出、过一会儿再进，题目和顺序都不变（否则做一半的进度就废了）。

   API：
   - dateKey(ts)              本地日期 'YYYY-MM-DD'（本地时区，不用 UTC）
   - plan({...})              每日题单 → { qids, breakdown, size }
   - streak(history, today)   连续天数 → { days, todayDone, lastDate }
   - MODES                    三档配额（standard / easy / devil）

   plan 的入参（都由调用方传进来，这里不查库）：
   - questions  [{ id, bankId, no, secIdx, type, stem, options, answer }]
   - latest     { [qid]: { correct, time } }   每题最近一次作答（DB.latestByQuestion()）
   - dateKey    'YYYY-MM-DD'
   - size       题量，默认 8
   - bankId     只从该题库选题，默认 null = 全部题库
   - mode       'standard' | 'easy' | 'devil'，默认 standard

   配额与回填规则（都能在 scripts/daily.test.js 里逐条对上）：
   1. 先按 mode 的三档配额（wrong / fresh / review）按 size 比例换算；size 和配额和不一致时，
      零头按 fresh → wrong → review 的顺序补（新题弹性最大）。
   2. 某一类不够（比如错题只有 2 道、配额要 3 道）时，按 wrong → weak → fresh → review 的顺序
      从其它类别补：先把当前优先级最高的一类余量取完，不够再取下一类，直到取满 size 或题全部取完。
   3. weak（答对过但所在章节最近正确率 < 60%）不单独占配额，只在回填时顶上——
      这类题是「半会不会」，紧跟在错题后面补位，别让每天 8 题里塞满同一类。
   4. breakdown 记的是**实际**各类取了几道，四项之和 == qids.length；size 也是实际题量
      （题不够时 size < 请求的题量；questions 为空时 size = 0）。

   确定性（关键）：seed = hash(dateKey | bankId | mode | size)，xmur3 出种子 → mulberry32 PRNG
   → 每个类别先按 id 排序、再用 seeded Fisher-Yates 洗牌、再按配额取。因为先排序，
   题目在入参数组里的先后不影响结果（DB 遍历顺序波动也不会换题）；因为种子只取这四个参数，
   同一天同一档位永远同一套题。
===================================================================== */
const Daily = (() => {

  /* ---- 三档配额：和都是 8；weak 不设配额（只在回填时顶上） ---- */
  const MODES = {
    standard: { wrong: 3, fresh: 4, review: 1 },
    easy:     { wrong: 2, fresh: 5, review: 1 },
    devil:    { wrong: 4, fresh: 3, review: 1 }
  };
  const QUOTA_KEYS = ['wrong', 'fresh', 'review'];            // 按配额取题的顺序
  const REFILL_ORDER = ['wrong', 'weak', 'fresh', 'review'];  // 不够时从其它类回填的优先级
  const SPILL_ORDER = ['fresh', 'wrong', 'review'];           // 配额零头先补谁
  const CATS = ['wrong', 'weak', 'fresh', 'review'];
  const WEAK_RATE = 0.6;            // 章节最近正确率低于这个值 → 该章节里答对的题算 weak
  const LABEL_DAILY = '每日一练';    // 只在历史里认这个 label 的练习记录

  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

  /* ---- 本地日期键：本地时区，不是 toISOString()（后者是 UTC，凌晨会差一天） ---- */
  function dateKey(ts) {
    if (typeof ts === 'string') {
      const s = ts.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;   // 已经是日期键，原样返回
    }
    let d;
    if (ts == null) d = new Date();
    else if (ts instanceof Date) d = ts;
    else if (typeof ts === 'number') d = new Date(ts);
    else d = new Date(String(ts));
    if (!d || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ---- 日期键 ±1 天：用 UTC 历法算，绕开夏令时/闰秒 ---- */
  function shiftDay(key, delta) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
    if (!m) return String(key);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + delta * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /* ---- 字符串 hash：xmur3（给 PRNG 出 32 位种子，同串同种子） ---- */
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  /* ---- PRNG：mulberry32（32 位状态，快、跨平台同结果） ---- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---- 洗牌：seeded Fisher-Yates（不改原数组） ---- */
  function shuffle(list, rng) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---- 章节键：bankId:secIdx（章节正确率按它聚合） ---- */
  function secKey(q) {
    return String(q.bankId == null ? '' : q.bankId) + ':' + String(q.secIdx == null ? '' : q.secIdx);
  }

  /* ---- size 与配额和不等时按比例换算：先取整，零头按 SPILL_ORDER 补 ---- */
  function scaledQuota(mode, size) {
    const base = MODES[mode] || MODES.standard;
    const quota = { wrong: 0, weak: 0, fresh: 0, review: 0 };
    if (!(size > 0)) return quota;
    const sum = base.wrong + base.fresh + base.review;
    const ratio = size / sum;
    let used = 0;
    for (const k of QUOTA_KEYS) {
      quota[k] = Math.floor(base[k] * ratio);
      used += quota[k];
    }
    let rest = size - used;
    for (let i = 0; rest > 0; i++) {
      quota[SPILL_ORDER[i % SPILL_ORDER.length]]++;
      rest--;
    }
    return quota;
  }

  function emptyPlan() {
    return { qids: [], breakdown: { wrong: 0, weak: 0, fresh: 0, review: 0 }, size: 0 };
  }

  /* ---- 每日选题 ---- */
  function plan(opts) {
    const o = opts || {};
    const questions = Array.isArray(o.questions) ? o.questions : [];
    const latest = o.latest && typeof o.latest === 'object' ? o.latest : {};
    const mode = has(MODES, o.mode) ? o.mode : 'standard';
    const bankId = o.bankId == null ? null : o.bankId;
    const dk = o.dateKey == null ? dateKey(null) : String(o.dateKey);
    let size = o.size == null ? 8 : Number(o.size);
    if (!isFinite(size) || size < 0) size = 8;
    size = Math.floor(size);

    if (!questions.length || size <= 0) return emptyPlan();

    /* 0. 按 id 去重（同一道题被重复传进来不该占两个名额，也会污染章节正确率） */
    const list = [];
    const seenQ = new Set();
    for (const q of questions) {
      if (!q || q.id == null || seenQ.has(q.id)) continue;
      seenQ.add(q.id);
      list.push(q);
    }
    if (!list.length) return emptyPlan();

    /* 1. 章节最近正确率（用传进来的全部题目算，bankId 过滤不影响：章节键里带 bankId） */
    const chapter = Object.create(null);
    for (const q of list) {
      const key = secKey(q);
      const st = chapter[key] || (chapter[key] = { total: 0, correct: 0 });
      const rec = has(latest, q.id) ? latest[q.id] : null;
      if (!rec) continue;
      st.total++;
      if (rec.correct) st.correct++;
    }

    /* 2. 分类（bankId 过滤） */
    const pools = { wrong: [], weak: [], fresh: [], review: [] };
    for (const q of list) {
      const id = q.id;
      if (bankId != null && q.bankId !== bankId) continue;
      const rec = has(latest, id) ? latest[id] : null;
      if (!rec) pools.fresh.push(id);
      else if (!rec.correct) pools.wrong.push(id);
      else {
        const st = chapter[secKey(q)];
        const rate = st && st.total ? st.correct / st.total : 0;
        (rate < WEAK_RATE ? pools.weak : pools.review).push(id);
      }
    }

    const poolTotal = CATS.reduce((n, k) => n + pools[k].length, 0);
    if (!poolTotal) return emptyPlan();

    /* 3. 种子只管 (dateKey, bankId, mode, size)：同一天同一档位洗出来的题固定
          —— 先按 id 排序再洗，题目在入参数的顺序（DB 遍历顺序）变了也不换题 */
    const seedBase = dk + '|' + (bankId == null ? '' : String(bankId)) + '|' + mode + '|' + size;
    for (const k of REFILL_ORDER) {
      pools[k].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
      pools[k] = shuffle(pools[k], mulberry32(xmur3(seedBase + '|' + k)()));
    }

    /* 4. 按配额取，不够的按 REFILL_ORDER 从其它类别回填 */
    const quota = scaledQuota(mode, size);
    const picked = { wrong: [], weak: [], fresh: [], review: [] };
    let need = size;
    for (const k of QUOTA_KEYS) {
      const take = Math.min(quota[k], pools[k].length, need);
      if (take > 0) {
        picked[k] = pools[k].splice(0, take);
        need -= take;
      }
    }
    for (const k of REFILL_ORDER) {
      if (need <= 0) break;
      if (!pools[k].length) continue;          // 这一类没余量了，看下一类
      const take = Math.min(need, pools[k].length);
      picked[k] = picked[k].concat(pools[k].splice(0, take));
      need -= take;
    }

    /* 5. 拼题单：按 wrong → weak → fresh → review 的段序（错题先做），段内即洗牌后的顺序 */
    const qids = [].concat(picked.wrong, picked.weak, picked.fresh, picked.review);
    const breakdown = {
      wrong: picked.wrong.length,
      weak: picked.weak.length,
      fresh: picked.fresh.length,
      review: picked.review.length
    };
    return { qids, breakdown, size: qids.length };
  }

  /* ---- 连续天数：只认 label === '每日一练'；一个日期有一条就算完成 ----
     今天还没做但昨天做了 → days 保留之前的连续数（不归零），todayDone = false。
     入参 history 最新在前/在后都无所谓，这里按 at 归日、用集合去重。 */
  function streak(history, todayKey) {
    const list = Array.isArray(history) ? history : [];
    const today = todayKey == null ? dateKey(null) : (dateKey(todayKey) || String(todayKey));
    const doneDays = new Set();
    let lastDate = null;
    for (const rec of list) {
      if (!rec || rec.label !== LABEL_DAILY) continue;
      const d = dateKey(rec.at);
      if (!d) continue;
      doneDays.add(d);
      if (lastDate == null || d > lastDate) lastDate = d;
    }
    if (!doneDays.size) return { days: 0, todayDone: false, lastDate: null };
    const todayDone = doneDays.has(today);
    let cursor = todayDone ? today : shiftDay(today, -1);
    let days = 0;
    while (doneDays.has(cursor)) {
      days++;
      cursor = shiftDay(cursor, -1);
    }
    return { days, todayDone, lastDate };
  }

  return { plan, streak, dateKey, MODES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Daily;