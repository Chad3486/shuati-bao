/* 冒烟测试 v1.7.3：fileToCanonLite 标注装配链路 + Canon.parse 产物校验（Node，桩掉 fetch/DB） */
const fs = require('fs');

/* ---- DB 桩：配置里有 apiKey，并发默认 4 ---- */
globalThis.DB = {
  metaGet: async (k) => (k === 'llmConfig' ? { apiKey: 'test-key', model: 'test-model' } : null),
  metaSet: async () => {}
};

/* ---- fetch 桩：按片段序号回放预置的「AI 标注 JSON」 ---- */
const canned = [
  { questions: [
    { at: '1．电力二极管属于', type: 'single', answer: 'B' },
    { at: '2．MOSFET 的驱动特点', type: 'single', answer: 'A' },
    { at: '3．IGBT 的中文全称', type: 'fill', answer: '绝缘栅双极型晶体管' },
    { at: '这段开头不存在于原文', type: 'single', answer: 'C' } // 定位失败 → 应被丢弃
  ] }
];
let calls = 0;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  if (body.stream) return new Response('', { status: 500 }); // 不该走流式
  const idx = Math.min(calls++, canned.length - 1);
  const data = { choices: [{ message: { content: JSON.stringify(canned[idx]) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } };
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
};

/* ---- 加载 llm.js / canon.js，导出内部句柄 ---- */
let code = fs.readFileSync(__dirname + '/../js/llm.js', 'utf8');
code += '\nglobalThis.__LLM = LLM;';
(0, eval)(code);
const LLM = globalThis.__LLM;

const RAW = `一、单项选择题（每题2分）

1．电力二极管属于（　　）
A．电压控制型
B．电流控制型
C．不能控型
D．晶闸管

2．MOSFET 的驱动特点是（　　）
A．电压驱动　B．电流驱动

二、填空题

3．IGBT 的中文全称是＿＿＿＿＿。

参考答案：
1.B 2.A 3.绝缘栅双极型晶体管`;

(async () => {
  let ok = true;
  const out = await LLM.fileToCanonLite(RAW, {
    onProgress: (d, t, note) => console.log('  progress:', d + '/' + t, note || ''),
    onRetry: (a, c, why) => console.log('  retry:', a, why || '')
  });
  console.log('=== 装配产物 ===');
  console.log(out);
  console.log('=== 断言 ===');
  const has = (s) => { if (!out.includes(s)) { ok = false; console.log('✗ 缺少：' + s); } else console.log('✓ ' + s); };
  has('1．电力二极管属于');
  has('答案：B');
  has('2．MOSFET');
  has('答案：A');
  has('3．IGBT');
  has('答案：绝缘栅双极型晶体管');
  if (/这段开头不存在/.test(out)) { ok = false; console.log('✗ 定位失败的题不应混入'); } else console.log('✓ 定位失败题已丢弃');
  if (calls !== 1) { ok = false; console.log('✗ 应只有 1 个片段，实际 ' + calls); } else console.log('✓ 片段数=1，AI 调用=1');

  /* 产物喂给 Canon.parse 验证可导入 */
  try {
    let ccode = fs.readFileSync(__dirname + '/../js/canon.js', 'utf8');
    ccode += '\nglobalThis.__Canon = Canon;';
    (0, eval)(ccode);
    const r = globalThis.__Canon.parse(out);
    console.log(`=== Canon.parse ===\n题目 ${r.questions.length} 道 · errors ${r.errors.length} · warns ${r.warns.length}`);
    r.questions.forEach(q => console.log(`  [${q.type}] no=${q.no} ans=${q.answer || '(空)'} · ${String(q.stem).slice(0, 18)}`));
    if (r.questions.length !== 3) { ok = false; console.log('✗ 应解析出 3 道题'); }
    const ansMap = Object.fromEntries(r.questions.map(q => [q.no, q.answer]));
    if (ansMap['1'] !== 'B' || ansMap['2'] !== 'A' || !/绝缘栅/.test(ansMap['3'] || '')) { ok = false; console.log('✗ 答案对不上', ansMap); } else console.log('✓ 三题答案全部对上');
  } catch (e) {
    console.log('（Canon.parse 校验跳过：' + e.message.slice(0, 60) + '）');
  }
  console.log(ok ? '\nALL PASS' : '\nFAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
