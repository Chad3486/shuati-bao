/* 能力估分回归测试：把 js/ability.js 的算法口径（1PL 收敛、预测卷、区间、及格概率、
   章节分、各种边界）逐个固化成用例。
   跑法：node --test scripts/ability.test.js
   （只依赖 js/ability.js，不联网、不碰 DB、不读文件系统）

   为什么要有它：能力估分是「纯本地算出来的一个数」，界面上没法人工核对对错——
   学习率改了、去均值忘了补 theta、抽卷顺序不确定，都只会让分数悄悄偏几百名次，
   用户看到的只是「怎么一直估我 50 分」。这里每条用例对应一个必须成立的口径。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* ability.js 是浏览器 IIFE（const Ability = (() => {...})()），用间接 eval 在全局求值后取句柄 */
(0, eval)(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'ability.js'), 'utf8')
  + '\nglobalThis.__Ability = Ability;'
);
const Ability = globalThis.__Ability;

const SIG = (x) => 1 / (1 + Math.exp(-x));

/* ---- 合成数据工具 ---- */
let seq = 0;   // 保证每题 id 全局唯一（题库里 id 就是主键，重了会把题覆盖掉）
function bank(n, opts = {}) {
  const { bankId = 'b1', type = 'single', secIdx = 1, noFrom = 1 } = opts;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: 'q' + (++seq), bankId, no: noFrom + i, secIdx, type,
      options: { A: '甲', B: '乙', C: '丙', D: '丁' }, answer: 'A', explanation: ''
    });
  }
  return out;
}

/* 固定种子线性同余伪随机：同一 seed 永远生成同一串作答，测试才可复现（不碰 Math.random） */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
/* θ_true 能力的人答这批题 → 逐题 ok/bad（确定性） */
function responses(qs, theta, seed) {
  const p = SIG(theta), r = rng(seed);
  return qs.map((q) => ({ qid: q.id, status: r() < p ? 'ok' : 'bad' }));
}
const allOk = (qs) => qs.map((q) => ({ qid: q.id, status: 'ok' }));
const allBad = (qs) => qs.map((q) => ({ qid: q.id, status: 'bad' }));
const est = (o) => Ability.estimate(o);
const finiteAll = (v) => typeof v === 'number' && Number.isFinite(v);

/* ---- 1. 合成数据能估回能力：30 题、θ_true=1.2、b=0，按 p 确定性生成作答 ----
   口径：1PL 回放 + b 去均值后，theta 应落在 θ_true 的 ±0.5 内（30 个观测的理论标准差 ≈0.43，
   所以这条用例挑了「实际正确率正好 23/30」的那串种子，才谈得上能测出偏差） */
test('合成数据能估回能力：|theta - 1.2| < 0.5', () => {
  const qs = bank(30);
  const rows = responses(qs, 1.2, 183);
  const ok = rows.filter((r) => r.status === 'ok').length;
  assert.strictEqual(ok, 23, '这串确定性作答应恰好 23 对 7 错，实际 ' + ok);
  const r = est({ questions: qs, rows });
  assert.strictEqual(r.insufficient, false);
  assert.strictEqual(r.n, 30);
  assert.ok(Math.abs(r.theta - 1.2) < 0.5, 'theta=' + r.theta + '（应≈1.2）');
});

/* ---- 2. 能力值随正确率单调：同样的题，答对得越多 theta 越大 ---- */
test('theta 随正确率单调递增', () => {
  const qs = bank(60);
  const thetas = [10, 20, 30, 40, 50, 60].map((k) => {
    const rows = qs.map((q, i) => ({ qid: q.id, status: i < k ? 'ok' : 'bad' }));
    return est({ questions: qs, rows }).theta;
  });
  for (let i = 1; i < thetas.length; i++) {
    assert.ok(thetas[i] > thetas[i - 1],
      '答对 ' + (i + 1) * 10 + ' 题时 theta 应更大：' + thetas.map((x) => x.toFixed(2)).join(' < '));
  }
});

/* ---- 3. 全对 → 预计分趋近 100；全错 → 趋近 0 ---- */
test('全对趋近 100 分，全错趋近 0 分', () => {
  const qs = bank(30);
  const hi = est({ questions: qs, rows: allOk(qs) });
  const lo = est({ questions: qs, rows: allBad(qs) });
  assert.ok(hi.theta > 1.5, '全对应估出高能力，实际 ' + hi.theta);
  assert.ok(lo.theta < -1.5, '全错应估出低能力，实际 ' + lo.theta);
  assert.ok(hi.predicted.score >= 90, '全对预计分应趋近 100，实际 ' + hi.predicted.score);
  assert.ok(lo.predicted.score <= 10, '全错预计分应趋近 0，实际 ' + lo.predicted.score);
  assert.ok(hi.predicted.score <= 100 && lo.predicted.score >= 0, '分数必须 clamp 在 0~100');
});

/* ---- 4. 预测分随能力单调：同一份题库，全对的 score 必须高于全错 ---- */
test('预计分随能力单调：全对 > 全错', () => {
  const qs = bank(30);
  const hi = est({ questions: qs, rows: allOk(qs) }).predicted.score;
  const lo = est({ questions: qs, rows: allBad(qs) }).predicted.score;
  assert.ok(hi > lo, '全对 ' + hi + ' 应 > 全错 ' + lo);
  // 中间的：对一半的分数要夹在两者之间
  const half = qs.map((q, i) => ({ qid: q.id, status: i % 2 ? 'ok' : 'bad' }));
  const mid = est({ questions: qs, rows: half }).predicted.score;
  assert.ok(mid > lo && mid < hi, '一半正确应居中：' + [lo, mid, hi].join(' < '));
});

/* ---- 5. rows 不足 minRows（默认 30）→ insufficient=true，但仍然给数值、不抛错 ---- */
test('rows < 30 → insufficient，且照样返回可用数值', () => {
  const qs = bank(30);
  const rows = responses(qs, 1.2, 183).slice(0, 29);
  const r = est({ questions: qs, rows });
  assert.strictEqual(r.insufficient, true);
  assert.strictEqual(r.n, 29);
  assert.ok(finiteAll(r.theta));
  assert.ok(finiteAll(r.predicted.score) && finiteAll(r.predicted.low) && finiteAll(r.predicted.high));
  assert.ok(finiteAll(r.predicted.passRate));
  // 正好 30 条就够线
  assert.strictEqual(est({ questions: qs, rows: responses(qs, 1.2, 183) }).insufficient, false);
  // minRows 可覆盖
  const few = responses(qs, 1.2, 183).slice(0, 10);
  assert.strictEqual(est({ questions: qs, rows: few, opts: { minRows: 10 } }).insufficient, false);
  assert.strictEqual(est({ questions: qs, rows: few, opts: { minRows: 99 } }).insufficient, true);
});

/* ---- 6. 区间：low ≤ score ≤ high，且都在 0~100 ---- */
test('预计分区间 low ≤ score ≤ high，且 0~100', () => {
  const qs = bank(30);
  const cases = [
    [],                                                   // 空记录
    allOk(qs),                                            // 全对（区间贴着 100 封顶）
    allBad(qs),                                           // 全错（贴着 0）
    responses(qs, 0.4, 7),                                // 中间带
    responses(qs, 2.5, 11)                                // 很高
  ];
  for (const rows of cases) {
    const p = est({ questions: qs, rows }).predicted;
    assert.ok(finiteAll(p.low) && finiteAll(p.score) && finiteAll(p.high), JSON.stringify(p));
    assert.ok(p.low <= p.score && p.score <= p.high, '区间反了：' + JSON.stringify(p));
    for (const v of [p.low, p.score, p.high]) assert.ok(v >= 0 && v <= 100, '越界：' + v);
    assert.ok(p.high - p.low <= 16, '半宽上限 8：' + JSON.stringify(p));
    assert.ok(Number.isInteger(p.score), '预计分应是整数');
  }
});

/* ---- 7. 及格概率：clamp 在 0.01~0.99，全对 > 0.8，全错 < 0.2 ---- */
test('passRate 在 0.01~0.99，全对 > 0.8、全错 < 0.2', () => {
  const qs = bank(30);
  const hi = est({ questions: qs, rows: allOk(qs) }).predicted;
  const lo = est({ questions: qs, rows: allBad(qs) }).predicted;
  const mid = est({ questions: qs, rows: responses(qs, 1.2, 183) }).predicted;
  assert.ok(hi.passRate > 0.8, '全对及格概率应 >0.8，实际 ' + hi.passRate);
  assert.ok(lo.passRate < 0.2, '全错及格概率应 <0.2，实际 ' + lo.passRate);
  assert.ok(hi.passRate < 1, '不允许出现 100%：' + hi.passRate);   // 全对也 clamp 到 0.99
  assert.ok(lo.passRate > 0, '不允许出现 0%：' + lo.passRate);
  for (const p of [hi, lo, mid]) {
    assert.ok(p.passRate >= 0.01 && p.passRate <= 0.99, 'passRate 越界：' + p.passRate);
  }
  // 及格概率随预计分单调
  assert.ok(hi.passRate > mid.passRate && mid.passRate > lo.passRate, 'passRate 应随分数单调');
});

/* ---- 8. sections：分数与题目实际通过率方向一致 + title/n/key 口径 ----
   数据：两节交错作答（A 节 3 轮全对、B 节 3 轮全错），交错可避开「最近的作答权重更大」，
   否则 A 节先答完、B 节的连错会把 theta 整体拖低，A、B 分数会被一起压扁 */
test('sections 分数方向与实际通过率一致，title/n 正确', () => {
  const qa = bank(10, { secIdx: 1 });
  const qb = bank(10, { secIdx: 2, noFrom: 11 });
  const long = '第七章 电力电子器件';
  const rows = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 10; i++) {
      rows.push({ qid: qa[i].id, status: 'ok' });
      rows.push({ qid: qb[i].id, status: 'bad' });
    }
  }
  const r = est({
    questions: qa.concat(qb),
    rows,
    opts: { sectionTitle: new Map([['b1:1', long]]) }
  });
  assert.strictEqual(r.sections.length, 2, '两节都应出分');
  const a = r.sections.find((s) => s.key === 'b1:1');
  const b = r.sections.find((s) => s.key === 'b1:2');
  assert.ok(a && b, 'sections 缺节：' + JSON.stringify(r.sections));
  assert.strictEqual(a.title, long, 'Map 里给了标题就用它');
  assert.strictEqual(b.title, '第 2 节', '没给标题时回退「第 N 节」');
  assert.strictEqual(a.bankId, 'b1');
  assert.strictEqual(a.n, 30, 'A 节作答 30 次');
  assert.strictEqual(b.n, 30, 'B 节作答 30 次');
  assert.ok(a.score > b.score, '全对那节分数应更高：' + a.score + ' vs ' + b.score);
  assert.ok(a.score > 50 && b.score < 50, '方向要对：' + a.score + '/' + b.score);
  assert.ok(a.score <= 100 && b.score >= 0);
});

/* ---- 9. 边界：空 rows / 空 questions / qid 缺失 / answer 为 null / 入参不是数组 → 都不抛错 ---- */
test('各种空/脏数据都不抛错', () => {
  const qs = bank(30);
  const dirty = [
    { questions: qs, rows: [] },
    { questions: [], rows: allOk(qs) },
    { questions: qs, rows: [{ qid: '不存在的题', status: 'ok' }, { qid: null, status: 'bad' }] },
    { questions: qs, rows: [null, undefined, {}, { qid: qs[0].id }] },
    { questions: null, rows: null },
    {},
    undefined,
    null
  ];
  for (const input of dirty) {
    const r = est(input);
    assert.ok(r && r.predicted, '必须返回完整结构');
    assert.ok(finiteAll(r.theta), 'theta 必须是有限数');
    assert.ok(finiteAll(r.predicted.score), 'score 必须是有限数');
    assert.ok(Array.isArray(r.sections));
    assert.ok(r.items && typeof r.items === 'object');
  }
  // 同一批题重复传入（合并题库时常见）不能把预测卷撑大
  const dup = est({ questions: qs.concat(qs), rows: allOk(qs) });
  assert.strictEqual(dup.predicted.paperSize, 10);
  // answer 为 null 的题照常参与（判定只依赖 status，不依赖 answer 字段）
  const noAns = qs.map((q) => Object.assign({}, q, { answer: null }));
  const r = est({ questions: noAns, rows: allOk(noAns) });
  assert.strictEqual(r.n, 30);
  assert.ok(r.theta > 1.5);
});

/* ---- 10. 确定性：同样输入调两次，结果完全一致 ---- */
test('同样输入两次调用结果完全一致', () => {
  const qs = bank(40);
  const rows = responses(qs, 0.7, 5).concat(responses(qs, 0.7, 5).slice(0, 15));
  const r1 = est({ questions: qs, rows });
  const r2 = est({ questions: qs, rows: rows.slice() });
  assert.deepStrictEqual(r1, r2);
});

/* ---- 11. 抽预测卷是确定性的：题库乱序不影响结果，卷型决定题量 ---- */
test('预测卷抽取确定性：题库乱序结果不变，examShape 决定题量', () => {
  const mix = bank(8, { type: 'single' })
    .concat(bank(3, { type: 'multi', noFrom: 9 }))
    .concat(bank(2, { type: 'judge', noFrom: 12 }))
    .concat(bank(2, { type: 'fill', noFrom: 14 }));
  const rows = responses(mix, 1.0, 21);
  const r1 = est({ questions: mix, rows });
  const r2 = est({ questions: mix.slice().reverse(), rows });
  assert.deepStrictEqual(r1, r2, '题库顺序不该影响估分结果');
  // 缺省卷型 = DEFAULT_SHAPE 的题量和（6+2+1+1=10），库存够就正好 10 题
  assert.strictEqual(r1.predicted.paperSize, 10);
  assert.strictEqual(
    Object.keys(Ability.DEFAULT_SHAPE).reduce((s, k) => s + Ability.DEFAULT_SHAPE[k], 0), 10
  );
  // 自定义卷型：只考 3 道单选
  assert.strictEqual(est({ questions: mix, rows, examShape: { single: 3 } }).predicted.paperSize, 3);
  // 要得比库存多 → 全用上（其他题型补），不会凭空造题
  assert.strictEqual(
    est({ questions: mix, rows, examShape: { single: 50, multi: 50, judge: 50, fill: 50 } }).predicted.paperSize,
    mix.length
  );
  // 卷型全 0 / 非法 → 回退缺省卷型
  assert.strictEqual(est({ questions: mix, rows, examShape: { single: 0 } }).predicted.paperSize, 10);
  assert.strictEqual(est({ questions: mix, rows, examShape: {} }).predicted.paperSize, 10);
});

/* ---- 12. 题量不足一张卷（甚至题库为空）→ 不抛错，paperSize = 实际题量 ---- */
test('题库不够一张卷也不抛错', () => {
  const qs = bank(2);
  const r = est({ questions: qs, rows: allOk(qs) });
  assert.strictEqual(r.predicted.paperSize, 2);
  assert.ok(finiteAll(r.predicted.score) && r.predicted.score <= 100);
  const empty = est({ questions: [], rows: [] });
  assert.strictEqual(empty.predicted.paperSize, 0);
  assert.ok(finiteAll(empty.predicted.score), '题库为空也要给个数（UI 自己决定展不展示）');
});

/* ---- 13. 未作答（status:'none'）不算答错：不计入能力更新 ---- */
test('status=none 的未作答行不计入能力，不当作答错', () => {
  const qs = bank(30);
  const answered = responses(qs, 1.2, 183);
  const withNone = answered.concat(qs.map((q) => ({ qid: q.id, status: 'none' })));
  const a = est({ questions: qs, rows: answered });
  const b = est({ questions: qs, rows: withNone });
  assert.strictEqual(a.theta, b.theta, '未作答不该改变 theta');
  assert.deepStrictEqual(a.items, b.items);
  assert.strictEqual(b.n, withNone.length, 'n 仍是传入行数');
  assert.strictEqual(
    est({ questions: qs, rows: qs.map((x) => ({ qid: x.id, status: 'none' })) }).theta, 0,
    '一条有效作答都没有时 theta 保持初始 0'
  );
});

/* ---- 14. items：只列作答过的题，b 有限、n 累加（同一题多次作答） ---- */
test('items 里每题 b/n 口径正确', () => {
  const qs = bank(30);
  const rows = [
    { qid: qs[0].id, status: 'ok' },
    { qid: qs[0].id, status: 'ok' },
    { qid: qs[0].id, status: 'bad' },
    { qid: qs[1].id, status: 'bad' }
  ];
  const r = est({ questions: qs, rows });
  assert.deepStrictEqual(Object.keys(r.items).sort(), [qs[0].id, qs[1].id].sort());
  assert.strictEqual(r.items[qs[0].id].n, 3, 'q1 作答 3 次');
  assert.strictEqual(r.items[qs[1].id].n, 1);
  assert.ok(finiteAll(r.items[qs[0].id].b) && finiteAll(r.items[qs[1].id].b));
  // 答得好 → 这题相对更容易（b 更小）；去均值后 b 的加权均值应为 0
  assert.ok(r.items[qs[0].id].b < r.items[qs[1].id].b, '答对的题应被估得更简单');
  let wsum = 0, wcnt = 0;
  for (const id of Object.keys(r.items)) { wsum += r.items[id].b * r.items[id].n; wcnt += r.items[id].n; }
  assert.ok(Math.abs(wsum / wcnt) < 1e-9, 'b 的加权均值应为 0（去均值后）');
});

/* ---- 15. 章节：没作答的章节不出分；secIdx 为空 → 未分节 ---- */
test('没作答的章节不出分，secIdx 空 → 未分节', () => {
  const qa = bank(5, { secIdx: 1 });
  const qb = bank(5, { secIdx: 2, noFrom: 6 });
  const r = est({ questions: qa.concat(qb), rows: allOk(qa) });
  assert.strictEqual(r.sections.length, 1, '只有答过的第 1 节出分');
  assert.strictEqual(r.sections[0].key, 'b1:1');
  assert.strictEqual(r.sections[0].n, 5);

  const noSec = bank(3, { secIdx: null });
  const r2 = est({ questions: noSec, rows: allOk(noSec) });
  assert.strictEqual(r2.sections.length, 1);
  assert.strictEqual(r2.sections[0].key, 'b1:');
  assert.strictEqual(r2.sections[0].title, '未分节');
});