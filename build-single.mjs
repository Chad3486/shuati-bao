// 构建单文件版：node build-single.mjs
// 产出两个文件：
//   dist/刷题宝-单文件版.html       完整版（含 Word 解析）
//   dist/刷题宝-单文件版-精简.html  精简版（去掉 Word 解析，体积更小，用「范式导入」贴文本）
import { readFile, writeFile, mkdir, copyFile, cp } from 'fs/promises';

const read = f => readFile(f, 'utf8');

// 精简版跳过的大体积库（Word 解析），去掉后体积更小（用「范式导入」贴文本即可）
const HEAVY = ['libs/mammoth.browser.min.js', 'libs/tesseract.min.js'];

async function build(lite) {
  let html = await read('index.html');

  // 内联 CSS
  {
    const m = html.match(/<link rel="stylesheet" href="([^"]+)">/);
    const css = await read(m[1]);
    html = html.replace(m[0], `<style>\n${css}\n</style>`);
  }

  // 内联 JS（转义 </script> 防止破坏标签）
  {
    let out = '';
    let last = 0;
    let m;
    const re = /<script src="([^"]+)"><\/script>/g;
    while ((m = re.exec(html)) !== null) {
      out += html.slice(last, m.index);
      last = m.index + m[0].length;
      if (lite && HEAVY.includes(m[1])) continue; // 精简版：跳过重库
      let code = await read(m[1]);
      code = code.replace(/<\/script>/gi, '<\\/script>');
      out += `<script>\n${code}\n</script>`;
    }
    out += html.slice(last);
    html = out;
  }

  if (lite) html = html.replace('<title>刷题宝</title>', '<title>刷题宝 · 精简版</title>');
  return html;
}

await mkdir('dist', { recursive: true });

const full = await build(false);
await writeFile('dist/刷题宝-单文件版.html', full);
console.log('OK -> dist/刷题宝-单文件版.html (' + (full.length / 1024).toFixed(0) + ' KB)');

const lite = await build(true);
await writeFile('dist/刷题宝-单文件版-精简.html', lite);
console.log('OK -> dist/刷题宝-单文件版-精简.html (' + (lite.length / 1024).toFixed(0) + ' KB)');

const ASSETS_DIR = 'apk-src/app/src/main/assets';
await mkdir(ASSETS_DIR, { recursive: true });
await copyFile('dist/刷题宝-单文件版.html', ASSETS_DIR + '/app.html');
console.log('OK -> ' + ASSETS_DIR + '/app.html (' + (full.length / 1024).toFixed(0) + ' KB)');
await cp('libs/tesseract', ASSETS_DIR + '/tesseract', { recursive: true, force: true });
console.log('OK -> ' + ASSETS_DIR + '/tesseract/（OCR 离线资源）');