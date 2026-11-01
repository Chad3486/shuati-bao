/* 「考试系统导出」格式的回归测试（v1.8.26）
   跑法：node --test scripts/weird-format.test.js

   背景：用户丢进来一份超星/学习通式导出的 Word，App 只扫出 12 题、答案 2 个。
   三个原因，每个都固化成一条用例：
   ① 题号写成「第1题（0.5分）」，不是「1.」→ 切不出题
   ② 答案写成「【您的答案：C　正确答案：A】」→ 只认「答案：」的解析器读不到；
      而且这行每道题都出现，被「页眉页脚重复行」规则整批删掉
   ③ 题型小节写成「单选1」「多选2 专业多选」「判断题」→ 不带顿号，认不出题型
   只依赖 js/extract.js 与 js/canon.js，不联网、不碰文件系统。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

for (const [file, name] of [['extract.js', 'Extractor'], ['canon.js', 'Canon']]) {
  (0, eval)(
    fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8')
    + `\nglobalThis.__${name} = ${name};`
  );
}
const Extractor = globalThis.__Extractor;
const Canon = globalThis.__Canon;
globalThis.Extractor = Extractor;   // canon.js 的 Word 转换器会读全局 Extractor

/* 与真实文件同构的片段：单选1 / 单选2 两节（题号都从 1 开始）、答案在【】里、判断题无选项字母 */
const SAMPLE = `26Hz 暑假结营题
题目 · 答案 · 解析
单选1
第1题（0.5分）
2024年大会的主题是（
）？
A. 海上福州扬帆远航
B. 高质量共建
C. 链接全球
D. 聚力天下
【您的答案：C　正确答案：A】
解析：原文写的是 A，选 C 的错了。
第2题（0.5分）
电力系统稳定分为（）3大类。
A. 功率稳定、电压稳定和线损稳定
B. 功角稳定、电能稳定和抗扰稳定
C. 功角稳定、电压稳定和频率稳定
D. 电压稳定、电能稳定和功率稳定
【您的答案：C　正确答案：C】
解析：按导则分三大类。
单选2 专业单选
第1题（0.5分）
变压器差动保护用什么制动？
A. 二次谐波
B. 五次谐波
C. 三次谐波
D. 基波
【您的答案：B　正确答案：B】
解析：过励磁用五次谐波制动。
判断题
第1题（0.5分）
发电机并网方式分为准同期并列与自同期并列两种。（）
A. 正确
B. 错误
【您的答案：A　正确答案：A】
解析：表述正确。`;

const items = () => Extractor.splitQuestions(Extractor.cleanText(SAMPLE));

test('第N题（0.5分）能切出题，且题号连续（旧版只切出 1 块）', () => {
  const r = items();
  assert.ok(r.items.length >= 4, `切出 ${r.items.length} 题，至少要 4 题`);
  const nos = r.items.map((i) => i.no);
  assert.ok(nos.includes(1) && nos.includes(2), `题号不全：${nos.join(',')}`);
});

test('题号行不会被当页眉页脚删掉（分节重新从第1题开始是正常的）', () => {
  const noise = Extractor.detectNoiseLines(SAMPLE.split('\n'));
  const killed = [...noise].filter((l) => /^第\s*\d+\s*题/.test(l));
  assert.deepStrictEqual(killed, []);
});

test('答案取「正确答案」，不取「您的答案」', () => {
  const r = items();
  const q1 = r.items.find((i) => i.no === 1);
  const parsed = Extractor.parseOneQuestion(q1.no, q1.text, q1.type, q1.key);
  assert.strictEqual(parsed.answer, 'A'); // 您的答案是 C，正确答案是 A
  assert.strictEqual(parsed.type, 'single');
});

test('单选1 / 单选2 专业单选 / 判断题 都能认成小节与题型', () => {
  const r = items();
  const titles = r.sections.map((s) => s.title);
  assert.ok(titles.some((t) => /单选1/.test(String(t))), `小节：${titles.join(' / ')}`);
  assert.ok(titles.some((t) => /单选2/.test(String(t))), `小节：${titles.join(' / ')}`);
  const judgeSec = r.sections.find((s) => s.type === 'judge');
  assert.ok(judgeSec, '判断题小节没认出来');
});

test('判断题 → type=judge，答案为 A/B', () => {
  const r = items();
  const judge = r.items.find((i) => i.type === 'judge');
  assert.ok(judge, '没有标成 judge 的题');
  const q = Extractor.parseOneQuestion(judge.no, judge.text, judge.type, judge.key);
  assert.strictEqual(q.type, 'judge');
  assert.ok(['A', 'B'].includes(q.answer));
});

test('整条链路：Canon.convert 出的题数与答案都对得上（旧版 12 题 / 2 答案 → 现在 4 题 / 4 答案）', () => {
  const res = Canon.convert(SAMPLE);
  assert.strictEqual(res.stats.total, 4);
  assert.strictEqual(res.stats.answered, 4);
  assert.strictEqual(res.stats.missing, 0);
  const text = res.text;
  assert.ok(text.includes('答案：A'), '第 1 题答案应是 A（不是您的答案 C）');
  assert.ok(!text.includes('您的答案'), '「您的答案」不该出现在范式里');
});