/* 断点续做回归测试：serialize / restore 必须记住「这是哪种练习」。
   跑法：node --test scripts/session.test.js
   只依赖 js/quiz.js（DB 用桩），不联网、不碰真实时钟。

   为什么要有它：
   · v1.8.32 及以前只存题目和进度，从首页「继续」接着做完后，
     练习记录变成普通「练习」、每日一练也不会标完成 —— 用户看到的
     就是「退出去再进来，做完了次数不涨」。这两条断言把它钉死。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* ---- DB 桩：restore 只用到 questionGet ---- */
const store = new Map();
globalThis.DB = {
  questionGet: async id => store.get(id) || null,
  questionPut: async q => { store.set(q.id, q); },
  recordAdd: async () => {},
  uid: () => 'u' + Math.random().toString(36).slice(2, 8)
};

(0, eval)(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'quiz.js'), 'utf8')
  + '\nglobalThis.__QuizSession = QuizSession; globalThis.__QuizBuilder = QuizBuilder;'
);
const QuizSession = globalThis.__QuizSession;
const QuizBuilder = globalThis.__QuizBuilder;

function makeQs(n = 5) {
  const list = [];
  for (let i = 1; i <= n; i++) {
    const q = { id: 'q' + i, bankId: 'b1', type: 'single', stem: '题 ' + i, options: { A: '甲', B: '乙' }, answer: 'A', secIdx: 0 };
    store.set(q.id, q);
    list.push(q);
  }
  return list;
}

test('serialize 记住 mode 与每日一练身份', () => {
  const qs = makeQs(5);
  const s = new QuizSession(qs, { shuffle: false, mode: 'daily' });
  s._daily = { bankId: 'b1', date: '2026-11-04', total: 5 };
  s.answered.set('q1', { userAnswer: 'A', correct: true });
  const data = s.serialize();
  assert.strictEqual(data.mode, 'daily');
  assert.deepStrictEqual(data.daily, { bankId: 'b1', date: '2026-11-04', total: 5 });
});

test('restore 后仍是每日一练（做完才能标完成）', async () => {
  const qs = makeQs(5);
  const s = new QuizSession(qs, { shuffle: false, mode: 'daily' });
  s._daily = { bankId: 'b1', date: '2026-11-04', total: 5 };
  s.answered.set('q1', { userAnswer: 'A', correct: true });
  s.index = 2;

  const back = await QuizSession.restore(JSON.parse(JSON.stringify(s.serialize())));
  assert.strictEqual(back.opts.mode, 'daily', '恢复后模式不能丢');
  assert.deepStrictEqual(back._daily, { bankId: 'b1', date: '2026-11-04', total: 5 });
  assert.strictEqual(back.index, 2);
  assert.strictEqual(back.answered.size, 1);
  assert.strictEqual(back.answered.get('q1').correct, true);
  assert.strictEqual(back.total, 5);
});

test('旧格式存档（没有 mode / daily）也能恢复，不会抛错', async () => {
  const qs = makeQs(3);
  const s = new QuizSession(qs, { shuffle: false });
  const data = s.serialize();
  delete data.mode;
  delete data.daily;
  const back = await QuizSession.restore(data);
  assert.strictEqual(back.total, 3);
  assert.strictEqual(back._daily, undefined);
  assert.strictEqual(back.opts.mode, null);
});

test('考试身份也一起记住（交卷后结果页不误判）', async () => {
  const qs = makeQs(3);
  const s = new QuizSession(qs, { shuffle: false, exam: true, minutes: 10 });
  const back = await QuizSession.restore(JSON.parse(JSON.stringify(s.serialize())));
  assert.strictEqual(back.exam, true);
  assert.strictEqual(back.minutes, 10);
  assert.strictEqual(back.inExam, true);
});

test('fromBanks 复用设置页题目缓存，填空筛选正确且不再读库', async () => {
  const qs = [
    { id: 'fill-ok', bankId: 'cache-bank', type: 'fill', stem: '填空：晶闸管的三个电极', options: null, answer: '阳极|||阴极|||门极', secIdx: 1 },
    { id: 'fill-none', bankId: 'cache-bank', type: 'fill', stem: '缺答案填空', options: null, answer: null, secIdx: 1 },
    { id: 'single-ok', bankId: 'cache-bank', type: 'single', stem: '单选', options: { A: '甲', B: '乙' }, answer: 'A', secIdx: 1 }
  ];
  let reads = 0;
  globalThis.DB.questionsByBank = async () => { reads++; throw new Error('使用缓存时不应再次读库'); };
  const s = await QuizBuilder.fromBanks(['cache-bank'], {
    filterType: 'fill|answered', shuffle: false, questionCache: { 'cache-bank': qs }
  });
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.list[0].id, 'fill-ok');
  assert.strictEqual(reads, 0);
});