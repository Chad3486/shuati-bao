const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'stats.js'), 'utf8') + '\nglobalThis.__StatsModel = StatsModel;');
const StatsModel = globalThis.__StatsModel;

test('近 7 天包含断练日期，并正确汇总答题量与正确率', () => {
  const today = new Date(2026, 10, 15);
  const days = StatsModel.recentDays({
    '2026-11-14': { total: 8, correct: 6 },
    '2026-11-15': { total: 2, correct: 1 }
  }, 7, today);
  assert.equal(days.length, 7);
  assert.equal(days[0].key, '2026-11-09');
  assert.equal(days[4].total, 0);
  assert.equal(days[5].total, 8);
  assert.equal(days[6].label, '11/15');
  assert.deepEqual(StatsModel.periodSummary(days), { total: 10, correct: 7, acc: 70 });
});

test('章节按题库与章节序号隔离，按最近一次作答计算并薄弱优先', () => {
  const banks = [
    { id: 'b1', name: '电机学', sections: [{ secIdx: 1, title: '同名章节' }] },
    { id: 'b2', name: '电力电子', sections: [{ secIdx: 1, title: '同名章节' }] }
  ];
  const questions = [
    { id: 'q1', bankId: 'b1', secIdx: 1 },
    { id: 'q2', bankId: 'b1', secIdx: 1 },
    { id: 'q3', bankId: 'b2', secIdx: 1 }
  ];
  const rows = StatsModel.chapterRows({
    q1: { correct: false, time: 2 },
    q2: { correct: true, time: 2 },
    q3: { correct: true, time: 2 },
    deleted: { correct: false, time: 3 }
  }, banks, questions);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, 'b1:1');
  assert.equal(rows[0].acc, 50);
  assert.equal(rows[1].acc, 100);
  assert.equal(rows[0].title, '同名章节');
  assert.equal(rows[1].bank, '电力电子');
});

test('掌握状态边界与界面筛选一致', () => {
  assert.deepEqual(StatsModel.mastery(0), { label: '薄弱', tone: 'weak' });
  assert.deepEqual(StatsModel.mastery(59), { label: '薄弱', tone: 'weak' });
  assert.deepEqual(StatsModel.mastery(60), { label: '待巩固', tone: 'mid' });
  assert.deepEqual(StatsModel.mastery(80), { label: '已掌握', tone: 'good' });
  assert.deepEqual(StatsModel.mastery(0, 2), { label: '样本少', tone: 'mid' });
});

test('小样本全错不会压过样本充分的薄弱章节，估算值向总体正确率收缩', () => {
  const banks = [{ id: 'b', name: '题库', sections: [{ secIdx: 1, title: '小样本' }, { secIdx: 2, title: '充分样本' }] }];
  const questions = [
    { id: 's1', bankId: 'b', secIdx: 1 }, { id: 's2', bankId: 'b', secIdx: 1 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: 'l' + i, bankId: 'b', secIdx: 2 }))
  ];
  const latest = { s1: { correct: false, time: 100 }, s2: { correct: false, time: 100 } };
  for (let i = 0; i < 8; i++) latest['l' + i] = { correct: i < 4, time: 100 };
  const rows = StatsModel.chapterRows(latest, banks, questions, { globalAcc: 60, now: 100 });
  const small = rows.find(r => r.secIdx === '1');
  const large = rows.find(r => r.secIdx === '2');
  assert.equal(rows[0].key, 'b:2');
  assert.equal(small.sampleLow, true);
  assert.equal(large.sampleLow, false);
  assert.equal(small.estimated, 40); // (0 + 60% × 4 先验) / (2 + 4)
  assert.ok(large.priority > small.priority);
});
