/* 每日一练回归测试：把 js/daily.js 的选题配额、回填顺序、确定性、连续天数逐条钉死。
   跑法：node --test scripts/daily.test.js
   只依赖 js/daily.js（间接 eval 载入），不联网、不碰 DB、不碰真实时钟。

   为什么要有它：
   · 「同一天退出再进不能换题」靠 seed hash 保证，一旦改坏用户做一半的进度就废了，
     而随机换题肉眼天天都在发生、很难发现——所以用确定性用例兜住；
   · 配额和回填顺序（wrong → weak → fresh → review）是产品定义的一部分，
     改个数字就可能变成「8 题里 5 道错题」，必须逐档断言；
   · streak 的「今天没做不归零」是产品承诺，断了就是用户白练。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* daily.js 是浏览器 IIFE（const Daily = (() => {...})()），用间接 eval 在全局求值后取句柄 */
(0, eval)(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'daily.js'), 'utf8')
  + '\nglobalThis.__Daily = Daily;'
);
const Daily = globalThis.__Daily;

/* ---- 造数据 ---- */
/* 一道题：id 用可读前缀（w = 错题、r = 已掌握、f = 没练过、k = 薄弱章节里答对的） */
const Q = (id, bankId = 'b1', secIdx = 0) => ({
  id, bankId, no: 0, secIdx, type: 'single',
  stem: '题干 ' + id, options: { A: '甲', B: '乙' }, answer: 'A'
});
/* latest：{ qid: { correct } }，time 随便（只要存在就代表练过） */
function withLatest(questions, correctMap) {
  const latest = {};
  for (const q of questions) {
    if (Object.prototype.hasOwnProperty.call(correctMap, q.id)) latest[q.id] = { correct: !!correctMap[q.id], time: 1 };
  }
  return latest;
}
/* 40 题：20 错题（b1:0）、10 已掌握（b1:1 全对 → 章节 100%）、10 没练过（b1:2） */
function quotaSet() {
  const questions = [], correct = {};
  for (let i = 1; i <= 20; i++) { const q = Q('w' + i, 'b1', 0); questions.push(q); correct[q.id] = false; }
  for (let i = 1; i <= 10; i++) { const q = Q('r' + i, 'b1', 1); questions.push(q); correct[q.id] = true; }
  for (let i = 1; i <= 10; i++) questions.push(Q('f' + i, 'b1', 2));
  return { questions, latest: withLatest(questions, correct) };
}
const breakdownSum = (b) => b.wrong + b.weak + b.fresh + b.review;

const DK = '2026-10-31';

/* ============================ 1. 确定性 ============================ */
test('同参数两次 plan 结果完全相同（做一半退出再进不换题）', () => {
  const { questions, latest } = quotaSet();
  const a = Daily.plan({ questions, latest, dateKey: DK });
  const b = Daily.plan({ questions, latest, dateKey: DK });
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a.qids, b.qids);
  assert.strictEqual(a.qids.length, 8);
});

/* ============================ 2. 换日期换题 ============================ */
test('不同 dateKey 选出的题不完全相同（80 题样本，撞车概率可忽略）', () => {
  const questions = [];
  for (let i = 1; i <= 80; i++) questions.push(Q('f' + i, 'b1', 0));
  const latest = {};
  const a = Daily.plan({ questions, latest, dateKey: '2026-10-31' });
  const b = Daily.plan({ questions, latest, dateKey: '2026-11-01' });
  assert.strictEqual(a.qids.length, 8);
  assert.strictEqual(b.qids.length, 8);
  assert.notDeepStrictEqual(a.qids, b.qids, '不同日期应换一组题');
});

test('题目在入参数组里的先后不影响结果（DB 遍历顺序波动也不换题）', () => {
  const { questions, latest } = quotaSet();
  const a = Daily.plan({ questions, latest, dateKey: DK });
  const b = Daily.plan({ questions: questions.slice().reverse(), latest, dateKey: DK });
  assert.deepStrictEqual(a.qids, b.qids);
});

/* ============================ 3. 数量与唯一性 ============================ */
test('qids 无重复，数量 == 请求的 size', () => {
  const { questions, latest } = quotaSet();
  const r = Daily.plan({ questions, latest, dateKey: DK, size: 8 });
  assert.strictEqual(r.qids.length, 8);
  assert.strictEqual(new Set(r.qids).size, 8, 'qid 不能重复');
  assert.strictEqual(r.size, 8);
  const ids = new Set(questions.map(q => q.id));
  assert.ok(r.qids.every(id => ids.has(id)), 'qid 必须来自传入的题');
});

/* ============================ 4. standard 配额 ============================ */
test('standard 配额：20 错 + 10 已掌握 + 10 没练过 → wrong 3 / review 1 / fresh 4', () => {
  const { questions, latest } = quotaSet();
  const r = Daily.plan({ questions, latest, dateKey: DK });
  assert.deepStrictEqual(r.breakdown, { wrong: 3, weak: 0, fresh: 4, review: 1 });
  assert.strictEqual(r.qids.length, 8);
  assert.strictEqual(r.qids.filter(id => id[0] === 'w').length, 3);
  assert.strictEqual(r.qids.filter(id => id[0] === 'r').length, 1);
  assert.strictEqual(r.qids.filter(id => id[0] === 'f').length, 4);
});

/* ============================ 5. easy / devil 配额 ============================ */
test('easy 配额：wrong 2 / fresh 5 / review 1', () => {
  const { questions, latest } = quotaSet();
  const r = Daily.plan({ questions, latest, dateKey: DK, mode: 'easy' });
  assert.deepStrictEqual(r.breakdown, { wrong: 2, weak: 0, fresh: 5, review: 1 });
  assert.strictEqual(r.qids.length, 8);
});

test('devil 配额：wrong 4 / fresh 3 / review 1', () => {
  const { questions, latest } = quotaSet();
  const r = Daily.plan({ questions, latest, dateKey: DK, mode: 'devil' });
  assert.deepStrictEqual(r.breakdown, { wrong: 4, weak: 0, fresh: 3, review: 1 });
  assert.strictEqual(r.qids.length, 8);
});

test('未知 mode 退回 standard（不抛错、结果一致）', () => {
  const { questions, latest } = quotaSet();
  const a = Daily.plan({ questions, latest, dateKey: DK, mode: 'standard' });
  const b = Daily.plan({ questions, latest, dateKey: DK, mode: '不存在' });
  assert.deepStrictEqual(a, b);
});

/* ============================ 6. 回填 ============================ */
test('没有错题：错题配额按回填顺序用其它类别补满，breakdown 之和 == qids.length', () => {
  const questions = [], correct = {};
  for (let i = 1; i <= 10; i++) { const q = Q('r' + i, 'b1', 0); questions.push(q); correct[q.id] = true; }
  for (let i = 1; i <= 10; i++) questions.push(Q('f' + i, 'b1', 1));
  const r = Daily.plan({ questions, latest: withLatest(questions, correct), dateKey: DK });
  assert.strictEqual(r.qids.length, 8);
  assert.strictEqual(r.breakdown.wrong, 0, '没有错题就不能凭空出错题');
  assert.deepStrictEqual(r.breakdown, { wrong: 0, weak: 0, fresh: 7, review: 1 });
  assert.strictEqual(breakdownSum(r.breakdown), r.qids.length);
});

test('weak 不占配额，只在错题不够时顶上（回填顺序 wrong → weak → fresh）', () => {
  const questions = [], correct = {};
  /* b1:0 两错两对 → 章节正确率 50% < 60%：答对的那两道算 weak */
  for (let i = 1; i <= 2; i++) { const q = Q('w' + i, 'b1', 0); questions.push(q); correct[q.id] = false; }
  for (let i = 1; i <= 2; i++) { const q = Q('k' + i, 'b1', 0); questions.push(q); correct[q.id] = true; }
  for (let i = 1; i <= 8; i++) questions.push(Q('f' + i, 'b1', 1));
  const r = Daily.plan({ questions, latest: withLatest(questions, correct), dateKey: DK });
  // 错题只有 2 道（配额要 3）→ 差额先用 weak 顶满（2 道都上），再回填 fresh
  assert.deepStrictEqual(r.breakdown, { wrong: 2, weak: 2, fresh: 4, review: 0 });
  assert.strictEqual(breakdownSum(r.breakdown), r.qids.length);
  assert.strictEqual(r.qids[0][0], 'w', '题单先出错题');
  assert.strictEqual(r.qids[2][0], 'k', '错题后面才轮到 weak');
  assert.strictEqual(r.qids[4][0], 'f', 'weak 用尽后才是 fresh');
});

test('章节正确率恰好 60% 不算 weak（review 侧边界）', () => {
  const questions = [], correct = {};
  for (let i = 1; i <= 3; i++) { const q = Q('r' + i, 'b1', 0); questions.push(q); correct[q.id] = true; }
  for (let i = 1; i <= 2; i++) { const q = Q('w' + i, 'b1', 0); questions.push(q); correct[q.id] = false; }
  for (let i = 1; i <= 10; i++) questions.push(Q('f' + i, 'b1', 1));
  const r = Daily.plan({ questions, latest: withLatest(questions, correct), dateKey: DK });
  assert.strictEqual(r.breakdown.weak, 0, '3 对 2 错 = 60%，应算已掌握');
  assert.deepStrictEqual(r.breakdown, { wrong: 2, weak: 0, fresh: 5, review: 1 });
});

test('章节正确率 40% 算 weak（< 60% 侧边界）', () => {
  const questions = [], correct = {};
  for (let i = 1; i <= 2; i++) { const q = Q('k' + i, 'b1', 0); questions.push(q); correct[q.id] = true; }
  for (let i = 1; i <= 3; i++) { const q = Q('w' + i, 'b1', 0); questions.push(q); correct[q.id] = false; }
  for (let i = 1; i <= 10; i++) questions.push(Q('f' + i, 'b1', 1));
  const r = Daily.plan({ questions, latest: withLatest(questions, correct), dateKey: DK });
  assert.strictEqual(r.breakdown.wrong, 3);
  assert.strictEqual(r.breakdown.weak, 1, '错题配额已满，weak 顶上');
  assert.strictEqual(breakdownSum(r.breakdown), r.qids.length);
});

/* ============================ 7. bankId 过滤 ============================ */
test('bankId 过滤：只出该题库的题', () => {
  const questions = [], correct = {};
  for (let i = 1; i <= 10; i++) { const q = Q('a' + i, 'b1', 0); questions.push(q); correct[q.id] = false; }
  for (let i = 1; i <= 10; i++) questions.push(Q('b' + i, 'b2', 0));
  const r = Daily.plan({ questions, latest: withLatest(questions, correct), dateKey: DK, bankId: 'b2' });
  assert.strictEqual(r.qids.length, 8);
  assert.ok(r.qids.every(id => id[0] === 'b'), '不能混进 b1 的题：' + r.qids.join(','));
  assert.strictEqual(r.breakdown.wrong, 0);
});

/* ============================ 8. 题量不足 / 空 ============================ */
test('题量不足：3 题 + size 8 → 全取 3 题，size 记实际题量', () => {
  const questions = [Q('f1'), Q('f2'), Q('f3')];
  const r = Daily.plan({ questions, latest: {}, dateKey: DK, size: 8 });
  assert.strictEqual(r.qids.length, 3);
  assert.strictEqual(r.size, 3);
  assert.strictEqual(breakdownSum(r.breakdown), 3);
  assert.strictEqual(r.breakdown.fresh, 3);
});

test('同一道题被重复传进来只算一道（不占两个名额）', () => {
  const questions = [];
  for (let i = 1; i <= 5; i++) {
    questions.push(Q('f' + i, 'b1', 0));
    questions.push(Q('f' + i, 'b1', 0));
  }
  const r = Daily.plan({ questions, latest: {}, dateKey: DK, size: 8 });
  assert.strictEqual(new Set(r.qids).size, r.qids.length);
  assert.strictEqual(r.qids.length, 5);
});

test('空 questions 不抛错，返回空题单', () => {
  let r;
  assert.doesNotThrow(() => { r = Daily.plan({ questions: [], latest: {}, dateKey: DK }); });
  assert.deepStrictEqual(r, { qids: [], breakdown: { wrong: 0, weak: 0, fresh: 0, review: 0 }, size: 0 });
  /* 缺字段也不该炸 */
  assert.deepStrictEqual(Daily.plan({}), { qids: [], breakdown: { wrong: 0, weak: 0, fresh: 0, review: 0 }, size: 0 });
});

test('size 按比例缩放：size 4 与 size 16 都取满且配额方向正确', () => {
  const { questions, latest } = quotaSet();
  const small = Daily.plan({ questions, latest, dateKey: DK, size: 4 });
  assert.strictEqual(small.qids.length, 4);
  assert.deepStrictEqual(small.breakdown, { wrong: 1, weak: 0, fresh: 3, review: 0 });
  const big = Daily.plan({ questions, latest, dateKey: DK, size: 16 });
  assert.strictEqual(big.qids.length, 16);
  assert.deepStrictEqual(big.breakdown, { wrong: 6, weak: 0, fresh: 8, review: 2 });
  assert.strictEqual(breakdownSum(big.breakdown), 16);
});

test('各 mode × 各 size 的不变量：无重复、取数不超 size、breakdown 之和 == qids.length', () => {
  const { questions, latest } = quotaSet();
  for (const mode of ['standard', 'easy', 'devil']) {
    for (const size of [1, 3, 4, 8, 12, 16]) {
      const r = Daily.plan({ questions, latest, dateKey: DK, mode, size });
      assert.strictEqual(new Set(r.qids).size, r.qids.length, `${mode}/${size} 出现重复 qid`);
      assert.ok(r.qids.length <= size, `${mode}/${size} 超量`);
      assert.strictEqual(breakdownSum(r.breakdown), r.qids.length, `${mode}/${size} breakdown 与 qids 不一致`);
      assert.strictEqual(r.size, r.qids.length);
    }
  }
});

/* ============================ dateKey ============================ */
test('dateKey 用本地时区（不是 UTC），且日期键幂等', () => {
  /* 本地 2026-01-01 00:30：东八区此刻 UTC 还是 2025-12-31，用 toISOString 会差一天 */
  const local = new Date(2026, 0, 1, 0, 30, 0);
  assert.strictEqual(Daily.dateKey(local.getTime()), '2026-01-01');
  assert.strictEqual(Daily.dateKey(local), '2026-01-01');
  assert.strictEqual(Daily.dateKey('2026-10-31'), '2026-10-31');
  assert.strictEqual(Daily.dateKey(new Date(2026, 9, 31, 23, 59, 59).getTime()), '2026-10-31');
  assert.strictEqual(Daily.dateKey(new Date(2026, 0, 5, 0, 0, 0).getTime()), '2026-01-05');
  assert.strictEqual(Daily.dateKey(''), '');
});

/* ============================ streak ============================ */
const T = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();
const rec = (y, m, d, extra) => Object.assign({ at: T(y, m, d), label: '每日一练', exam: false, rows: [] }, extra);

test('streak：连续 3 天含今天 → days=3, todayDone=true', () => {
  const h = [rec(2026, 10, 31), rec(2026, 10, 30), rec(2026, 10, 29)];
  assert.deepStrictEqual(Daily.streak(h, '2026-10-31'), { days: 3, todayDone: true, lastDate: '2026-10-31' });
});

test('streak：今天没做、昨天前天做了 → days=2，不归零', () => {
  const h = [rec(2026, 10, 30), rec(2026, 10, 29)];
  assert.deepStrictEqual(Daily.streak(h, '2026-10-31'), { days: 2, todayDone: false, lastDate: '2026-10-30' });
});

test('streak：中间断一天 → 只算最近连续段', () => {
  const h = [rec(2026, 10, 31), rec(2026, 10, 30), rec(2026, 10, 28), rec(2026, 10, 27)];
  assert.deepStrictEqual(Daily.streak(h, '2026-10-31'), { days: 2, todayDone: true, lastDate: '2026-10-31' });
});

test('streak：同一天多条记录只算 1 天', () => {
  const h = [rec(2026, 10, 31, { at: T(2026, 10, 31, 8) }), rec(2026, 10, 31, { at: T(2026, 10, 31, 21) }), rec(2026, 10, 30)];
  assert.deepStrictEqual(Daily.streak(h, '2026-10-31'), { days: 2, todayDone: true, lastDate: '2026-10-31' });
  const only = [rec(2026, 10, 31, { at: T(2026, 10, 31, 8) }), rec(2026, 10, 31, { at: T(2026, 10, 31, 21) })];
  assert.deepStrictEqual(Daily.streak(only, '2026-10-31'), { days: 1, todayDone: true, lastDate: '2026-10-31' });
});

test('streak：空历史 → 0/false/null', () => {
  assert.deepStrictEqual(Daily.streak([], '2026-10-31'), { days: 0, todayDone: false, lastDate: null });
  assert.deepStrictEqual(Daily.streak(null, '2026-10-31'), { days: 0, todayDone: false, lastDate: null });
  assert.deepStrictEqual(Daily.streak(undefined, '2026-10-31'), { days: 0, todayDone: false, lastDate: null });
});

test('streak：只认 label=每日一练，普通练习/模拟考试不算', () => {
  const h = [
    rec(2026, 10, 31, { label: '练习' }),
    rec(2026, 10, 30, { label: '模拟考试' }),
    rec(2026, 10, 29, { label: '每日一练' })
  ];
  assert.deepStrictEqual(Daily.streak(h, '2026-10-31'), { days: 0, todayDone: false, lastDate: '2026-10-29' });
});

test('streak：漏练两天后昨天练了 → days=1（从昨天起算）', () => {
  const h = [rec(2026, 10, 27), rec(2026, 10, 30)];
  assert.deepStrictEqual(Daily.streak(h, '2026-10-31'), { days: 1, todayDone: false, lastDate: '2026-10-30' });
});

test('MODES 配额和都是 8（standard 基准）', () => {
  assert.deepStrictEqual(Daily.MODES.standard, { wrong: 3, fresh: 4, review: 1 });
  assert.deepStrictEqual(Daily.MODES.easy, { wrong: 2, fresh: 5, review: 1 });
  assert.deepStrictEqual(Daily.MODES.devil, { wrong: 4, fresh: 3, review: 1 });
});