/* 题库体检（js/audit.js）回归测试：9 条规则每条都要「该报的报、不该报的不报」。
   跑法：node --test scripts/audit.test.js
   只依赖 js/audit.js，不联网、不碰 DB、不读文件系统。

   为什么要有它：体检最怕的不是漏报，是误报——2000 道题刷出几十条假警告，用户就不看了。
   所以每条规则都配一条「干净数据不能报」的用例；另外把判重的白名单（通用题干）、
   答案解析的否定式（不选A / 错误的是A）、全角小写答案这些真踩过的坑单独固化。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* audit.js 是浏览器 IIFE（const Audit = (() => {...})()），用间接 eval 在全局求值后取句柄 */
(0, eval)(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'audit.js'), 'utf8')
  + '\nglobalThis.__Audit = Audit;'
);
const Audit = globalThis.__Audit;

/* ---------- 造题工具 ---------- */
let seq = 0;
function q(over) {
  seq += 1;
  return Object.assign({
    id: 'test-q-' + seq,
    bankId: 'bank-test',
    no: seq,
    key: 'bank-test:' + (seq - 1),
    secIdx: 0,
    type: 'single',
    stem: '电力二极管属于（ ）器件，其导电特性是什么',
    options: { A: '不可控器件', B: '半控器件', C: '全控器件', D: '以上都不是' },
    answer: 'A',
    explanation: '电力二极管只有通断两态。'
  }, over);
}
const codes = r => r.issues.map(it => it.code);
const has = (r, code) => codes(r).includes(code);

/* 确定性伪随机题干：避免测试数据自己撞成重复题 */
function makeStem(i) {
  const alphabet = '电力电子技术题库测试器件变换电路控制信号电流电压桥式整流逆变';
  let x = (i * 1103515245 + 12345) >>> 0;
  let s = '';
  for (let j = 0; j < 20; j++) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += alphabet[x % alphabet.length];
  }
  return `第${i + 1}题 ${s}`;
}

/* ---------- 基础 API ---------- */

test('导出 bank / report / LEVELS，LEVELS 按 error→warn→info 排序', () => {
  assert.strictEqual(typeof Audit.bank, 'function');
  assert.strictEqual(typeof Audit.report, 'function');
  assert.deepStrictEqual([...Audit.LEVELS], ['error', 'warn', 'info']);
});

test('空数组：返回全 0 概览，不抛错', () => {
  const r = Audit.bank([]);
  assert.deepStrictEqual(r.summary, { error: 0, warn: 0, info: 0, total: 0, questions: 0 });
  assert.deepStrictEqual(r.issues, []);
});

test('非数组输入（null/undefined）按空题库处理，不抛错', () => {
  assert.doesNotThrow(() => Audit.bank(null));
  assert.doesNotThrow(() => Audit.bank(undefined));
  assert.strictEqual(Audit.bank(null).summary.questions, 0);
});

test('options 为 null / 单题：不抛错，且不误报选项类规则', () => {
  const r = Audit.bank([
    q({ id: 'null-opt', no: 1, options: null, answer: 'A', stem: '没有选项的题目也要能完整跑完体检' })
  ]);
  assert.strictEqual(r.summary.questions, 1);
  assert.ok(!has(r, 'ans-out-of-range'));
  assert.ok(!has(r, 'dup-option-text'));
  assert.ok(!has(r, 'missing-option-key'));
  assert.strictEqual(r.summary.error, 0);
});

test('全部缺 answer：不抛错，也不误报答案类规则', () => {
  const r = Audit.bank([
    q({ id: 'na-1', no: 1, answer: null, stem: '第一道答案缺失的题目内容足够长' }),
    q({ id: 'na-2', no: 2, answer: undefined, stem: '第二道答案缺失的题目内容足够长' })
  ]);
  assert.strictEqual(r.summary.questions, 2);
  assert.ok(!has(r, 'ans-out-of-range'));
  assert.ok(!has(r, 'single-multi-mismatch'));
  assert.ok(!has(r, 'answer-explanation-conflict'));
});

test('干净题库（单选/多选/判断/填空）：0 error 且 0 issue', () => {
  const r = Audit.bank([
    q({
      id: 'clean-1', no: 1, stem: '电力二极管属于（ ）器件，其导电特性是什么',
      options: { A: '不可控器件', B: '半控器件', C: '全控器件', D: '以上都不是' },
      answer: 'B', explanation: '电力二极管只有通断两态，属于不可控器件。'
    }),
    q({
      id: 'clean-2', no: 2, type: 'multi', stem: '下列属于全控型电力电子器件的有（ ）',
      options: { A: 'GTO', B: '晶闸管', C: 'IGBT', D: '电力二极管' },
      answer: 'AC', explanation: '晶闸管、电力二极管都不是全控型。'
    }),
    q({
      id: 'clean-3', no: 3, type: 'judge', stem: '电力二极管是可控型电力电子器件',
      options: { A: '正确', B: '错误' }, answer: 'B', explanation: '它是不可控器件。'
    }),
    q({
      id: 'clean-4', no: 4, type: 'fill', stem: 'IGBT 的中文全称是＿＿，属于＿＿控制型器件。',
      options: null, answer: '绝缘栅双极型晶体管|||电压', explanation: 'IGBT 是电压控制型器件。'
    })
  ]);
  assert.strictEqual(r.summary.error, 0);
  assert.strictEqual(r.summary.total, 0, '干净题库不该有任何 issue：' + JSON.stringify(r.issues));
});

/* ---------- 规则 1：ans-out-of-range ---------- */

test('规则命中：答案字母超出选项范围 → error', () => {
  const r = Audit.bank([
    q({
      id: 'oor-1', no: 7, type: 'multi', stem: '答案字母越界的脏数据检查题内容',
      options: { A: '甲', B: '乙', C: '丙' }, answer: 'ABCD', explanation: '略'
    })
  ]);
  assert.ok(has(r, 'ans-out-of-range'));
  const issue = r.issues.find(it => it.code === 'ans-out-of-range');
  assert.strictEqual(issue.level, 'error');
  assert.strictEqual(issue.qid, 'oor-1');
  assert.strictEqual(issue.no, 7);
  assert.match(issue.message, /D/);
  assert.ok(issue.hint.length > 0);
});

test('规则不误报：答案小写 / 全角字母，归一化后仍在选项内', () => {
  const r = Audit.bank([
    q({ id: 'oor-fp-1', no: 1, answer: 'ｃ', stem: '全角小写答案归一化后不应误报检查' }),
    q({ id: 'oor-fp-2', no: 2, answer: 'b', stem: '小写答案归一化后不应误报检查内容' })
  ]);
  assert.ok(!has(r, 'ans-out-of-range'));
});

/* ---------- 规则 2：dup-option-text ---------- */

test('规则命中：两个选项文本去空白后相同 → error', () => {
  const r = Audit.bank([
    q({
      id: 'dupopt-1', no: 2, stem: '选项内容重复的脏数据检查题',
      options: { A: '全控器件', B: ' 全控器件 ', C: '不可控器件' }, answer: 'A', explanation: '略'
    })
  ]);
  assert.ok(has(r, 'dup-option-text'));
  const issue = r.issues.find(it => it.code === 'dup-option-text');
  assert.strictEqual(issue.level, 'error');
  assert.match(issue.message, /A/);
  assert.match(issue.message, /B/);
});

test('规则不误报：选项文本不同（仅标点差异不算重复）', () => {
  const r = Audit.bank([
    q({
      id: 'dupopt-fp-1', no: 1, stem: '选项内容不同的干净题不应误报',
      options: { A: '全控器件', B: '半控器件。', C: '不可控器件' }, answer: 'A', explanation: '略'
    })
  ]);
  assert.ok(!has(r, 'dup-option-text'));
});

/* ---------- 规则 3：missing-option-key ---------- */

test('规则命中：选项只有 A、B、D，缺 C → warn', () => {
  const r = Audit.bank([
    q({
      id: 'misskey-1', no: 3, stem: '选项字母跳号的脏数据检查题',
      options: { A: '甲', B: '乙', D: '丁' }, answer: 'A', explanation: '略'
    })
  ]);
  assert.ok(has(r, 'missing-option-key'));
  const issue = r.issues.find(it => it.code === 'missing-option-key');
  assert.strictEqual(issue.level, 'warn');
  assert.match(issue.message, /缺少 C/);
});

test('规则不误报：选项 A/B/C/D 连续（乱序书写也算连续）', () => {
  const r = Audit.bank([
    q({
      id: 'misskey-fp-1', no: 1, stem: '选项字母连续的干净题不误报',
      options: { D: '丁', B: '乙', A: '甲', C: '丙' }, answer: 'A', explanation: '略'
    })
  ]);
  assert.ok(!has(r, 'missing-option-key'));
});

/* ---------- 规则 4：single-multi-mismatch ---------- */

test('规则命中：单选却有多个答案字母 → warn', () => {
  const r = Audit.bank([
    q({
      id: 'smm-1', no: 4, type: 'single', stem: '题型与答案数量不匹配的检查题',
      options: { A: '甲', B: '乙', C: '丙' }, answer: 'AC', explanation: '略'
    })
  ]);
  assert.ok(has(r, 'single-multi-mismatch'));
  const issue = r.issues.find(it => it.code === 'single-multi-mismatch');
  assert.strictEqual(issue.level, 'warn');
  assert.match(issue.message, /单选/);
});

test('规则不误报：单选 1 个字母、多选 2 个字母', () => {
  const r = Audit.bank([
    q({ id: 'smm-fp-1', no: 1, type: 'single', answer: 'A', stem: '单选题答案只有一个字母' }),
    q({ id: 'smm-fp-2', no: 2, type: 'multi', answer: 'AC', stem: '多选题答案有多个字母' })
  ]);
  assert.ok(!has(r, 'single-multi-mismatch'));
});

/* ---------- 规则 5：answer-explanation-conflict ---------- */

test('规则命中：解析写「答案：C」但答案是 B → warn', () => {
  const r = Audit.bank([
    q({
      id: 'conflict-1', no: 5, stem: '答案与解析冲突的脏数据检查题',
      options: { A: '甲', B: '乙', C: '丙' }, answer: 'B',
      explanation: '由器件特性可知，答案：C。'
    })
  ]);
  assert.ok(has(r, 'answer-explanation-conflict'));
  const issue = r.issues.find(it => it.code === 'answer-explanation-conflict');
  assert.strictEqual(issue.level, 'warn');
  assert.match(issue.message, /答案：C/);
  assert.match(issue.message, /B/);
});

test('规则不误报：否定式「不选A」「错误的是A」，中文逗号后的正文，以及多选解析只写部分答案', () => {
  const r = Audit.bank([
    q({
      id: 'conflict-fp-1', no: 1, answer: 'B', stem: '解析否定式不应误报的检查题',
      explanation: 'A项错误，不选A，正确答案是B。'
    }),
    q({
      id: 'conflict-fp-2', no: 2, type: 'multi', answer: 'AC', stem: '多选解析部分表述不算冲突',
      options: { A: '甲', B: '乙', C: '丙' }, explanation: '答案：A（C 也正确）'
    }),
    q({
      id: 'conflict-fp-3', no: 3, answer: 'A', stem: '解析逗号后正文不应被当成答案',
      explanation: '答案：A，B项错误。'
    })
  ]);
  assert.ok(!has(r, 'answer-explanation-conflict'));
});

/* ---------- 规则 6：judge-shape ---------- */

test('规则命中：判断题答案写成「对」而不是 A/B → warn', () => {
  const r = Audit.bank([
    q({
      id: 'judge-1', no: 6, type: 'judge', stem: '判断题答案写法不规范的检查题',
      options: { A: '正确', B: '错误' }, answer: '对', explanation: '略'
    })
  ]);
  assert.ok(has(r, 'judge-shape'));
  const issue = r.issues.find(it => it.code === 'judge-shape');
  assert.strictEqual(issue.level, 'warn');
  assert.match(issue.message, /A\/B/);
});

test('规则不误报：标准判断题（答案 A、选项正确/错误）', () => {
  const r = Audit.bank([
    q({
      id: 'judge-fp-1', no: 1, type: 'judge', stem: '标准判断题格式不应误报检查',
      options: { A: '正确', B: '错误' }, answer: 'A', explanation: '略'
    })
  ]);
  assert.ok(!has(r, 'judge-shape'));
});

/* ---------- 规则 7：stem-truncated ---------- */

test('规则命中：题干以「（」结尾（没写完）→ info', () => {
  const r = Audit.bank([
    q({
      id: 'stem-1', no: 8, type: 'fill', stem: '电力二极管属于不可控（',
      options: null, answer: '不可控', explanation: '略'
    })
  ]);
  assert.ok(has(r, 'stem-truncated'));
  const issue = r.issues.find(it => it.code === 'stem-truncated');
  assert.strictEqual(issue.level, 'info');
  assert.match(issue.message, /没写完/);
});

test('规则不误报：题干完整、长度足够（正常以「。」结尾）', () => {
  const r = Audit.bank([
    q({ id: 'stem-fp-1', no: 1, stem: '电力二极管属于不可控器件，其特性是什么。' })
  ]);
  assert.ok(!has(r, 'stem-truncated'));
});

/* ---------- 规则 8：empty-explanation ---------- */

test('规则命中：有答案但没有解析 → info', () => {
  const r = Audit.bank([
    q({ id: 'noexp-1', no: 9, answer: 'B', explanation: '   ' })
  ]);
  assert.ok(has(r, 'empty-explanation'));
  const issue = r.issues.find(it => it.code === 'empty-explanation');
  assert.strictEqual(issue.level, 'info');
  assert.match(issue.message, /解析/);
});

test('规则不误报：有解析不报；opts.checkExplanation=false 时整条规则关闭', () => {
  const withExp = Audit.bank([q({ id: 'noexp-fp-1', no: 1, explanation: '略。' })]);
  assert.ok(!has(withExp, 'empty-explanation'));
  const disabled = Audit.bank([q({ id: 'noexp-fp-2', no: 1, explanation: null })], { checkExplanation: false });
  assert.ok(!has(disabled, 'empty-explanation'));
});

/* ---------- 规则 9：duplicate-question ---------- */

test('规则命中：题干只差标点 → 按更小题号报一次，message 写清和第几题重复', () => {
  const r = Audit.bank([
    q({ id: 'dup-1', no: 1, stem: '电力二极管属于不可控型电力电子器件，只有通断两态' }),
    q({ id: 'dup-2', no: 2, stem: '电力二极管属于不可控型电力电子器件，只有通断两态。' })
  ]);
  const dupIssues = r.issues.filter(it => it.code === 'duplicate-question');
  assert.strictEqual(dupIssues.length, 1, '一对重复只报一次');
  assert.strictEqual(dupIssues[0].level, 'warn');
  assert.strictEqual(dupIssues[0].no, 1, '按更小的题号报');
  assert.match(dupIssues[0].message, /第 2 题/);
  assert.ok(dupIssues[0].hint.length > 0);
});

test('规则不误报：题干不同、只是同章节主题', () => {
  const r = Audit.bank([
    q({ id: 'dup-fp-1', no: 1, stem: '电力二极管属于不可控型电力电子器件，只有通断两态' }),
    q({ id: 'dup-fp-2', no: 2, stem: '晶闸管属于半控型电力电子器件，需要触发才能导通' })
  ]);
  assert.ok(!has(r, 'duplicate-question'));
});

test('通用题干白名单：选项不同的「下列说法」不能算重复', () => {
  const r = Audit.bank([
    q({
      id: 'generic-fp-1', no: 1, stem: '下列说法正确的是（ ）',
      options: { A: '甲一', B: '乙二' }, answer: 'A', explanation: '略'
    }),
    q({
      id: 'generic-fp-2', no: 2, stem: '下列说法正确的是（ ）',
      options: { A: '丙三', B: '丁四' }, answer: 'B', explanation: '略'
    })
  ]);
  assert.ok(!has(r, 'duplicate-question'));
});

test('通用题干白名单：连选项都一样时仍然要报重复', () => {
  const r = Audit.bank([
    q({
      id: 'generic-dup-1', no: 1, stem: '下列说法正确的是（ ）',
      options: { A: '甲一', B: '乙二' }, answer: 'A', explanation: '略'
    }),
    q({
      id: 'generic-dup-2', no: 2, stem: '下列说法正确的是（ ）',
      options: { A: '甲一', B: '乙二' }, answer: 'A', explanation: '略'
    })
  ]);
  assert.ok(has(r, 'duplicate-question'));
});

test('规则不误报：只差数字的同模板参数题（10Ω/20Ω）不算重复，选项也一样时才报', () => {
  const uniq = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4E00 + i * 7)).join('');
  const s1 = uniq + '在10欧姆负载条件下的测试题目内容';
  const s2 = uniq + '在20欧姆负载条件下的测试题目内容';
  const diffOptions = Audit.bank([
    q({ id: 'param-1', no: 1, stem: s1, options: { A: '甲', B: '乙' }, answer: 'A', explanation: '略' }),
    q({ id: 'param-2', no: 2, stem: s2, options: { A: '丙', B: '丁' }, answer: 'B', explanation: '略' })
  ]);
  assert.ok(!has(diffOptions, 'duplicate-question'), '同模板不同参数不能算重复');

  /* 题干只差数字、但选项完全一样，仍然要按重复报（避免白名单把真重复也放过） */
  const sameOptions = Audit.bank([
    q({ id: 'param-3', no: 1, stem: s1, options: { A: '甲', B: '乙' }, answer: 'A', explanation: '略' }),
    q({ id: 'param-4', no: 2, stem: s2, options: { A: '甲', B: '乙' }, answer: 'A', explanation: '略' })
  ]);
  assert.ok(has(sameOptions, 'duplicate-question'));
});

/* ---------- 汇总排序 / 计数 ---------- */

test('issues 排序：error → warn → info，同级别按题号升序', () => {
  const r = Audit.bank([
    q({
      id: 'sort-info', no: 1, type: 'fill', stem: '逆变电路输出波形分析填空题目',
      options: null, answer: '正弦波', explanation: null
    }),
    q({
      id: 'sort-err-1', no: 1, stem: '电力二极管反向恢复特性答案越界检查',
      options: { A: '甲', B: '乙', C: '丙' }, answer: 'D', explanation: '略'
    }),
    q({
      id: 'sort-err-2', no: 2, stem: '晶闸管触发角计算公式答案越界检查',
      options: { A: '甲', B: '乙', C: '丙' }, answer: 'D', explanation: '略'
    })
  ]);
  assert.strictEqual(r.issues[0].level, 'error');
  assert.deepStrictEqual(r.issues.filter(it => it.level === 'error').map(it => it.no), [1, 2]);
  assert.strictEqual(r.issues[r.issues.length - 1].level, 'info');
  assert.deepStrictEqual(r.summary, { error: 2, warn: 0, info: 1, total: 3, questions: 3 });
});

test('issue 结构固定：code / level / qid / no / message / hint 都有值', () => {
  const r = Audit.bank([
    q({
      id: 'shape-1', no: 11, stem: '答案越界的结构检查题目',
      options: { A: '甲', B: '乙', C: '丙' }, answer: 'D', explanation: '略'
    })
  ]);
  for (const it of r.issues) {
    assert.deepStrictEqual(Object.keys(it).sort(), ['code', 'hint', 'level', 'message', 'no', 'qid']);
    assert.strictEqual(it.qid, 'shape-1');
    assert.strictEqual(it.no, 11);
    assert.ok(it.message.length > 0 && it.hint.length > 0);
  }
});

/* ---------- Markdown 报告 ---------- */

test('report：标题 / 概览 / 题号 / 建议 / 中文分组都在', () => {
  const bank = Audit.bank([
    q({
      id: 'rep-1', no: 3, stem: '答案越界的报告检查题目',
      options: { A: '甲', B: '乙', C: '丙' }, answer: 'D', explanation: '略'
    })
  ]);
  const md = Audit.report(bank.issues, { bankName: '测试题库', date: '2026-01-02', total: 12 });
  assert.match(md, /^# 题库体检报告 · 测试题库/);
  assert.match(md, /日期：2026-01-02/);
  assert.match(md, /题目：12 道/);
  assert.match(md, /题号/);
  assert.match(md, /建议/);
  assert.match(md, /错误/);
  assert.match(md, /答案超出选项/);
  assert.match(md, /改成选项里存在的字母/);
});

test('report：空 issues 输出「未发现需要处理的问题」', () => {
  const md = Audit.report([], { bankName: '空题库', date: '2026-01-02' });
  assert.match(md, /未发现需要处理的问题/);
  assert.match(md, /\| 错误 \| 0 \|/);
});

test('report：每组最多 50 行，超出要注明省略数', () => {
  const qs = [];
  for (let i = 0; i < 55; i++) {
    qs.push(q({
      id: 'cap-' + i, no: i + 1, stem: makeStem(i),
      options: { A: '选项甲' + i, B: '选项乙' + i, C: '选项丙' + i },
      answer: 'D', explanation: '略'
    }));
  }
  const bank = Audit.bank(qs);
  const md = Audit.report(bank.issues, { bankName: '大题库', date: '2026-01-02', total: 55 });
  assert.match(md, /答案超出选项（55 条）/);
  assert.match(md, /已省略 5 条同类问题/);
});

/* ---------- 性能 ---------- */

test('5000 题 200ms 量级：宽松断言 < 400ms（防 CI 抖动）', () => {
  const alphabet = '电力电子技术题库测试器件变换电路控制信号电流电压桥式整流逆变负载';
  let seed = 20261031;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const qs = [];
  for (let i = 0; i < 5000; i++) {
    const len = 16 + Math.floor(rnd() * 24);
    let stem = '';
    for (let j = 0; j < len; j++) stem += alphabet[Math.floor(rnd() * alphabet.length)];
    qs.push({
      id: 'perf-' + i,
      bankId: 'perf',
      no: i + 1,
      key: 'perf:' + i,
      secIdx: 0,
      type: i % 5 === 0 ? 'multi' : 'single',
      stem: `第${i + 1}题 ${stem}`,
      options: { A: '选项甲' + i, B: '选项乙' + i, C: '选项丙' + i, D: '选项丁' + i },
      answer: i % 5 === 0 ? 'AC' : 'ABCD'[i % 4],
      explanation: i % 7 === 0 ? null : '解析：' + i
    });
  }
  // 取 3 次里最快的一次：机器负载抖动会让单次测量偶发超标（5000 题实际 200~300ms），
  // 但算法是线性的，最快一次就能代表真实开销
  let best = Infinity, r = null;
  for (let k = 0; k < 3; k++) {
    const started = Date.now();
    r = Audit.bank(qs);
    best = Math.min(best, Date.now() - started);
  }
  assert.strictEqual(r.summary.questions, 5000);
  assert.ok(best < 400, `5000 题体检最快一次 ${best}ms，超过 400ms 阈值`);
});