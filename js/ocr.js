/* ========== 离线 OCR（Tesseract.js 封装：优先本地资源，兜底 CDN） ========== */
const OCR = (() => {
  let workerPromise = null;
  let logSink = null;

  const LOCAL_BASES = ['libs/tesseract', 'tesseract'];
  const CDN_WORKER = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
  const CDN_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
  const CDN_LANG = 'https://tessdata.projectnaptha.com/4.0.0_fast';
  const CDN_LANG_BEST = 'https://tessdata.projectnaptha.com/4.0.0_best';
  const LANG_CDN = { chi_sim: CDN_LANG_BEST, eng: CDN_LANG };
  const PRIMARY_LANG = 'chi_sim';
  const EXTRA_LANGS = ['eng'];

  const offlineError = () => new Error(
    'OCR 未离线打包：本地 Tesseract 资源缺失，在线加载也失败。请下载完整版（内置离线 OCR），或联网后重试'
  );

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' 超时')), ms);
      promise.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); }
      );
    });
  }

  async function fetchPart(url, as) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res[as]();
  }

  async function tryFetch(url, as) {
    try { return await fetchPart(url, as); } catch (e) { return null; }
  }

  const logger = m => { if (logSink) logSink(m); };

  async function loadLangBuf(code, base) {
    for (const b of [base].concat(LOCAL_BASES.filter(x => x !== base))) {
      const buf = await tryFetch(b + '/langs/' + code + '.traineddata.gz', 'arrayBuffer');
      if (buf && buf.byteLength > 1024) return buf;
    }
    const buf = await tryFetch((LANG_CDN[code] || CDN_LANG) + '/' + code + '.traineddata.gz', 'arrayBuffer');
    return buf && buf.byteLength > 1024 ? buf : null;
  }

  function langBlobURLs(langMap) {
    const map = {};
    for (const code of Object.keys(langMap)) {
      map[code + '.traineddata.gz'] = URL.createObjectURL(new Blob([langMap[code]], { type: 'application/gzip' }));
    }
    return map;
  }

  async function createOfflineWorker(base) {
    const [wTxt, coreTxt] = await Promise.all([
      fetchPart(base + '/worker.min.js', 'text'),
      fetchPart(base + '/tesseract-core.wasm.js', 'text')
    ]);
    const langMap = {};
    const primary = await loadLangBuf(PRIMARY_LANG, base);
    if (!primary) throw new Error(PRIMARY_LANG + ' 语言包缺失');
    langMap[PRIMARY_LANG] = primary;
    for (const code of EXTRA_LANGS) {
      const buf = await loadLangBuf(code, base);
      if (buf) langMap[code] = buf;
    }
    const codes = Object.keys(langMap);
    const map = langBlobURLs(langMap);
    const shim = 'self.importScripts=function(){};\n' +
      'self.fetch=(function(f){var M=' + JSON.stringify(map) + ';return function(u){' +
      'var s=String(u||""),n=s.slice(s.lastIndexOf("/")+1);' +
      'if(s.indexOf("traineddata")>=0){return f(M[n]||M[Object.keys(M)[0]]);}' +
      'return f.apply(self,arguments);};})(self.fetch.bind(self));\n';
    const workerURL = URL.createObjectURL(new Blob([shim, coreTxt, '\n', wTxt], { type: 'text/javascript' }));
    const w = await Tesseract.createWorker(codes.join('+'), 1, {
      workerPath: workerURL,
      workerBlobURL: false,
      corePath: 'offline-core',
      langPath: 'offline-langs',
      gzip: true,
      cacheMethod: 'none',
      logger
    });
    await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
    return w;
  }

  function ensure() {
    if (!window.Tesseract) {
      return Promise.reject(new Error('当前为精简版（未内置 OCR 引擎），请下载完整版后再导入图片题库'));
    }
    if (!workerPromise) {
      workerPromise = (async () => {
        for (const base of LOCAL_BASES) {
          try {
            return await withTimeout(createOfflineWorker(base), 120000, '离线 OCR 加载');
          } catch (e) { }
        }
        try {
          const w = await withTimeout(Tesseract.createWorker(PRIMARY_LANG + '+' + EXTRA_LANGS.join('+'), 1, {
            workerPath: CDN_WORKER,
            corePath: CDN_CORE,
            langPath: CDN_LANG,
            gzip: true,
            logger
          }), 120000, '在线 OCR 加载');
          await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
          return w;
        } catch (e) {
          workerPromise = null;
          throw offlineError();
        }
      })();
    }
    return workerPromise;
  }

  /* ---- 识别前预处理：灰度 + 留白边（消融实测：插值放大/对比度拉伸会破坏字形，勿加） ---- */
  async function preprocess(blob) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return blob;
    try {
      const bmp = await createImageBitmap(blob);
      const srcW = bmp.width, srcH = bmp.height;
      if (!srcW || !srcH) return blob;
      const pad = 24;
      const cv = document.createElement('canvas');
      cv.width = srcW + pad * 2; cv.height = srcH + pad * 2;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(bmp, pad, pad, srcW, srcH);
      if (bmp.close) bmp.close();
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 + 500) / 1000 | 0;
        d[i] = d[i + 1] = d[i + 2] = g;
      }
      ctx.putImageData(img, 0, 0);
      const out = await new Promise(res => cv.toBlob(res, 'image/png'));
      return out || blob;
    } catch (e) {
      return blob;
    }
  }

  const MAX_DIM = 1600;
  const SKIP_INK = 0.004;
  const SKIP_STD = 6;
  /* 低质阈值按 115 张真实截图实测标定（std 分布 12~38，p10≈14.2）：
     只标最糊的尾部；清晰扫描件 std 多在 40+，不会误报 */
  const LOWQ_STD = 15;

  /* ---- 一次扫描：降采样 + 灰度 + 留白边 + 墨水占比/方差一次算完 ----
     返回 { skip, quality, lowQuality, blob }：skip=纯装饰/纯色图跳过；lowQuality=低质（糊/暗/淡）建议重试或人工核对 ---- */
  async function inspect(blob) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
      return { skip: false, quality: 999, lowQuality: false, blob };
    }
    try {
      const bmp = await createImageBitmap(blob);
      const w = bmp.width, h = bmp.height;
      if (!w || !h) return { skip: false, quality: 999, lowQuality: false, blob };
      const big = Math.max(w, h) > MAX_DIM;
      const sw = big ? Math.round(w * MAX_DIM / Math.max(w, h)) : w;
      const sh = big ? Math.round(h * MAX_DIM / Math.max(w, h)) : h;
      const pad = 24;
      const cv = document.createElement('canvas');
      cv.width = sw + pad * 2;
      cv.height = sh + pad * 2;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(bmp, pad, pad, sw, sh);
      if (bmp.close) bmp.close();
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const d = img.data;
      let ink = 0, sum = 0, sumSq = 0;
      const n = cv.width * cv.height;
      for (let i = 0; i < d.length; i += 4) {
        const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 + 500) / 1000 | 0;
        d[i] = d[i + 1] = d[i + 2] = g;
        if (g < 240) ink++;
        sum += g;
        sumSq += g * g;
      }
      const mean = sum / n;
      const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      ctx.putImageData(img, 0, 0);
      const out = await new Promise(res => cv.toBlob(res, 'image/png'));
      return {
        skip: ink / n < SKIP_INK && std < SKIP_STD,
        quality: std,
        lowQuality: std < LOWQ_STD,
        blob: out || blob
      };
    } catch (e) {
      return { skip: false, quality: 999, lowQuality: false, blob };
    }
  }

  async function recognize(blob, onProgress, opts) {
    logSink = onProgress
      ? m => { if (m && m.status === 'recognizing text') onProgress(m.progress || 0); }
      : null;
    try {
      const w = await ensure();
      const img = (opts && (opts.raw || opts.prepared)) ? blob : await preprocess(blob);
      const r = await w.recognize(img);
      return (r && r.data && r.data.text) || '';
    } finally {
      logSink = null;
    }
  }

  return { ensure, recognize, preprocess, inspect };
})();
