// 构建单文件版：node build-single.mjs
// 把所有 CSS/JS 内联进一个 HTML，可发送到手机浏览器直接打开使用
import { readFile, writeFile, mkdir } from 'fs/promises';

const read = f => readFile(f, 'utf8');
let html = await read('index.html');

// 内联 CSS
{
  const m = html.match(/<link rel="stylesheet" href="([^"]+)">/);
  const css = await read(m[1]);
  html = html.replace(m[0], `<style>\n${css}\n</style>`);
}

// 内联 JS（转义 </script> 防止破坏标签）
{
  const re = /<script src="([^"]+)"><\/script>/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    let code = await read(m[1]);
    code = code.replace(/<\/script>/gi, '<\\/script>');
    out += html.slice(last, m.index) + `<script>\n${code}\n</script>`;
    last = m.index + m[0].length;
  }
  out += html.slice(last);
  html = out;
}

// PDF worker 以 Blob URL 提供（在所有库之后执行，覆盖 extract.js 里的相对路径设置）
{
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

await mkdir('dist', { recursive: true });
await writeFile('dist/刷题宝-单文件版.html', html);
console.log('OK -> dist/刷题宝-单文件版.html (' + (html.length / 1024).toFixed(0) + ' KB)');
