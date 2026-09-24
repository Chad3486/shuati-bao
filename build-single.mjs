// 构建单文件版：node build-single.mjs
// 产出两个文件：
//   dist/刷题宝-单文件版.html       完整版（含 PDF / Word 解析，约 2.2MB）
//   dist/刷题宝-单文件版-精简.html  精简版（去掉 PDF / Word 解析，约 250KB，体积小不易被截断）
import { readFile, writeFile, mkdir } from 'fs/promises';

const read = f => readFile(f, 'utf8');

// 精简版跳过的大体积库（PDF / Word 解析），去掉后体积从 ~2.2MB 降到 ~250KB
const HEAVY = ['libs/pdf.min.js', 'libs/mammoth.browser.min.js'];

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

  // PDF worker 以 Blob URL 提供（在所有库之后执行，覆盖 extract.js 里的相对路径设置）
  if (!lite) {
    const workerCode = await read('libs/pdf.worker.min.js');
    const workerJson = JSON.stringify(workerCode).replace(/<\/script>/gi, '<\\/script>');
    const shim = `<script>
(function(){
  try {
    var blob = new Blob([${workerJson}], {type:'application/javascript'});
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch(e) { console.warn('PDF worker inline failed:', e); }
})();
</script>`;
    html = html.replace('</body>', shim + '\n</body>');
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