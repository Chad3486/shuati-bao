/* 解析器回归测试：把 v1.8.15~v1.8.19 修过的「导入踩坑」逐个固化成用例。
   跑法：node --test scripts/parse-regression.test.js
   （CI 的 build job 里会跑；只依赖 js/canon.js，不联网、不碰 DB、不读文件系统）

   为什么要有它：canon.js / extract.js 合计 70KB 正则，历史上每次发版都在修导入 bug
   （答案字母被解析污染、卷末答案表整段丢、无冒号答案不认……），一个正则的回退肉眼看不出来，
   而用户直到导完 1000 题发现全判错才知道。这里每条用例都对应一个真踩过的坑。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* canon.js 是浏览器 IIFE（const Canon = (() => {...})()），用间接 eval 在全局求值后取句柄 */
(0, eval)(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'canon.js'), 'utf8')
  + '\nglobalThis.__Canon = Canon;'
);
const Canon = globalThis.__Canon;

const parse = (text) => Canon.parse(text);
const byNo = (r) => Object.fromEntries(r.questions.map((q) => [q.no, q]));

/* ---- 1. 单选答案行带解析尾巴时，字母不能被污染（v1.8.19 硬伤 ①） ----
   旧行为：「答案：C（A项错误）」扫出 AC → 单选题升成多选 → 用户永远判错 */
test('答案：C（A项错误）→ C，且仍是单选', () => {
  const r = parse(`1. 电力二极管属于（ ）器件。
A. 不可控
B. 半控
C. 全控
答案：C（A项错误，B项是半控）
解析：只有通断两态。`);
  assert.strictEqual(r.questions.length, 1);
  const q = r.questions[0];
  assert.strictEqual(q.answer, 'C');
  assert.strictEqual(q.type, 'single');
  assert.strictEqual(q.explanation, '只有通断两态。');
});

/* ---- 2. 多选答案带解析尾巴（v1.8.19 硬伤 ①另一面） ----
   旧行为：「答案：AC（B错）」存成 ABC */
test('答案：AC（B错）→ AC，多选题不膨胀', () => {
  const r = parse(`1. 下列属于全控型器件的有（ ）。
A. GTO
B. 晶闸管
C. IGBT
答案：AC（B是半控）
解析：晶闸管是半控。`);
  const q = r.questions[0];
  assert.strictEqual(q.answer, 'AC');
  assert.strictEqual(q.type, 'multi');
});

/* ---- 3. 卷末集中答案表（v1.8.19 硬伤 ②） ----
   旧行为：「参考答案 / 1.A 2.C」整段不被识别 → 全部缺答案、不报错，
   还会凭空多出一道题号为 1 的假题 */
test('卷末答案表能回填，且不产生假题', () => {
  const r = parse(`一、单选题
1. 电力二极管属于（ ）器件。
A. 不可控
B. 半控
C. 全控
D. 以上都不是
2. 晶闸管属于（ ）器件。
A. 不可控
B. 半控
C. 全控
D. 以上都不是

参考答案
1.A
2.B`);
  assert.strictEqual(r.questions.length, 2, '不应多出假题');
  const m = byNo(r);
  assert.strictEqual(m[1].answer, 'A');
  assert.strictEqual(m[2].answer, 'B');
  assert.strictEqual(m[1].stem, '电力二极管属于（ ）器件。');
  assert.ok(r.warns.some((w) => /回填/.test(w.msg)), '应提示已从答案表回填');
});

/* ---- 4. 「答案是A」不带冒号（v1.8.19 顺手修的写法） ---- */
test('答案是A（无冒号）能识别', () => {
  const r = parse(`1. IGBT 是（ ）控制型器件。
A. 电压
B. 电流
答案是A`);
  assert.strictEqual(r.questions[0].answer, 'A');
  assert.strictEqual(r.questions[0].type, 'single');
});

/* ---- 5. 题干括号里塞答案 + 括号后还有标点（v1.8.19 修） ---- */
test('题干（答案：B）？ 能识别，答案不进题干', () => {
  const r = parse(`1. 电力二极管属于（  ）器件（答案：B）？
A. 全控
B. 不可控
解析：略`);
  const q = r.questions[0];
  assert.strictEqual(q.answer, 'B');
  assert.ok(!/答案/.test(q.stem), '题干里不应残留答案片段：' + q.stem);
  assert.strictEqual(q.explanation, '略');
});

/* ---- 6. 判断题 对/错 归一到选项字母 ---- */
test('判断题「答案：对」→ A，选项是 正确/错误', () => {
  const r = parse(`1. 电力二极管是可控器件。
答案：对`);
  const q = r.questions[0];
  assert.strictEqual(q.type, 'judge');
  assert.strictEqual(q.answer, 'A');
  assert.deepStrictEqual(q.options, { A: '正确', B: '错误' });
});

/* ---- 7. 多空填空用 ||| 分隔，不能被拆坏 ---- */
test('多空填空答案保留 ||| 分隔', () => {
  const r = parse(`1. IGBT 全称是＿＿，由＿＿控制。
答案：绝缘栅双极型晶体管|||电压`);
  assert.strictEqual(r.questions[0].type, 'fill');
  assert.strictEqual(r.questions[0].answer, '绝缘栅双极型晶体管|||电压');
});

/* ---- 8. 缺答案的题不能静默丢（答案留空 / 压根没写） ---- */
test('缺答案照常入库并计入 missing', () => {
  const r = parse(`一、单选题
1. 有答案的题（ ）。
A. 甲
B. 乙
答案：A
2. 答案留空的题（ ）。
A. 甲
B. 乙
答案：
3. 干脆没写答案的题（ ）。
A. 甲
B. 乙`);
  assert.strictEqual(r.questions.length, 3, '缺答案不应丢题');
  assert.strictEqual(r.stats.missing, 2);
  assert.strictEqual(r.errors.length, 0, '缺答案不算格式错误');
});

/* ---- 9. 显式题型标记优先于答案字母推断 ---- */
test('【多选】标记 + 单字母答案仍是多选', () => {
  const r = parse(`【多选】21. 全控型器件包括（ ）。
A. GTO
B. 晶闸管
答案：A`);
  assert.strictEqual(r.questions[0].type, 'multi');
  assert.strictEqual(r.questions[0].answer, 'A');
});