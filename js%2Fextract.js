/* ========== 文件文本提取层（PDF / DOCX） ========== */
const Extractor = (() => {

  /* 配置 pdf.js worker（同目录） */
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
  }

  /* ---- PDF：逐页提取并智能合并断行 ---- */
  async function fromPDF(file, onProgress) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    let textChars = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // items 按阅读顺序拼接；换行由 hasEOL 判断
      let text = '';
      let lastY = null;
      for (const item of content.items) {
        if (!item.str) continue;
        const y = item.transform ? item.transform[5] : null;
        const sameLine = lastY !== null && y !== null && Math.abs(y - lastY) < 3;
        text += (sameLine && text && !text.endsWith(' ')) ? '' : '\n';
        text += item.str;
        if (item.hasEOL) text += '\n';
        lastY = y;
      }
      textChars += text.replace(/\s/g, '').length;
      pages.push({ text, pageIdx: i, pdfPage: page });
      if (onProgress) onProgress(i, pdf.numPages);
    }
    // 文字层字数太少 → 可能是扫描版，按页 OCR 兜底
    if (textChars < Math.max(50, pdf.numPages * 20)) {
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        try {
          const ocr = await ocrPage(p.pdfPage, (cur, tot) => {
            if (onProgress) onProgress(i + 1 + cur / tot, pdf.numPages);
          });
          if (ocr && ocr.trim().length > (p.text || '').length) {
            p.text = ocr;
          }
        } catch (e) {
          console.warn('OCR 第' + (i + 1) + '页失败:', e);
        }
      }
    }
    return pages.map(p => p.text).join('\n');
  }

  /* ---- 单页 PDF → Canvas → Tesseract.js OCR ---- */
  let _ocrReady = null;
  async function ensureOCR() {
    if (_ocrReady) return _ocrReady;
    _ocrReady = (async () => {
      if (!window.Tesseract) {
        await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js');
      }
      return window.Tesseract;
    })();
    return _ocrReady;
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  async function ocrPage(pdfPage, onProgress) {
    const Tesseract = await ensureOCR();
    const viewport = pdfPage.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    let last = 0;
    const res = await Tesseract.recognize(canvas, 'chi_sim+eng', {
      logger: m => {
        if (m.status === 'recognizing text' && onProgress) {
          const v = m.progress || 0;
          if (v - last >= 0.2) { last = v; onProgress(Math.floor(v * 9) + 1, 10); }
        }
      }
    });
    return res.data.text || '';
  }

  /* ---- DOCX：mammoth 提取纯文本 ---- */
  async function fromDOCX(file) {
    const buf = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return result.value;
  }

  /* ---- 统一入口 ---- */
  async function extract(file, onProgress) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) {
      return fromPDF(file, onProgress);
    }
    if (name.endsWith('.docx')) {
      const t = await fromDOCX(file);
      if (onProgress) onProgress(1, 1);
      return t;
    }
    if (name.endsWith('.doc')) {
      throw new Error('暂不支持旧版 .doc 格式，请用 Word/WPS 另存为 .docx 后重试');
    }
    throw new Error('不支持的格式：' + file.name + '（仅支持 PDF / DOCX）');
  }

  /* ---- 噪声行检测：统计出现≥3次的短行（页眉页脚）+ 关键词兜底 ----
     排除：选项行（A. 开头）与数字题号行 ---- */
  function detectNoiseLines(lines) {
    const noise = new Set();
    // 统计重复短行
    const counts = new Map();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.length > 40) continue;
      if (/^[A-H]\s*[.、．:：)）]/.test(t)) continue; // 选项行
      if (/^\s*\d{1,3}\s*[.、．)）]/.test(t)) continue; // 数字题号行
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const [t, c] of counts) if (c >= 3) noise.add(t);
    // 关键词兜底（即使只出现一次也是页眉页脚）
    const kw = /国家电网|统一服务热线|微信公众号|小程序|网校地址|hzdwpx|第\s*\d+\s*页/;
    for (const line of lines) {
      const t = line.trim();
      if (t.length <= 40 && kw.test(t) && !/^\s*\d{1,3}\s*[.、．)）]/.test(t)) noise.add(t);
    }
    return noise;
  }

  /* ---- 文本清洗：删噪声行 → 跨页断行合并 → 压缩空行 ---- */
  function cleanText(raw) {
    let lines = raw.replace(/\r/g, '').split('\n');
    // 1) 删噪声行
    const noise = detectNoiseLines(lines);
    lines = lines.filter(l => !noise.has(l.trim()));
    // 2) 跨页断行合并：上行以中文/字母数字/标点结尾 + 下行以中文开头，且下行不是新题号/选项/节标题/章标题/答案区头
    //    中间的空行不阻断合并（页眉页脚删除后常留空行）
    const merged = [];
    let pendingBlank = false;
    const isNewQ = s => /^\s*(\d{1,3}\s*[.、．)）]|[（(]\s*\d{1,3}\s*[)）])/.test(s);
    const isOpt = s => /^\s*[A-H]\s*[.、．:：)）]/.test(s);
    const isSec = s => /^\s*[一二三四五六七八九十][、.]/.test(s);
    const isChapter = s => /^第\s*[一二三四五六七八九十\d]+\s*章/.test(s);
    const isAnsHead = s => /^(参考答案|标准答案|答案速查|答案表|答案汇总|答案与解析|试题答案)/.test(s);
    for (const line of lines) {
      const t = line.trim();
      if (!t) { pendingBlank = true; continue; }
      if (merged.length) {
        const prev = merged[merged.length - 1];
        const prevEnds = /[\u4e00-\u9fffA-Za-z0-9，。；：、？！）】》""''%,:;?)]$/.test(prev);
        const nextStarts = /^[\u4e00-\u9fff]/.test(t);
        if (prevEnds && nextStarts && !isNewQ(t) && !isOpt(t) && !isSec(t) && !isChapter(t) && !isAnsHead(t)) {
          merged[merged.length - 1] = prev + t; // 合并时丢弃中间空行
          pendingBlank = false;
          continue;
        }
      }
      if (pendingBlank && merged.length) merged.push('');
      pendingBlank = false;
      merged.push(t);
    }
    let t = merged.join('\n');
    // 3) 压缩连续空行
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  /* ---- 智能分块：按题号边界切，避免题目被拦腰截断 ---- */
  function chunk(text, maxLen = 4000) {
    const lines = text.split('\n');
    const chunks = [];
    let cur = [];
    let curLen = 0;
    // 题号模式：行首 数字 + . 、 ． ) 之一
    const qNum = /^\s*\d{1,3}\s*[.、．)）]\s*/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isBoundary = qNum.test(line) && line.trim().length > 5; // 太短的可能只是答案表
      if (isBoundary && curLen > maxLen * 0.6) {
        chunks.push(cur.join('\n'));
        cur = [];
        curLen = 0;
      }
      cur.push(line);
      curLen += line.length + 1;
      // 硬限制（找不到题号边界时）
      if (curLen > maxLen * 1.8) {
        chunks.push(cur.join('\n'));
        cur = [];
        curLen = 0;
      }
    }
    if (cur.length) chunks.push(cur.join('\n'));
    return chunks.filter(c => c.trim().length > 0);
  }

  /* ---- 确定性切题：按题号边界把原文切成一道道题（不靠 LLM 数题） ----
     R1 子小问（1）（2）（3）并入父题；R2 答案区停切；R3 短答案行不算题
     S1 题型小节感知：「一、单选题」等行设置当前节，题号回到1时隐式开新节
     每题带 key=节序号-题号（跨节去重用，修复各节同号互相覆盖）---- */
  function splitQuestions(text) {
    const lines = text.split('\n');
    const mainRe = /^\s*(\d{1,3})\s*[.、．)）]\s*/;
    const subRe = /^[（(]\s*(\d{1,3})\s*[)）]\s*/;
    const ansPairRe = /(\d{1,3})\s*[.、．:：)]?\s*[A-H]\b/g;
    const ansHeadRe = /^(参考答案|标准答案|答案速查|答案表|答案汇总|答案与解析|试题答案|参考答案与解析)/;
    // S1：题型小节行（≤15字、不以数字开头）
    const secType = s => {
      if (s.length > 15 || /^\s*\d/.test(s)) return null;
      if (/单选|只选/.test(s) && /题/.test(s)) return 'single';
      if (/多选/.test(s)) return 'multi';
      if (/判断/.test(s)) return 'judge';
      if (/填空/.test(s)) return 'fill';
      return null;
    };
    const isSecLine = s => /^[一二三四五六七八九十]\s*[、.．]\s*\S/.test(s) && !/^\s*\d/.test(s);
    const isChapter = s => /^第\s*[一二三四五六七八九十\d]+\s*章/.test(s);

    // 预扫描
    let mainStyleCount = 0;
    for (const line of lines) {
      if (mainRe.test(line) && line.trim().length > 5 && !ansHeadRe.test(line.trim())) mainStyleCount++;
    }
    const hasMainStyle = mainStyleCount >= 5;

    function isAnswerLine(line) {
      let c = 0; const re = new RegExp(ansPairRe.source, 'g');
      while (re.exec(line) !== null) c++;
      return c >= 3;
    }
    function isAnswerEntry(line) {
      const m = line.match(/^\s*(\d{1,3})\s*[.、．:：)）]?\s*([A-H]{1,4})(?![A-Za-z])/);
      if (!m) return false;
      return line.slice(m.index + m[0].length).trim().length < 25;
    }

    let inAnswerZone = false;
    const items = [];
    const sections = [];   // 节信息（供题库分组显示：{secIdx, title, type}）
    let cur = null;
    let secIdx = 0;        // 节序号（每节自增）
    let curType = null;    // 当前节题型提示
    let lastQNo = 0;       // 上一题号（检测回到1）
    for (const line of lines) {
      const trimmed = line.trim();
      if (ansHeadRe.test(trimmed)) {
        if (cur) { items.push(cur); cur = null; }
        inAnswerZone = true;
        continue;
      }
      if (inAnswerZone) continue;
      // S1：题型小节 / 章标题
      if (isSecLine(trimmed) || isChapter(trimmed)) {
        const t = secType(trimmed);
        if (t || isChapter(trimmed)) {
          if (cur) { items.push(cur); cur = null; }
          secIdx++;
          curType = t;
          sections.push({ secIdx, title: trimmed.slice(0, 30), type: t });
          lastQNo = 0; // 显式节标题后重置题号，防止下一题 no=1 误触发隐式开节
          continue;
        }
      }
      if (isAnswerLine(line)) { if (cur) { items.push(cur); cur = null; } continue; }
      if (isAnswerEntry(line)) { if (cur) { items.push(cur); cur = null; } continue; }

      const m = line.match(mainRe);
      const sm = line.match(subRe);
      const isMainQ = m && trimmed.length > 5;
      if (isMainQ) {
        const no = +m[1];
        // 隐式开新节：题号回到 1（且之前已到过更大号）
        if (no === 1 && lastQNo > 1) {
          secIdx++;
          curType = null; // 隐式节无类型提示
          sections.push({ secIdx, title: null, type: null });
        }
        lastQNo = no;
        if (cur) items.push(cur);
        cur = { no, secIdx, type: curType, key: secIdx + '-' + no, text: [line.replace(mainRe, '')] };
      } else if (sm && (!hasMainStyle || !cur)) {
        const no = +sm[1];
        if (no === 1 && lastQNo > 1) { secIdx++; curType = null; }
        lastQNo = no;
        if (cur) items.push(cur);
        cur = { no, secIdx, type: curType, key: secIdx + '-' + no, text: [line.replace(subRe, '')] };
      } else if (hasMainStyle && sm && cur) {
        cur.text.push(line);
      } else if (cur) {
        cur.text.push(line);
        if (cur.text.join('\n').length > 4000) { items.push(cur); cur = null; }
      }
    }
    if (cur) items.push(cur);

    // 清洗：去尾部空行；过滤太短的
    const out = items
      .map(it => ({ no: it.no, secIdx: it.secIdx, key: it.key, type: it.type, text: it.text.join('\n').replace(/\s+$/g, '').trim() }))
      .filter(it => it.text.replace(/\s/g, '').length >= 8);

    // problems：按节报告重号/缺号
    const problems = [];
    const bySec = new Map();
    for (const it of out) {
      if (!bySec.has(it.secIdx ?? 0)) bySec.set(it.secIdx ?? 0, []);
      bySec.get(it.secIdx ?? 0).push(it.no);
    }
    for (const [sec, nos] of bySec) {
      const sorted = [...nos].sort((a, b) => a - b);
      const dup = sorted.filter((n, i) => i > 0 && sorted[i - 1] === n);
      const miss = [];
      if (sorted.length >= 5) {
        for (let i = sorted[0]; i <= sorted[sorted.length - 1]; i++) {
          if (!sorted.includes(i)) miss.push(i);
        }
      }
      if (dup.length || miss.length) {
        problems.push({ sec, dupNos: [...new Set(dup)], missingNos: miss });
      }
    }

    // 兼容旧字段：全局缺号/重号（供提示用）
    const allNos = out.map(q => q.no).sort((a, b) => a - b);
    const globalDup = allNos.filter((n, i) => i > 0 && allNos[i - 1] === n);
    return { items: out, total: out.length, dupNos: [...new Set(globalDup)], missingNos: [], problems, sections };
  }

  /* ---- 本地单题解析：正则直接提取题干/选项/答案（零 API 调用） ----
     hintType：小节题型提示（judge 节 → 判断题，options 固定正确/错误）
     hintKey：小节-题号（透传到结果，供跨节去重）
     选项采用集合校验：去重排序后以 A 开头、最多缺 1 个中间字母即可（标 _degraded），
     不再要求从 A 起严格连续——解决 PDF 转制选项乱序被整题丢弃 ---- */
  function parseOneQuestion(no, text, hintType, hintKey) {
    let t = text;
    let answer = null;

    // 1) 显式答案标注
    const ansRes = [
      /[（(]\s*答案\s*[:：]?\s*([A-H]{1,4})\s*[)）]/,
      /【\s*答案\s*】?\s*[:：]?\s*([A-H]{1,4})/,
      /(?<![A-Za-z])答案\s*[:：]\s*([A-H]{1,4})(?![A-Za-z])/,
      /(?<![A-Za-z])答\s*[:：]\s*([A-H]{1,4})(?![A-Za-z])/,
    ];
    for (const re of ansRes) {
      const m = t.match(re);
      if (m) { answer = m[1]; t = t.replace(m[0], ''); break; }
    }
    if (!answer) {
      const jm = t.match(/[（(]\s*答案\s*[:：]?\s*(对|错|正确|错误)\s*[)）]/) || t.match(/答案\s*[:：]\s*(对|错|正确|错误)/);
      if (jm) { answer = /对|正确/.test(jm[1]) ? 'A' : 'B'; t = t.replace(jm[0], ''); }
    }
    if (!answer) {
      const tm = t.match(/[（(]\s*([A-H])\s*[)）](?=\s*$|\n)/);
      if (tm) { answer = tm[1]; t = t.replace(tm[0], '（　）'); }
    }

    // 2) 选项提取：集合校验（允许乱序/缺1个中间字母）
    const lines = t.split('\n');
    const marks = [];
    let flat = '';
    for (const line of lines) { flat += line + '\n'; }
    const optMarkRe = /([A-H])\s*[.、．:：)）]\s*/g;
    let m2;
    while ((m2 = optMarkRe.exec(flat)) !== null) {
      const before = flat[m2.index - 1];
      // 行首 / 空白 / 标点后的字母标记才算选项（含"正确的是？A."这类行内选项）
      if (m2.index === 0 || before === '\n' || /\s/.test(before) || /[，。；、：？！”』）】》,:;?)]$/.test(before)) {
        marks.push({ letter: m2[1], start: m2.index, markLen: m2[0].length });
      }
    }
    // 同字母多次出现只留第一个（按文本流位置）
    const seenL = new Set();
    const uniqMarks = marks.filter(mk => {
      if (seenL.has(mk.letter)) return false;
      seenL.add(mk.letter);
      return true;
    }).sort((a, b) => a.start - b.start);
    const letters = uniqMarks.map(x => x.letter);
    const hadDup = marks.length !== uniqMarks.length; // 同字母标记重复出现

    // 集合校验：含 A、按字母序、最多缺 1 个中间字母（缺字母/重复标记 → _degraded 残缺题；乱序但齐全 → 正常保留）
    const sortedSet = [...new Set(letters)].sort();
    if (sortedSet.length >= 2 && sortedSet[0] === 'A') {
      let gaps = 0;
      for (let i = 1; i < sortedSet.length; i++) {
        gaps += sortedSet[i].charCodeAt(0) - sortedSet[i - 1].charCodeAt(0) - 1;
      }
      if (gaps <= 1) {
        const degraded = gaps > 0 || hadDup;
        // 内容按文本流位置切分、按字母赋值
        const stem = flat.slice(0, uniqMarks[0].start).trim();
        const options = {};
        uniqMarks.forEach((mk, i) => {
          const from = mk.start + mk.markLen;
          const to = i + 1 < uniqMarks.length ? uniqMarks[i + 1].start : flat.length;
          options[mk.letter] = flat.slice(from, to).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        });
        if (Object.values(options).every(v => v.length > 0) && stem.length >= 5) {
          let type = 'single';
          if (hintType === 'multi' || (answer && answer.length > 1)) type = 'multi';
          const vals = Object.values(options).map(v => v.replace(/\s/g, ''));
          if (letters.length === 2 && /正确|对|√/.test(vals[0]) && /错误|错|×/.test(vals[1])) {
            type = 'single';
          }
          if (answer && [...answer].some(c => !options[c])) answer = null;
          return { no, key: hintKey, type, stem, options, answer: answer || null, explanation: null, _local: true, _degraded: degraded || undefined };
        }
      }
    }

    // 3) 无选项 → 判断/填空（hintType 优先）
    const body = t.trim();
    if (body.length >= 5) {
      if (hintType === 'judge') {
        // 判断题：无选项结构，固定 正确/错误
        return { no, key: hintKey, type: 'judge', stem: body, options: { 'A': '正确', 'B': '错误' }, answer: answer || null, explanation: null, _local: true };
      }
      if (/_{3,}|_{2,}/.test(body)) {
        return { no, key: hintKey, type: 'fill', stem: body, options: null, answer: answer || null, explanation: null, _local: true };
      }
      if (hintType === 'fill' || /（\s*）|\(\s*\)/.test(body)) {
        return { no, key: hintKey, type: 'fill', stem: body, options: null, answer: answer || null, explanation: null, _local: true };
      }
      return null; // 结构不明，交 AI
    }
    return null;
  }

  return { extract, cleanText, chunk, splitQuestions, parseOneQuestion, detectNoiseLines };
})();
