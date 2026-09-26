/* ========== 文件文本提取层（Word / 文本 / 图片） ========== */
const Extractor = (() => {

  /* ---- DOCX：mammoth 提取文本；嵌入图片仅计数，正文位置标记 [图片] ----
     （v1.5：内置 Tesseract OCR 已移除——19MB 资源换不来可用的识别质量；
      v1.7：图片型题库改由 AI 视觉接口识别——extractFull 可带走嵌入图片，
      交视觉模型转写，准确率远超传统 OCR） ---- */

  function htmlToPlainText(html) {
    const ta = document.createElement('textarea');
    ta.innerHTML = html
      .replace(/<img[^>]*>/gi, '\n[图片]\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote|section)>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    return ta.value.replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
  }

  /* ---- 图片压缩：手机照片动辄 5-10MB，直接 base64 会撑爆请求 ----
     等比缩到最长边 maxSide（默认 1600px，试卷文字足够清晰），JPEG 质量 quality */
  function shrinkImage(dataUrl, maxSide = 1600, quality = 0.82) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          let { width: w, height: h } = img;
          if (w <= maxSide && h <= maxSide) return resolve(dataUrl); // 已经够小，不再压
          const scale = Math.min(maxSide / w, maxSide / h);
          const cv = document.createElement('canvas');
          cv.width = Math.round(w * scale);
          cv.height = Math.round(h * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (e) {
          resolve(dataUrl); // 压缩失败（如跨域污染）就发原图，宁多花流量不失败
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function fromDOCX(file, onProgress, opts = {}) {
    if (!window.mammoth) throw new Error('当前为精简版（未内置 Word 解析），请改用「范式导入」，或下载完整版');
    const buf = await file.arrayBuffer();
    let imgCount = 0;
    const images = [];   // v1.7：嵌图收集（dataUrl），供 AI 视觉识别兜底
    // 图片统一替换为 1px 透明占位：既保留「此处有图」标记，又避免 base64 大图占用内存
    const result = await window.mammoth.convertToHtml({ arrayBuffer: buf }, {
      convertImage: window.mammoth.images.imgElement(async (image) => {
        imgCount++;
        try {
          const b64 = await image.readAsBase64String();
          if (b64 && b64.length > 2000) { // 过滤装饰小图（横线/LOGO），大于 2KB 才可能是题目图
            images.push({ name: `图片${imgCount}`, dataUrl: `data:${image.contentType};base64,${b64}` });
          }
        } catch (e) { /* 读不出就只留标记 */ }
        return { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' };
      })
    });
    const text = htmlToPlainText(result.value);
    if (opts.full) {
      // 完整模式：调用方（导入页）自己决定图片型文档怎么兜底，这里不抛错
      return { text, images };
    }
    // 兼容模式：图片型 DOCX 仍明确报错（canon.js 的 Word 转换器等旧调用方）
    if (imgCount > 0 && text.replace(/\s|\[图片\]/g, '').length < 50) {
      throw new Error('该 Word 几乎全是图片（图片型题库）：请在「导入题库」改用 AI 视觉识别，或改用文字型题库文件');
    }
    return text;
  }

  /* ---- 统一入口 ---- */
  async function extract(file, onProgress, opts) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.docx')) {
      return fromDOCX(file, onProgress, opts);
    }
    if (name.endsWith('.doc')) {
      throw new Error('暂不支持旧版 .doc 格式，请用 Word/WPS 另存为 .docx 后重试');
    }
    if (name.endsWith('.pdf')) {
      throw new Error('已移除 PDF 解析：请先把 PDF 另存为 Word(.docx) 或文本，或用「范式导入」直接贴文本');
    }
    // txt / markdown：直接读纯文本（选择器接受 .txt/.md，不再误报「仅支持 DOCX」）
    if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) {
      return await file.text();
    }
    throw new Error('不支持的格式：' + file.name + '（支持 DOCX / TXT / MD）');
  }

  /* ---- 完整提取（v1.7）：文本 + 嵌入图片一起带走，导入页视觉识别用 ---- */
  async function extractFull(file, onProgress) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.docx')) return fromDOCX(file, onProgress, { full: true });
    if (name.endsWith('.doc')) {
      throw new Error('暂不支持旧版 .doc 格式，请用 Word/WPS 另存为 .docx 后重试');
    }
    if (name.endsWith('.pdf')) {
      throw new Error('已移除 PDF 解析：请先把 PDF 另存为 Word(.docx) 或文本，或用「范式导入」直接贴文本');
    }
    if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) {
      return { text: await file.text(), images: [] };
    }
    throw new Error('不支持的格式：' + file.name + '（支持 DOCX / TXT / MD / 图片）');
  }


  /* ---- 噪声行检测：统计出现≥3次的短行（页眉页脚）+ 关键词兜底 ----
     排除：选项行（A. 开头）、数字题号行、结构性行（章/节/题型标题——
     多章节文件里「一、单选题」每章重复出现是正常结构，绝不能当噪声删） ---- */
  function detectNoiseLines(lines) {
    const noise = new Set();
    // 结构性行：章标题 / 中文序号节标题 / 独立题型标题行
    const isStructural = t =>
      /^第\s*[一二三四五六七八九十\d]+\s*章/.test(t) ||
      /^[一二三四五六七八九十]+\s*[、.．]/.test(t) ||
      /^(单项选择题|单选题|多项选择题|多选题|不定项选择题|判断题|填空题|简答题|计算题|名词解释|论述题|选择题)\s*[：:]?\s*$/.test(t);
    // 统计重复短行
    const counts = new Map();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.length > 40) continue;
      if (/^[A-H]\s*[.、．:：)）]/.test(t)) continue; // 选项行
      if (/^\s*\d{1,3}\s*[.、．)）]/.test(t)) continue; // 数字题号行
      // 答案行 / 解析行：每道题后面都跟一行，天然「重复」，绝不能当页眉页脚删掉
      //（曾把「答案：D」当重复短行删除 → 整套题答案全丢，就是「答案扫不上」的主因）
      if (/^(?:参考答案|正确答案|标准答案|答案|答)\s*[:：]?/.test(t)) continue;
      if (/^(?:答案解析|解析|解释|说明)\s*[:：]/.test(t)) continue;
      if (isStructural(t)) continue; // 章节题型结构行
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const [t, c] of counts) if (c >= 3 && !isStructural(t)) noise.add(t);
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
    // 独立题型标题行（无中文序号，如「单选题」单独成行）——是结构行，不能并进上一行
    const isTypeTitle = s => /^(单项选择题|单选题|多项选择题|多选题|不定项选择题|判断题|填空题|简答题|计算题|名词解释|论述题|选择题)\s*[：:]?\s*$/.test(s);
    // 答案行（「答案：D    解析：…」）——必须独立，并入选项行会污染选项内容
    const isAnsLine = s => /^答案\s*[:：]/.test(s);
    for (const line of lines) {
      const t = line.trim();
      if (!t) { pendingBlank = true; continue; }
      if (merged.length) {
        const prev = merged[merged.length - 1];
        const prevEnds = /[\u4e00-\u9fffA-Za-z0-9，。；：、？！）】》""''%,:;?)]$/.test(prev);
        const nextStarts = /^[\u4e00-\u9fff]/.test(t);
        if (prevEnds && nextStarts && !isNewQ(t) && !isOpt(t) && !isSec(t) && !isChapter(t) && !isAnsHead(t) && !isTypeTitle(t) && !isAnsLine(t)) {
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
    const isTypeTitle = s => /^(单项选择题|单选题|多项选择题|多选题|不定项选择题|判断题|填空题|简答题|计算题|名词解释|论述题|选择题)\s*[：:]?\s*$/.test(s);
    const isSecLine = s => (/^[一二三四五六七八九十]\s*[、.．]\s*\S/.test(s) && !/^\s*\d/.test(s)) || isTypeTitle(s);
    const isChapter = s => /^第\s*[一二三四五六七八九十\d]+\s*章/.test(s);

    // 预扫描
    let mainStyleCount = 0;
    for (const line of lines) {
      if (mainRe.test(line) && line.trim().length > 5 && !ansHeadRe.test(line.trim())) mainStyleCount++;
    }
    const hasMainStyle = mainStyleCount >= 5;

    function isAnswerLine(line) {
      const s = line.trim();
      // 选项行（「A.xxx  B.xxx  C.xxx」）绝不是答案表行——否则含数字+字母的选项行
      // （如「A.CQ≫C0  B.CQ≪C0  C.CQ=C0  D.CQ、C0…」「A.1A  B.2A  C.5A」）
      // 会被 ansPairRe 数出 ≥3 对而整行丢弃，连带该题答案一起丢
      if (/^[A-Ha-h]\s*[.、．)）:：]/.test(s)) return false;
      // 「答案：B    解析：…」是单题答案行，绝非答案表行（答案表行是「1.C 2.A 3.B」式）。
      // 否则计算题答案里的「6.75A、3.9A」等数字+字母会被误计成答案对而整行丢弃。
      if (/^(?:答案|答)\s*[:：]/.test(s) || /(?:答案解析|解析|解释|说明)\s*[:：]/.test(s)) return false;
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
    let curChapter = null; // 当前章（单元）标题，如「第一章 磁路及变压器」
    let chapPart = 0;      // 章内隐式分组计数
    for (const line of lines) {
      const trimmed = line.trim();
      if (ansHeadRe.test(trimmed)) {
        if (cur) { items.push(cur); cur = null; }
        inAnswerZone = true;
        continue;
      }
      if (inAnswerZone) continue;
      // S1：题型小节 / 章标题。章 = 单元，必须带进节标题里——
      //     否则「第一章 xxx / 一、单选题」只剩「一、单选题」，
      //     导入后题库就没有单元了（多章同名小节还会互相混淆）
      if (isSecLine(trimmed) || isChapter(trimmed)) {
        const t = secType(trimmed);
        const isChap = isChapter(trimmed);
        if (t || isChap) {
          if (cur) { items.push(cur); cur = null; }
          secIdx++;
          curType = t;
          if (isChap) { curChapter = trimmed.slice(0, 30); chapPart = 0; }
          const title = isChap ? curChapter
            : (curChapter ? (curChapter + ' · ' + trimmed).slice(0, 60) : trimmed.slice(0, 30));
          sections.push({ secIdx, title, type: t });
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
          chapPart++;
          sections.push({ secIdx, title: curChapter ? (curChapter + ' · 第' + chapPart + '组') : null, type: null });
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
     不再要求从 A 起严格连续——解决转制文档选项乱序被整题丢弃 ---- */
  function parseOneQuestion(no, text, hintType, hintKey) {
    let t = text;
    let answer = null;

    // 0) 答案字母串归一化：兼容「ABCD」「A、B、C、D」「A,B」「A B」等写法
    const normAns = s => {
      const v = String(s || '').toUpperCase().replace(/[^A-H]/g, '');
      return v || null;
    };
    // 分隔符只允许行内空白（[ \t]），不能用 \s —— 否则「答案：A\nA．选项甲」会把下一行
    // 选项的字母 A 一起吃进来（得到 "AA"，选项行同时被破坏）——1000 题里最常见的漏扫根因
    const AT = '[A-H](?:[ \\t]*[、,，／/]?[ \\t]*[A-H]){0,7}';

    // 1) 显式答案标注（含顿号/逗号分隔的多选答案）
    const ansRes = [
      new RegExp('[（(]\\s*答案\\s*[:：]?[ \\t]*(' + AT + ')[ \\t]*[)）]'),
      new RegExp('【\\s*答案\\s*】?\\s*[:：]?[ \\t]*(' + AT + ')'),
      new RegExp('(?<![A-Za-z])答案\\s*[:：][ \\t]*(' + AT + ')(?![A-Za-z])'),
      new RegExp('(?<![A-Za-z])答\\s*[:：][ \\t]*(' + AT + ')(?![A-Za-z])'),
    ];
    for (const re of ansRes) {
      const m = t.match(re);
      if (m) { answer = normAns(m[1]); t = t.replace(m[0], ' '); break; }
    }
    if (!answer) {
      const jm = t.match(/[（(]\s*答案\s*[:：]?\s*(对|错|正确|错误)\s*[)）]/) || t.match(/答案\s*[:：]\s*(对|错|正确|错误)/);
      if (jm) { answer = /对|正确/.test(jm[1]) ? 'A' : 'B'; t = t.replace(jm[0], ' '); }
    }
    if (!answer) {
      const tm = t.match(/[（(]\s*([A-H])\s*[)）](?=\s*$|\n)/);
      if (tm) { answer = tm[1]; t = t.replace(tm[0], '（　）'); }
    }

    // 1a) 兜底：答案段带分组标签（如「单端：A、C；双端：B、D、E」）——仅当整段严格是
    //     「短标签: + 字母 + 分隔符」形状时才采纳，避免把文本型答案误当选项（宁缺毋错）
    if (!answer) {
      const seg = t.match(/(?<![A-Za-z])答案\s*[:：]\s*([^\n]{1,80}?)(?=\s*(?:答案解析|解析|解释|说明)\s*[:：]|$)/);
      if (seg) {
        const body = seg[1].trim();
        const shape = /^(?:[\u4e00-\u9fff]{1,6}\s*[:：]\s*)?[A-H](?:\s*[、,，；;／/\s]\s*(?:[\u4e00-\u9fff]{1,6}\s*[:：]\s*)?[A-H])*\s*[。.；;]?$/;
        if (shape.test(body)) {
          const letters = [...new Set(body.toUpperCase().replace(/[^A-H]/g, ''))].sort();
          if (letters.length) answer = letters.join('');
        }
      }
    }

    // 1b) 解析提取：内嵌式「答案：D    解析：…」「（解析：…）」或 Word 里最常见的
    //     「【解析】…」（无冒号）——必须在这里剔除，否则整段解析会黏进最后一个选项，
    //     既丢了讲解、又把选项内容污染掉
    let explanation = null;
    const expRes = [
      // 【解析】… / 【答案解析】…（无冒号；到下一个【标记或文末为止）
      /[【\[]\s*(?:答案解析|解析|解释|说明)\s*[】\]]\s*[:：]?\s*([\s\S]*?)\s*(?=[【\[]|$)/,
      /[（(]\s*(?:答案解析|解析|解释|说明)\s*[:：]?\s*([\s\S]*?)\s*[)）]/,
      /(?:答案解析|解析|解释|说明)\s*[:：]\s*([\s\S]+)$/,
    ];
    for (const re of expRes) {
      const m = t.match(re);
      if (m) {
        explanation = (m[1] || '').replace(/\s+/g, ' ').trim() || null;
        t = t.replace(m[0], ' ');
        break;
      }
    }

    // 2) 选项提取
    const lines = t.split('\n');
    const marks = [];
    let flat = '';
    for (const line of lines) { flat += line + '\n'; }
    // 2a) 行首选项标记（选项独立成行时最可靠；题干里的「A、B、C三相」等行内字样不会误入）
    const lineMarks = [];
    const lmRe = /(?:^|\n)[ \t　]*([A-H])\s*[.、．:：)）]\s*/g;
    let lm;
    while ((lm = lmRe.exec(flat)) !== null) {
      const letterPos = lm.index + lm[0].indexOf(lm[1]);
      lineMarks.push({ letter: lm[1], start: letterPos, markLen: lm.index + lm[0].length - letterPos });
    }
    // 剔除内容含「空答案括号」的假标记：如题干行「A、B两系统互联……（ ）。」开头的 A、
    const emptyBracket = /（\s*）|\(\s*\)|（[\s　]+）/;
    const keptLine = [];
    for (let i = 0; i < lineMarks.length; i++) {
      const from = lineMarks[i].start + lineMarks[i].markLen;
      const to = i + 1 < lineMarks.length ? lineMarks[i + 1].start : flat.length;
      const content = flat.slice(from, to);
      if (emptyBracket.test(content) && content.replace(/\s/g, '').length > 10) continue; // 是题干不是选项
      keptLine.push(lineMarks[i]);
    }
    const lineSet = [...new Set(keptLine.map(x => x.letter))].sort();
    let lineGaps = 0;
    for (let i = 1; i < lineSet.length; i++) lineGaps += lineSet[i].charCodeAt(0) - lineSet[i - 1].charCodeAt(0) - 1;
    if (lineSet.length >= 2 && lineSet[0] === 'A' && lineGaps <= 1) {
      const stem = flat.slice(0, keptLine[0].start).trim();
      const options = {};
      const seenL2 = new Set();
      const uniq2 = keptLine.filter(mk => { if (seenL2.has(mk.letter)) return false; seenL2.add(mk.letter); return true; });
      uniq2.forEach((mk, i) => {
        const from = mk.start + mk.markLen;
        const to = i + 1 < uniq2.length ? uniq2[i + 1].start : flat.length;
        options[mk.letter] = flat.slice(from, to).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      });
      if (Object.values(options).every(v => v.length > 0) && stem.length >= 5) {
        let type = 'single';
        if (hintType === 'multi' || (answer && answer.length > 1)) type = 'multi';
        const vals = Object.values(options).map(v => v.replace(/\s/g, ''));
        if (lineSet.length === 2 && /正确|对|√/.test(vals[0]) && /错误|错|×/.test(vals[1])) type = 'single';
        if (answer && [...answer].some(c => !options[c])) answer = null;
        return { no, key: hintKey, type, stem, options, answer: answer || null, explanation, _local: true, _degraded: lineGaps > 0 || keptLine.length !== uniq2.length || undefined };
      }
    }
    // 2b) 回退：行内标记（兼容「正确的是？A.xx B.yy」式行内选项）
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
          return { no, key: hintKey, type, stem, options, answer: answer || null, explanation, _local: true, _degraded: degraded || undefined };
        }
      }
    }

    // 3) 无选项 → 判断/填空（hintType 优先）
    const body = t.trim();
    if (body.length >= 5) {
      if (hintType === 'judge') {
        // 判断题：无选项结构，固定 正确/错误
        return { no, key: hintKey, type: 'judge', stem: body, options: { 'A': '正确', 'B': '错误' }, answer: answer || null, explanation, _local: true };
      }
      if (/_{3,}|_{2,}/.test(body)) {
        return { no, key: hintKey, type: 'fill', stem: body, options: null, answer: answer || null, explanation, _local: true };
      }
      if (hintType === 'fill' || /（\s*）|\(\s*\)/.test(body)) {
        return { no, key: hintKey, type: 'fill', stem: body, options: null, answer: answer || null, explanation, _local: true };
      }
      // 3a) 兜底：结构不明也别丢题（旧版此处 return null → 1000 题里总有几道「扫不上」）
      //     陈述句（无提问词、以句号收尾）→ 判断题；其余 → 填空/简答（答案自己填或 AI 解）
      if (!/^(姓名|学号|班级|专业|院系|得分|评分|考试时间|注意事项|题号|试卷|第\s*\d+\s*页)/.test(body)) {
        const asking = /简述|说明|论述|解释|为什么|如何|什么|哪些|试述|计算|证明|比较|列举|名词解释|问答|简答/.test(body);
        const type = (hintType === 'single' || hintType === 'multi') ? 'fill'
          : ((!asking && /[。.]$/.test(body)) ? 'judge' : 'fill');
        return {
          no, key: hintKey, type, stem: body,
          options: type === 'judge' ? { 'A': '正确', 'B': '错误' } : null,
          answer: answer || null, explanation, _local: true, _salvaged: true
        };
      }
    }
    return null;
  }

  return { extract, extractFull, shrinkImage, cleanText, chunk, splitQuestions, parseOneQuestion, detectNoiseLines };
})();
