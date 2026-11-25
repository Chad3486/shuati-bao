const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ctx = vm.createContext({ console, DB: { questionsByBank: async () => { throw new Error('测试不应重复读库'); } } });
vm.runInContext(fs.readFileSync(path.join(root, 'js/quiz.js'), 'utf8') + '\nthis.__examTest = { ExamPlanner, QuizBuilder };', ctx);
const { ExamPlanner, QuizBuilder } = ctx.__examTest;

function questionsFor(bankId, secIdx, type, count, prefix = '') {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${bankId}-${secIdx}-${type}-${i}`,
    bankId, secIdx, type, answer: 'A', stem: '测试题', options: { A: '对', B: '错' }
  }));
}

function countBy(items, keyFn) {
  const out = {};
  for (const q of items) {
    const key = keyFn(q);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

test('考试按章节均衡抽题，并在每章内按题型可出量分配', () => {
  const qs = [
    ...questionsFor('b', 1, 'single', 45),
    ...questionsFor('b', 1, 'multi', 15),
    ...questionsFor('b', 2, 'single', 10),
    ...questionsFor('b', 2, 'judge', 10),
    ...questionsFor('b', 3, 'fill', 20)
  ];
  const picked = ExamPlanner.plan(qs, 30, { sampleRandom: false });
  assert.equal(picked.length, 30);
  assert.deepEqual(countBy(picked, q => q.secIdx), { 1: 10, 2: 10, 3: 10 });
  const chapter1 = picked.filter(q => q.secIdx === 1);
  const chapter2 = picked.filter(q => q.secIdx === 2);
  assert.deepEqual(countBy(chapter1, q => q.type), { single: 7, multi: 3 }); // 75%:25% 的 10 题配额，余数均摊
  assert.deepEqual(countBy(chapter2, q => q.type), { single: 5, judge: 5 });
  assert.equal(picked.filter(q => q.secIdx === 3 && q.type === 'fill').length, 10);
  assert.equal(new Set(picked.map(q => q.id)).size, 30);
});

test('小章节取满后自动把剩余名额补到其他章节', () => {
  const qs = [
    ...questionsFor('b', 1, 'single', 100),
    ...questionsFor('b', 2, 'single', 2),
    ...questionsFor('b', 3, 'single', 100)
  ];
  const picked = ExamPlanner.plan(qs, 20, { sampleRandom: false });
  assert.deepEqual(countBy(picked, q => q.secIdx), { 1: 9, 2: 2, 3: 9 });
});

test('随机组卷不重复、不修改原数组，题库不足时按实际数量', () => {
  const qs = questionsFor('b', 1, 'single', 40);
  const original = qs.slice();
  let seed = 7;
  const random = () => ((seed = seed * 16807 % 2147483647) - 1) / 2147483646;
  const picked = ExamPlanner.plan(qs, 17, { sampleRandom: true, random });
  assert.equal(picked.length, 17);
  assert.equal(new Set(picked.map(q => q.id)).size, 17);
  assert.deepEqual(qs, original);
  assert.equal(ExamPlanner.plan(qs, 100, { sampleRandom: false }).length, 40);
});

test('fromBanks 在考试模式实际应用题量，学习模式不受影响', async () => {
  const qs = questionsFor('b', 1, 'single', 60);
  const exam = await QuizBuilder.fromBanks(['b'], {
    exam: true, examSize: 25, filterType: 'answered', questionCache: { b: qs }
  });
  assert.equal(exam.total, 25);
  assert.equal(exam.exam, true);
  const learn = await QuizBuilder.fromBanks(['b'], {
    exam: false, examSize: 25, filterType: 'answered', questionCache: { b: qs }
  });
  assert.equal(learn.total, 60);
});

test('考试设置页提供题量、自定义和均衡组卷说明', () => {
  const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  for (const text of ['id="seg-count"', 'data-v="20"', 'data-v="50"', 'data-v="100"', 'data-v="all"', 'data-v="custom"', 'id="exam-count"', 'examSize', '章节尽量均衡，题型按可出题量占比分配']) {
    assert.ok(app.includes(text), `缺少：${text}`);
  }
});
