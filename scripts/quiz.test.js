/* 答题会话单元测试（Node 直跑，无依赖）：node scripts/quiz.test.js
   覆盖 quiz.js 里最容易改坏的纯逻辑：判分 / 乱序 / 考试交卷 / 续做还原。
   DB 用桩，不碰 IndexedDB。 */
const fs = require('fs');
const path = require('path');

/* ---------- 极简测试框架 ---------- */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, { actual, expected });
}
function group(name) { console.log('\n【' + name + '】'); }

/* ---------- DB 桩 ---------- */
const store = { questions: new Map(), records: [] };
globalThis.DB = {
  recordAdd: async (r) => { store.records.push(r); },
  questionGet: async (id) => store.questions.get(id) || null,
  questionsByBank: async (bankId) => [...store.questions.values()].filter(q => q.bankId === bankId),
  wrongQuestions: async () => [...store.questions.values()]
};

/* ---------- 加载 quiz.js（IIFE 外注入全局句柄） ---------- */
let code = fs.readFileSync(path.join(__dirname, '..', 'js/quiz.js'), 'utf8');
code += '\nglobalThis.__QuizSession = QuizSession; globalThis.__QuizBuilder = QuizBuilder;';
(0, eval)(code);
const QuizSession = globalThis.__QuizSession;
const QuizBuilder = globalThis.__QuizBuilder;

/* ---------- 构造题目 ---------- */
let seq = 0;
const mk = (type, answer, opts = {}) => ({
  id: type + (++seq), bankId: opts.bankId || 'b1', type, answer,
  options: type === 'judge' ? { A: '正确', B: '错误' } : type === 'fill' ? null : { A: '甲', B: '乙', C: '丙', D: '丁' },
  stem: '题干' + seq, secIdx: opts.secIdx ?? 0
});
const ids = list => list.map(q => q.id);
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

(async () => {
  /* ================= 乱序 ================= */
  group('乱序');
  {
    const qs = Array.from({ length: 30 }, () => mk('single', 'A'));
    const beforeIds = ids(qs);
    const ordered = new QuizSession(qs, { shuffle: false });
    eq('shuffle:false 保持原顺序', ids(ordered.list), ids(qs));

    let setAlwaysSame = true, everChanged = false;
    for (let i = 0; i < 40; i++) {
      const s = new QuizSession(qs, { shuffle: true });
      if (!sameSet(ids(s.list), ids(qs))) setAlwaysSame = false;
      if (JSON.stringify(ids(s.list)) !== JSON.stringify(ids(qs))) everChanged = true;
      if (s.list.length !== qs.length) setAlwaysSame = false;
    }
    ok('shuffle:true 不增不减、集合不变', setAlwaysSame);
    ok('shuffle:true 确实会打乱（40 次里至少一次顺序不同）', everChanged);
    eq('乱序不改动原数组', ids(qs), beforeIds);
  }

  /* ================= 判分：单选 / 多选 ================= */
  group('判分 · 单选/多选');
  {
    const single = mk('single', 'B');
    ok('小写 b 判对（大小写不敏感）', QuizSession.judge(single, 'b') === true);
    ok('A 判错', QuizSession.judge(single, 'A') === false);

    const multi = mk('multi', 'ABD');
    ok('多选顺序无关：DBA = ABD', QuizSession.judge(multi, 'DBA') === true);
    ok('多选少选判错', QuizSession.judge(multi, 'AB') === false);
    ok('多选多选判错', QuizSession.judge(multi, 'ABCD') === false);
    ok('多选带分隔符仍判对', QuizSession.judge(multi, 'A,B,D') === true);
  }

  /* ================= 判分：判断（曾把「对/错」判成永远正确） ================= */
  group('判分 · 判断');
  {
    const j = mk('judge', 'A');
    ok('标准答案 A，选 A 判对', QuizSession.judge(j, 'A') === true);
    ok('标准答案 A，选 B 判错', QuizSession.judge(j, 'B') === false);

    // 回归：历史数据里可能存在中文答案（对/错）。归一化后两边都是空串，
    // 绝不能因为「都空」就判对。
    const legacyYes = { id: 'jx', bankId: 'b1', type: 'judge', answer: '对', options: { A: '正确', B: '错误' } };
    ok('中文答案「对」：选 对 判对', QuizSession.judge(legacyYes, '对') === true);
    ok('中文答案「对」：选 错 必须判错', QuizSession.judge(legacyYes, '错') === false);
  }

  /* ================= 判分：填空 ================= */
  group('判分 · 填空');
  {
    const f = mk('fill', '绝缘栅双极型晶体管');
    ok('忽略空格与标点', QuizSession.judge(f, ' 绝缘栅双极型晶体管。') === true);
    ok('错字判错', QuizSession.judge(f, '绝缘栅双极晶体管') === false);

    const two = mk('fill', '甲|||乙');
    ok('多空按 ||| 逐空比对', QuizSession.judge(two, '甲|||乙') === true);
    ok('多空顺序颠倒判错', QuizSession.judge(two, '乙|||甲') === false);
    ok('用户没按格式分空时整体比对', QuizSession.judge(two, '甲乙') === false);
  }

  /* ================= 学习模式提交 ================= */
  group('学习模式 · submit');
  {
    store.records.length = 0;
    const q1 = mk('single', 'A');
    const s = new QuizSession([q1]);
    const r = s.submit('A');
    eq('判对并回传答案', { correct: r.correct, answer: r.answer }, { correct: true, answer: 'A' });
    eq('写入 1 条答题记录', store.records.length, 1);
    eq('重复提交同一题不再写记录', (s.submit('B'), store.records.length), 1);
    eq('进度 done/correct 正确', { done: s.progress.done, correct: s.progress.correct }, { done: 1, correct: 1 });

    const noAns = mk('single', '');
    const s2 = new QuizSession([noAns]);
    eq('缺答案：不判分、不写记录', (s2.submit('A'), { rec: store.records.length, ans: s2.answered.size }), { rec: 1, ans: 0 });
  }

  /* ================= 考试模式 ================= */
  group('考试模式 · answer/grade');
  {
    store.records.length = 0;
    const qs = [mk('single', 'A'), mk('single', 'B'), mk('single', 'C')];
    const s = new QuizSession(qs, { exam: true, minutes: 30 });
    eq('考试中 deadline 已设', s.deadline > Date.now(), true);

    s.answer('A'); s.next();
    s.answer('A'); s.next();          // 第 2 题答错
    // 第 3 题不答
    eq('作答不判分：correct 仍为 0', s.progress.correct, 0);
    eq('作答不写记录', store.records.length, 0);

    const res = s.grade();
    eq('交卷：total/answered/correct/wrong/unanswered',
      { t: res.total, a: res.answered, c: res.correct, w: res.wrong, u: res.unanswered },
      { t: 3, a: 2, c: 1, w: 1, u: 1 });
    eq('交卷后写入 2 条记录（未答不计）', store.records.length, 2);
    ok('正确率按总题数算（1/3 → 33%）', res.acc === 33, res.acc);
    eq('grade 幂等：再交卷不重复写', (s.grade(), store.records.length), 2);
    eq('wrongList 含答错与未答', s.wrongList().length, 2);
  }

  /* ================= 断点续做 ================= */
  group('续做 · serialize/restore');
  {
    const qs = [mk('single', 'A'), mk('single', 'B'), mk('single', 'C')];
    qs.forEach(q => store.questions.set(q.id, q));
    const s = new QuizSession(qs, { exam: true, minutes: 10 });
    s.answer('A'); s.next(); s.answer('B'); s.next(); s.answer('C');

    const data = JSON.parse(JSON.stringify(s.serialize()));
    const back = await QuizSession.restore(data);
    eq('题序与进度还原', { total: back.total, index: back.index }, { total: 3, index: 2 });
    eq('考试作答还原（含未交卷）', back.examAnswers.size, 3);
    eq('考试态还原', back.inExam, true);

    const graded = await QuizSession.restore({ ...data, graded: true });
    eq('已交卷状态还原', graded.inExam, false);
  }

  /* ================= 组卷筛选 ================= */
  group('组卷 · QuizBuilder.fromBanks');
  {
    const a1 = mk('single', 'A', { bankId: 'bk' });
    const a2 = mk('multi', '', { bankId: 'bk' });      // 选择题但缺答案
    const a3 = mk('fill', '答案', { bankId: 'bk' });
    [a1, a2, a3].forEach(q => store.questions.set(q.id, q));

    eq('choice 只留选择题', (await QuizBuilder.fromBanks(['bk'], { filterType: 'choice' })).total, 2);
    eq('choice|answered 只留有答案的选择题', (await QuizBuilder.fromBanks(['bk'], { filterType: 'choice|answered' })).total, 1);

    const secQs = [
      { ...a1, id: 'sec0', secIdx: 0 },
      { ...a1, id: 'sec1', secIdx: 1 }
    ];
    secQs.forEach(q => store.questions.set(q.id, q));
    const picked = await QuizBuilder.fromBanks(['bk'], { secKeys: new Set(['bk:1']) });
    eq('按章节筛选', ids(picked.list).sort(), ['sec1']);
  }

  /* ================= 汇总 ================= */
  console.log('\n' + (fail ? '❌ FAILED' : '✅ ALL PASS') + ` — ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });