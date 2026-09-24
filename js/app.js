/* ========== 主应用：hash 路由 + 页面渲染 ========== */
const App = (() => {
  const VERSION = '1.3.3';   // 与 apk-src/app/build.gradle 的 versionName 保持一致
  let session = null; // 当前答题会话

  const $view = () => document.getElementById('view');
  const $topbar = () => document.getElementById('topbar');
  const $tabbar = () => document.getElementById('tabbar');

  /* ================= 路由 ================= */
  const routes = {
    '': pageHome, 'home': pageHome,
    'canon': pageCanon,
    'import': pageImport,
    'answers': pageAnswers,
    'bank': pageBankQuestions,
    'recycle': pageRecycle,
    'quiz-setup': pageQuizSetup,
    'quiz': pageQuiz,
    'quiz-result': pageQuizResult,
    'wrong': pageWrong,
    'stats': pageStats,
    'settings': pageSettings
  };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, ...params] = h.split('/');
    return { path: path || 'home', params };
  }

  function navigate(hash) { location.hash = hash; }

  function render() {
    const { path, params } = parseHash();
    clearExamTimer();   // 离开答题页就停掉倒计时，避免计时器写已移除的 DOM
    const page = routes[path] || pageHome;
    const tabs = ['home', 'quiz-setup', 'wrong', 'stats', 'settings'];
    const active = tabs.includes(path) ? path : (path.startsWith('quiz') ? 'quiz-setup' : 'home');
    renderTabbar(active);
    page(params);
    window.scrollTo(0, 0);
  }

  /* ================= 通用 UI ================= */
  function topbar(title, back = null) {
    $topbar().innerHTML = `
      ${back ? `<button class="topbar-back" onclick="App.navigate('${back}')">‹</button>` : '<span class="topbar-spacer"></span>'}
      <span class="topbar-title">${title}</span>
      <span class="topbar-spacer"></span>`;
    $topbar().classList.toggle('has-back', !!back);
  }

  function renderTabbar(active) {
    const items = [
      ['home', '题库', 'M4 6h16M4 12h16M4 18h10'],
      ['quiz-setup', '练习', 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4'],
      ['wrong', '错题', 'M12 8v4m0 4h.01M12 3l9 16H3l9-16z'],
      ['stats', '统计', 'M4 20V10m6 10V4m6 16v-7m4 7H2'],
      ['settings', '设置', 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z']
    ];
    $tabbar().innerHTML = items.map(([id, label, d]) => {
      const on = id === active;
      return `<button class="tab ${on ? 'on' : ''}" onclick="App.navigate('#/${id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>
        <span>${label}</span></button>`;
    }).join('');
  }

  function toast(msg, ms = 2200) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  function confirmDialog(msg) { return window.confirm(msg); }

  /* ---- 文件小工具（浏览器 / APK 通用） ---- */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const url = fr.result || '';
        const i = url.indexOf(',');
        resolve(i >= 0 ? url.slice(i + 1) : '');
      };
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  }

  /* 保存文本文件：APK 走 JS 桥接写系统 Download 目录，浏览器走 <a download> */
  async function saveTextFile(fileName, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const bridge = typeof window !== 'undefined' && window.AndroidBridge;
    const isApk = bridge && typeof bridge.isAvailable === 'function' && bridge.isAvailable();
    if (isApk) {
      const b64 = await blobToBase64(blob);
      if (!b64) throw new Error('文件内容为空');
      const res = ('' + (bridge.saveFile(fileName, b64) || '')).trim();
      if (res.startsWith('OK:')) return { path: res.slice(3) };
      if (res.startsWith('NEED_PERMISSION:')) throw new Error(res.slice(16) + '（授予后再点一次）');
      throw new Error(res || '原生保存失败');
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    return { path: fileName };
  }

  /* 读任意题库文件为纯文本（.txt/.md 直读；PDF/DOCX 走提取器） */
  async function readAnyText(file) {
    const n = file.name.toLowerCase();
    if (/\.(txt|md|markdown|text)$/.test(n)) return await file.text();
    return await Extractor.extract(file);
  }

  /* 复制到剪贴板（APK WebView 可能没有 clipboard API，降级用临时 textarea） */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 降级 */ }
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(t);
      return ok;
    } catch (e) { return false; }
  }

  const typeLabel = { single: '单选', multi: '多选', judge: '判断', fill: '填空' };

  /* ---- 主题：auto 跟随系统 / light / dark，存 meta，class 驱动 ---- */
  async function applyTheme() {
    const t = (await DB.metaGet('theme')) || 'auto';
    const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = t === 'dark' || (t === 'auto' && sysDark);
    document.documentElement.classList.toggle('dark', dark);
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute('content', dark ? '#12151d' : '#1652f0');
    return t;
  }

  /* ---- 断点续做：进度自动保存 ---- */
  let _saveTimer = null;
  function saveProgress() {
    if (!session || !session.list.length) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
      try { await DB.metaSet('lastSession', session.serialize()); } catch (e) { /* 静默 */ }
    }, 400);
  }
  async function resumeLast() {
    const data = await DB.metaGet('lastSession');
    if (!data || !data.ids?.length) return false;
    session = await QuizSession.restore(data);
    if (!session.total) return false;
    navigate('#/quiz');
    return true;
  }

  /* ---- 考试倒计时 / 交卷 ---- */
  let examTimer = null;
  function clearExamTimer() { if (examTimer) { clearInterval(examTimer); examTimer = null; } }
  function fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function tickExamTimer() {
    const el = document.getElementById('exam-timer');
    if (!el || !session || !session.inExam || !session.deadline) return;
    const left = session.deadline - Date.now();
    el.textContent = '⏱ ' + fmtClock(left);
    el.classList.toggle('warn', left <= 60000);
    if (left <= 0) submitExam(true);
  }
  function startExamTimer() {
    clearExamTimer();
    tickExamTimer();
    examTimer = setInterval(tickExamTimer, 1000);
  }
  /** 交卷：统一判分 → 出成绩单（auto=true 为时间到自动交卷） */
  function submitExam(auto) {
    if (!session) return navigate('#/quiz-setup');
    if (!session.inExam) return navigate('#/quiz-result');
    if (!auto) {
      const left = session.total - session.progress.done;
      const msg = left ? `确定交卷？还有 ${left} 题未作答（未答按错计）。` : '确定交卷？已全部作答。';
      if (!confirmDialog(msg)) return;
    }
    clearExamTimer();
    const r = session.grade();
    DB.metaSet('lastSession', null);
    toast(auto ? '时间到，已自动交卷' : `已交卷 · ${r.acc} 分`);
    navigate('#/quiz-result');
  }

  /* ================= 页面：题库首页 ================= */
  async function pageHome() {
    topbar('我的题库');
    const banks = await DB.bankList();
    const total = banks.reduce((s, b) => s + (b.count || 0), 0);
    const last = await DB.metaGet('lastSession');
    const recycle = await DB.recycleList();

    // 每库缺答案数 + 章节数（各一次遍历）
    const info = {};
    await Promise.all(banks.map(async b => {
      const qs = await DB.questionsByBank(b.id);
      info[b.id] = { noAns: qs.filter(q => !q.answer).length, secs: (b.sections || []).length };
    }));

    // 列表工具状态：题库多时不用一直往下翻（搜索 + 排序 + 折叠）
    let sortBy = 'recent', keyword = '', expanded = false;
    const LIMIT = 6;

    $view().innerHTML = `
      <div class="hero">
        <div class="hero-num">${total}</div>
        <div class="hero-label">总题量 · ${banks.length} 个来源文件</div>
      </div>
      ${last ? `
      <div class="card" style="display:flex;align-items:center;gap:10px;border-left:4px solid var(--primary)">
        <div style="flex:1">
          <b>上次练习</b>
          <div class="muted small">第 ${Math.min(last.index + 1, last.ids.length)} / ${last.ids.length} 题，点右侧继续</div>
        </div>
        <button class="btn primary" onclick="App.resumeLast()">继续</button>
        <button class="btn ghost" onclick="App.clearProgress()">重来</button>
      </div>` : ''}
      <button class="btn primary big" onclick="App.navigate('#/canon')">范式导入（答案零对齐 · 推荐）</button>
      <button class="btn ghost big" onclick="App.navigate('#/import')">导入文件（PDF / Word 自动解析）</button>
      ${recycle.length ? `<button class="btn ghost big" onclick="App.navigate('#/recycle')">🗑 回收站（${recycle.length}）</button>` : ''}
      ${banks.length > LIMIT ? `
      <div class="list-tools">
        <input id="bank-search" class="search-input" placeholder="搜索题库名称…" value="">
        <div class="chips" id="bank-sort">
          <button class="chip on" data-v="recent">最近导入</button>
          <button class="chip" data-v="name">按名称</button>
          <button class="chip" data-v="count">按题量</button>
        </div>
      </div>` : ''}
      <div class="bank-list" id="bank-list"></div>
      <button class="btn ghost big" id="bank-more" style="display:none"></button>`;

    const listEl = document.getElementById('bank-list');
    const moreBtn = document.getElementById('bank-more');
    const searchEl = document.getElementById('bank-search');
    const sortEl = document.getElementById('bank-sort');

    function matched() {
      const kw = keyword.trim().toLowerCase();
      let arr = banks.filter(b => !kw || String(b.name).toLowerCase().includes(kw));
      if (sortBy === 'name') arr = arr.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
      else if (sortBy === 'count') arr = arr.slice().sort((a, b) => (b.count || 0) - (a.count || 0));
      else arr = arr.slice().sort((a, b) => b.createdAt - a.createdAt);
      return arr;
    }

    function cardHtml(b) {
      const na = info[b.id]?.noAns || 0;
      const secs = info[b.id]?.secs || 0;
      return `
        <div class="bank-card">
          <div class="bank-main" onclick="App.startBank('${b.id}')">
            <div class="bank-name">${escapeHtml(b.name)}</div>
            <div class="bank-meta">${b.count || 0} 题${secs ? ` · ${secs} 章` : ''} · ${new Date(b.createdAt).toLocaleDateString()}${na ? ` · <b style="color:var(--bad)">${na} 题缺答案</b>` : ''}</div>
          </div>
          ${b.count ? `<button class="bank-del" style="color:var(--primary)" onclick="App.navigate('#/bank/${b.id}')">选题</button>` : ''}
          ${b.count ? `<button class="bank-del" style="color:${na ? 'var(--bad)' : 'var(--primary)'}" onclick="App.navigate('#/answers/${b.id}')">${na ? '补答案' : '答案校验'}</button>` : ''}
          <button class="bank-del" onclick="App.renameBank('${b.id}')">改名</button>
          <button class="bank-del" onclick="App.delBank('${b.id}')">删除</button>
        </div>`;
    }

    function renderList() {
      const arr = matched();
      const show = expanded ? arr : arr.slice(0, LIMIT);
      listEl.innerHTML = arr.length
        ? show.map(cardHtml).join('') + (arr.length > LIMIT && !expanded
          ? `<div class="muted small center">已显示 ${show.length} / ${arr.length} 个题库</div>` : '')
        : `<div class="empty" style="padding:30px 0">没有匹配的题库<br><span class="muted small">清空搜索框可看全部</span></div>`;
      if (!moreBtn) return;
      if (arr.length > LIMIT) {
        moreBtn.style.display = '';
        moreBtn.textContent = expanded ? '收起列表' : `展开全部 ${arr.length} 个题库`;
      } else moreBtn.style.display = 'none';
    }

    if (searchEl) searchEl.oninput = () => { keyword = searchEl.value; expanded = false; renderList(); };
    if (sortEl) sortEl.onclick = (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      sortEl.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      sortBy = b.dataset.v;
      renderList();
    };
    if (moreBtn) moreBtn.onclick = () => { expanded = !expanded; renderList(); };
    renderList();
  }

  async function startBank(id) {
    session = await QuizBuilder.fromBanks([id], { filterType: 'answered' });
    if (!session.total) {
      const qs = await DB.questionsByBank(id);
      if (qs.length) return toast(`${qs.length} 题均缺答案，请先「补答案」`);
      return toast('该题库暂无题目');
    }
    navigate('#/quiz');
  }

  async function delBank(id) {
    const b = await DB.bankGet(id);
    if (!confirmDialog(`删除题库「${b.name}」及其全部题目？`)) return;
    await DB.bankDelete(id);
    render();
    toast('已删除');
  }

  async function renameBank(id) {
    const b = await DB.bankGet(id);
    if (!b) return;
    const name = prompt('修改题库名称：', b.name);
    if (name === null) return;
    const n = name.trim().slice(0, 40);
    if (!n) return toast('名称不能为空');
    await DB.bankRename(id, n);
    render();
    toast('已改名');
  }

  /* ================= 页面：范式导入（零对齐 · 一题一块答案随题） ================= */
  let canonParsed = null;   // 最近一次「解析预览」的结果（文本框一改就失效）

  function pageCanon() {
    topbar('范式导入', '#/home');
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">范式 · 一题一块，答案跟着题目走</div>
        <p class="muted small">答案直接写在题目里（<b>答案：B</b>），导入时<b>不需要任何「答案对齐」</b>——不再有扫不上的题；1000 题也是一次线性扫描，零 API 调用、秒级完成。</p>
        <div class="btn-row">
          <button class="btn ghost" id="canon-spec-btn">格式说明</button>
          <button class="btn ghost" id="canon-tpl-fill">填入模板</button>
        </div>
        <div class="btn-row">
          <button class="btn ghost" id="canon-tpl-copy">复制模板</button>
          <button class="btn ghost" id="canon-tpl-dl">下载模板</button>
        </div>
      </div>

      <div class="card" id="canon-spec-card" style="display:none">
        <div class="card-title">格式说明</div>
        <pre class="canon-spec"></pre>
      </div>

      <div class="card">
        <div class="card-title">① 贴入范式文本</div>
        <textarea id="canon-text" class="canon-area" placeholder="在这里粘贴范式文本…&#10;&#10;【单选】1. 电力二极管属于（ ）器件。&#10;A. 不可控器件&#10;B. 半控器件&#10;答案：B"></textarea>
        <div class="btn-row">
          <button class="btn ghost" id="canon-pick">载入文件</button>
          <button class="btn ghost" id="canon-conv">Word 转换器</button>
        </div>
        <input type="file" id="canon-file" accept=".txt,.md,.markdown,.docx,.doc" style="display:none">
        <input type="file" id="canon-old" accept=".txt,.md,.markdown,.docx,.doc,.pdf" style="display:none">
        <div class="muted small" id="canon-file-status"></div>
        <div class="btn-row">
          <button class="btn ghost" id="canon-clear">清空</button>
          <button class="btn primary" id="canon-check">解析预览</button>
        </div>
        <div class="muted small" id="canon-count"></div>
      </div>

      <div class="card" id="canon-report" style="display:none">
        <div class="card-title">② 解析结果</div>
        <div id="canon-report-body"></div>
      </div>

      <div class="card" id="canon-ai-card" style="display:none">
        <div class="card-title">③ AI 解题（可选）</div>
        <p class="muted small">让 AI 直接做缺答案的题，答案写回上面的文本框（可再人工核对后导入）。需在「设置」里配置 API Key。</p>
        <button class="btn ghost big" id="canon-ai-btn"></button>
        <div class="muted small" id="canon-ai-status"></div>
      </div>

      <div class="card">
        <div class="card-title">④ 导入题库</div>
        <label class="field"><span>题库名称（留空自动命名）</span>
          <input id="canon-name" placeholder="例如：电力电子技术 期末题库">
        </label>
        <button class="btn primary big" id="canon-import">导入题库</button>
        <div class="muted small" id="canon-import-status"></div>
      </div>`;

    const ta = document.getElementById('canon-text');
    const fileStatus = document.getElementById('canon-file-status');
    const countEl = document.getElementById('canon-count');
    const reportCard = document.getElementById('canon-report');
    const reportBody = document.getElementById('canon-report-body');
    const aiCard = document.getElementById('canon-ai-card');
    const aiBtn = document.getElementById('canon-ai-btn');
    const aiStatus = document.getElementById('canon-ai-status');
    const importStatus = document.getElementById('canon-import-status');
    document.querySelector('#canon-spec-card .canon-spec').textContent = Canon.SPEC;

    // 文本框一改，上次的解析结果就失效（防止导入了旧内容）
    const invalidate = () => {
      canonParsed = null;
      aiCard.style.display = 'none';
      reportCard.style.display = 'none';
      const n = ta.value.replace(/\s/g, '').length;
      countEl.textContent = n ? `当前文本 ${ta.value.length} 字符` : '';
    };
    ta.addEventListener('input', invalidate);

    document.getElementById('canon-spec-btn').onclick = () => {
      const c = document.getElementById('canon-spec-card');
      c.style.display = c.style.display === 'none' ? '' : 'none';
    };
    document.getElementById('canon-tpl-fill').onclick = () => {
      ta.value = Canon.template();
      invalidate();
      countEl.textContent = '模板已填入：照着改即可（题型标记可省略）';
    };
    document.getElementById('canon-tpl-copy').onclick = async () => {
      toast(await copyText(Canon.template()) ? '模板已复制到剪贴板' : '复制失败，请用「下载模板」');
    };
    document.getElementById('canon-tpl-dl').onclick = async () => {
      try {
        const r = await saveTextFile('刷题宝-范式模板.txt', Canon.template());
        toast('模板已保存：' + r.path);
      } catch (e) { toast('保存失败：' + e.message.slice(0, 60)); }
    };
    document.getElementById('canon-clear').onclick = () => {
      ta.value = '';
      invalidate();
      fileStatus.textContent = '';
      importStatus.textContent = '';
    };

    // 载入文件（.txt/.md/.docx/.pdf）：统一走转换器——
    // 已经是范式 → 原样保留；老格式文档 → 自动转成范式（避免把原始 Word 直接当范式解析出乱码）
    const fileInput = document.getElementById('canon-file');
    document.getElementById('canon-pick').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      fileStatus.textContent = `载入 ${f.name}…`;
      try {
        const raw = await readAnyText(f);
        const res = Canon.convert(raw);
        ta.value = res.text;
        invalidate();
        const s = res.stats;
        fileStatus.textContent = res.passthrough
          ? `✓ ${f.name} 已是范式格式，原样载入 · ${s.total} 题 · 答案 ${s.answered} · 解析 ${s.explained || 0} · 章节 ${s.sections || 0}`
          : `✓ 已载入并自动转换：${f.name} · ${s.total} 题 · 答案 ${s.answered} · 解析 ${s.explained || 0} · 章节 ${s.sections || 0} · 缺答案 ${s.missing}`;
        runCheck();
      } catch (e) {
        fileStatus.textContent = '⚠ ' + e.message.slice(0, 100);
      }
    };

    // Word 转换器：旧格式文档（题目+答案表 / 内联答案）→ 范式文本
    const oldInput = document.getElementById('canon-old');
    document.getElementById('canon-conv').onclick = () => oldInput.click();
    oldInput.onchange = async () => {
      const f = oldInput.files[0];
      oldInput.value = '';
      if (!f) return;
      fileStatus.textContent = `转换 ${f.name}…`;
      try {
        const raw = await readAnyText(f);
        const res = Canon.convert(raw);
        ta.value = res.text;
        invalidate();
        const s = res.stats;
        fileStatus.textContent = res.passthrough
          ? `✓ ${f.name} 已是范式格式，原样保留 · ${s.total} 题 · 答案 ${s.answered} · 解析 ${s.explained || 0} · 章节 ${s.sections || 0}`
          : `✓ 转换完成：${f.name} · ${s.total} 题 · 答案 ${s.answered} · 解析 ${s.explained || 0} · 章节 ${s.sections || 0}${s.filled ? `（答案表匹配 ${s.filled}）` : ''} · 缺答案 ${s.missing}`
            + (res.problems?.length ? `；⚠ ${res.problems.slice(0, 3).map(p => `第${p.sec}节${p.dupNos.length ? '重号' + p.dupNos.join('、') : ''}${p.missingNos.length ? '缺号' + p.missingNos.slice(0, 8).join('、') : ''}`).join('；')}` : '');
        runCheck();
      } catch (e) {
        fileStatus.textContent = '⚠ ' + e.message.slice(0, 120);
      }
    };

    document.getElementById('canon-check').onclick = () => runCheck();

    /* ---- 解析预览 ---- */
    function runCheck() {
      const text = ta.value;
      if (text.replace(/\s/g, '').length < 5) { toast('请先贴入范式文本'); return null; }
      const r = Canon.parse(text);
      canonParsed = r;
      const s = r.stats;
      const typeStr = Object.keys(s.byType).filter(k => s.byType[k])
        .map(k => `${Canon.TYPE_LABEL[k]} ${s.byType[k]}`).join(' · ');
      reportCard.style.display = '';
      reportBody.innerHTML = `
        <div class="canon-stats">
          <div class="canon-stat"><b>${s.total}</b><span>题目</span></div>
          <div class="canon-stat"><b style="color:var(--ok)">${s.answered}</b><span>有答案</span></div>
          <div class="canon-stat"><b style="color:${s.explained ? 'var(--ok)' : 'var(--muted, #888)'}">${s.explained || 0}</b><span>带解析</span></div>
          <div class="canon-stat"><b style="color:${s.missing ? 'var(--bad)' : 'var(--ok)'}">${s.missing}</b><span>缺答案</span></div>
          <div class="canon-stat"><b style="color:${s.errors ? 'var(--bad)' : 'var(--ok)'}">${s.errors}</b><span>格式错误</span></div>
        </div>
        <div class="muted small">${typeStr || '—'}${s.sections ? ` · ${s.sections} 个章节` : ''}</div>
        ${r.errors.length ? `<div class="canon-issues">
          <div class="canon-issue-title bad">⚠ ${r.errors.length} 处格式错误（这些题不会被导入）</div>
          ${r.errors.slice(0, 30).map(e => `<div class="canon-issue"><span class="ln">第${e.line}行</span>${escapeHtml(e.msg)}</div>`).join('')}
          ${r.errors.length > 30 ? '<div class="muted small">…仅显示前 30 条</div>' : ''}
        </div>` : ''}
        ${r.warns.length ? `<div class="canon-issues">
          <div class="canon-issue-title">提示 ${r.warns.length} 处（不影响导入）</div>
          ${r.warns.slice(0, 20).map(e => `<div class="canon-issue"><span class="ln">第${e.line}行</span>${escapeHtml(e.msg)}</div>`).join('')}
          ${r.warns.length > 20 ? '<div class="muted small">…仅显示前 20 条</div>' : ''}
        </div>` : ''}`;

      const noAns = r.questions.filter(q => !q.answer);
      if (noAns.length) {
        aiCard.style.display = '';
        aiBtn.disabled = false;
        aiBtn.textContent = `AI 解答缺答案的 ${noAns.length} 题`;
        aiStatus.textContent = '也可以直接在文本框里补「答案：」，再点「解析预览」';
      } else {
        aiCard.style.display = 'none';
      }
      return r;
    }

    /* ---- AI 解题：补缺答案，写回文本框 ---- */
    aiBtn.onclick = async () => {
      const r = canonParsed || runCheck();
      if (!r) return;
      const noAns = r.questions.filter(q => !q.answer);
      if (!noAns.length) return toast('没有缺答案的题了');
      const cfg = await LLM.getConfig();
      if (!cfg.apiKey) { toast('请先到「设置」配置 API Key'); return navigate('#/settings'); }
      aiBtn.disabled = true;
      aiStatus.textContent = 'AI 解题中…（自适应批量、进度实时反馈）';
      try {
        const solved = await LLM.solveQuestions(noAns, (done, total, got, note) => {
          if (total <= 0) { if (note) aiStatus.textContent = note; return; }
          aiStatus.textContent = `${note ? note + ' · ' : ''}AI 解题中：${done}/${total} 批 · 已得 ${got} 个答案`;
        }, (c, a, cool) => {
          aiStatus.textContent = cool > 0 ? `⏳ API 限流，冷却 ${cool}s 后重试` : '网络波动，重试中…';
        });
        // 答案写回文本框（AI 答案仅供练习参考，可人工核对后再导入）
        const left = r.questions.filter(q => !q.answer).length;
        ta.value = Canon.fromQuestions(r.questions, r.sections);
        const re = runCheck();
        aiStatus.textContent = `✓ AI 补了 ${solved} 个答案，已写回文本框（可人工核对）`
          + (left ? `；剩 ${left} 题未解出` : '')
          + (re?.stats.errors ? `；⚠ 文本有 ${re.stats.errors} 处格式错误` : '');
        toast(`AI 补了 ${solved} 个答案`);
      } catch (e) {
        aiStatus.textContent = '⚠ ' + e.message.slice(0, 120);
        aiBtn.disabled = false;
      }
    };

    /* ---- 导入题库 ---- */
    document.getElementById('canon-import').onclick = async () => {
      const r = canonParsed || runCheck();
      if (!r) return;
      if (!r.stats.total) {
        importStatus.textContent = '⚠ 没有解析到任何题目，请对照「格式说明」检查（题目要有题干行，选择题要有 A./B. 选项行）';
        return;
      }
      if (!confirmDialog(`导入 ${r.stats.total} 题到新题库？${r.stats.missing ? `\n其中 ${r.stats.missing} 题缺答案，导入后可在题库列表「补答案」。` : ''}`)) return;
      const name = (document.getElementById('canon-name').value.trim()
        || `范式导入 ${new Date().toLocaleDateString()}`).slice(0, 40);
      const bank = {
        id: DB.uid(),
        name,
        createdAt: Date.now(),
        count: r.questions.length,
        source: '范式导入',
        sections: r.sections && r.sections.length ? r.sections : null
      };
      const qs = r.questions.map(q => {
        const o = { ...q, id: DB.uid(), bankId: bank.id };
        delete o._srcLine;
        return o;
      });
      await DB.questionAddMany(qs);
      await DB.bankAdd(bank);
      const noAns = qs.filter(q => !q.answer).length;
      importStatus.textContent = `✓ 已导入「${name}」共 ${qs.length} 题${noAns ? `（${noAns} 题缺答案）` : ''}`;
      toast(`已导入 ${qs.length} 题`);
      navigate('#/home');
    };
  }

  /* ================= 页面：导入 ================= */
  function pageImport() {
    topbar('导入文件', '#/home');
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">第 1 步 · 选择文件</div>
        <p class="muted">支持多选 PDF、DOCX。题目文件可与<b>配套答案文件</b>一起选中：自动识别答案文件（文件名含「答案」或内容为答案格式），按 章/节/题号 精确匹配填入答案与解析。</p>
        <p class="muted small">纯本地解析：不调用 AI、无需 API Key、零费用（扫描版 PDF 会自动 OCR）。</p>
        <button class="btn primary big" style="margin-top:10px" id="pick-btn">选择文件</button>
        <input type="file" id="file-input" multiple accept=".pdf,.docx,.doc" style="display:none">
        <div id="file-list" class="file-list"></div>
      </div>
      <div class="card">
        <div class="card-title">AI 辅助录入（可选开关）</div>
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.6">
          <input type="checkbox" id="ai-assist-toggle" style="margin-top:3px;flex:none">
          <span>开启后，本地规则<b>匹配不到答案</b>的题，由 AI 直接<b>从答案文件原文智能对位</b>填入：答案照抄原文而非 AI 做题，正确率高；按题型严格校验，校验不过的宁缺毋错。需在「设置」配置 API Key，消耗少量额度；关闭或无 Key 时纯本地解析零调用。</span>
        </label>
      </div>
      <div class="card" id="parse-card" style="display:none">
        <div class="card-title">第 2 步 · 解析</div>
        <div class="muted" id="parse-status"></div>
        <div class="progress"><div class="progress-bar" id="parse-bar"></div></div>
        <div id="parse-result"></div>
      </div>`;

    // AI 辅助开关：状态持久化
    const aiToggle = document.getElementById('ai-assist-toggle');
    DB.metaGet('aiAssistImport').then(v => { aiToggle.checked = !!v; });
    aiToggle.onchange = () => DB.metaSet('aiAssistImport', aiToggle.checked);

    const input = document.getElementById('file-input');
    document.getElementById('pick-btn').onclick = () => input.click();
    input.onchange = () => handleFiles([...input.files]);
  }

  async function handleFiles(files) {
    if (!files.length) return;

    const listEl = document.getElementById('file-list');
    const card = document.getElementById('parse-card');
    card.style.display = '';
    const statusEl = document.getElementById('parse-status');
    const bar = document.getElementById('parse-bar');
    const resultEl = document.getElementById('parse-result');

    listEl.innerHTML = '';
    const rows = new Map();
    files.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'file-item';
      row.innerHTML = `
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="file-size">${(f.size / 1024).toFixed(0)} KB</span>
        <span class="file-state" data-state="wait">待解析</span>`;
      listEl.appendChild(row);
      rows.set(i, row);
    });

    // 第 1 步 · 全部提取文本
    const texts = new Map();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const stateEl = rows.get(i).querySelector('.file-state');
      const setState = (s) => { stateEl.textContent = s; stateEl.dataset.state = s; };
      setState('提取文本…');
      try {
        const raw = await Extractor.extract(f, (p, t) => setState(`提取 ${p}/${t} 页`));
        const text = Extractor.cleanText(raw);
        if (text.replace(/\s/g, '').length < 50) {
          setState('失败');
          stateEl.innerHTML = '⚠ 无文本';
          continue;
        }
        texts.set(i, text);
      } catch (e) {
        console.error(e);
        setState('失败');
        stateEl.innerHTML = '⚠ 失败';
        toast(files[i].name + '：' + e.message.slice(0, 80));
      }
    }

    // 第 2 步 · 区分题目文件 / 配套答案文件（文件名含「答案」或答案行占比≥30%）
    const qFiles = [], aFiles = [];
    files.forEach((f, i) => {
      const text = texts.get(i);
      if (text == null) return;
      const isAns = /答案|answer/i.test(f.name) || LLM.answerLineRatio(text) >= 0.3;
      rows.get(i).querySelector('.file-state').textContent = isAns ? '答案文件' : '题目文件';
      (isAns ? aFiles : qFiles).push({ f, i, text });
    });
    if (!qFiles.length) {
      statusEl.textContent = aFiles.length
        ? '⚠ 只识别到答案文件，请把题目文件和答案文件一起选中导入'
        : '⚠ 没有可解析的文件';
      bar.style.width = '100%';
      return;
    }

    // 第 3 步 · 合并解析所有答案文件
    let parsedAnswers = null;
    if (aFiles.length) {
      parsedAnswers = LLM.parseAnswerDocument(aFiles.map(x => x.text).join('\n'));
    }

    // 第 4 步 · 逐个解析题目文件 + 配套答案填入
    for (const { f, i, text } of qFiles) {
      const stateEl = rows.get(i).querySelector('.file-state');
      const setState = (s) => { stateEl.textContent = s; stateEl.dataset.state = s; };
      setState('本地解析…');
      bar.style.width = '5%';
      const t0 = Date.now();
      try {
        const res = await LLM.parseDocument(text, (done, total, got) => {
          const elapsed = Math.round((Date.now() - t0) / 1000);
          statusEl.textContent = `本地解析中：已提取 ${got} 题 · 已用 ${elapsed}s`;
          bar.style.width = Math.round(done / total * 95) + '%';
        });
        if (!res.questions.length) {
          setState('未发现题目');
          continue;
        }
        // 残缺题（选项缺字母的降级解析结果）不入库
        const degradedCount = res.questions.filter(q => q._degraded).length;
        res.questions = res.questions.filter(q => !q._degraded);
        if (!res.questions.length) {
          setState(`⚠ ${degradedCount} 题均为残缺题（选项缺字母），已全部跳过`);
          continue;
        }

        // 配套答案：按 章/节/题号 精确填入（含解析）
        let filled = 0, explained = 0;
        if (parsedAnswers) {
          const r = LLM.matchAnswersStructured(res.questions, res.sections, parsedAnswers);
          filled = r.filled; explained = r.explained;
        }

        // AI 辅助录入：开关开启 + 有答案文件 + 本地匹配后仍有缺答案 → AI 从答案原文智能对位
        let aiFilled = 0, aiExplained = 0;
        const aiAssistOn = document.getElementById('ai-assist-toggle')?.checked;
        if (aiAssistOn && aFiles.length && res.questions.some(q => !q.answer)) {
          const cfg = await LLM.getConfig();
          if (!cfg.apiKey) {
            toast('AI 辅助需先在「设置」配置 API Key，本次已跳过');
          } else {
            setState('AI 对位答案…');
            statusEl.textContent = 'AI 辅助录入：从答案文件原文智能对位中…';
            try {
              const answerRaw = aFiles.map(x => x.text).join('\n');
              const r = await LLM.aiMatchAnswers(res.questions, answerRaw, res.sections,
                (done, total, got, si, sc) => {
                  statusEl.textContent = `AI 辅助对位：${done}/${total} 批 · 已填 ${got} 个答案` + (sc > 1 ? `（答案原文分片 ${si}/${sc}）` : '');
                },
                (att, cool) => { statusEl.textContent = cool > 0 ? `⏳ API 限流，冷却 ${cool}s 后继续` : '网络波动，AI 重试中…'; });
              aiFilled = r.filled; aiExplained = r.explained;
            } catch (e) {
              toast('AI 辅助失败（不影响本地结果）：' + e.message.slice(0, 60));
            }
          }
        }
        const noAnswer = res.questions.filter(q => !q.answer).length;

        const bank = {
          id: DB.uid(),
          name: f.name.replace(/\.(pdf|docx|doc)$/i, ''),
          createdAt: Date.now(),
          count: res.questions.length,
          source: f.name,
          sections: res.sections || null
        };
        res.questions.forEach(q => q.bankId = bank.id);
        await DB.questionAddMany(res.questions);
        await DB.bankAdd(bank);
        const totalFilled = filled + aiFilled, totalExp = explained + aiExplained;
        if (totalFilled) {
          setState(`✓ ${res.questions.length} 题 · 答案填入 ${totalFilled}${aiFilled ? `（AI 辅助 ${aiFilled}）` : ''}`);
          toast(`提取 ${res.questions.length} 题，答案填入 ${totalFilled} 个${totalExp ? `（含 ${totalExp} 条解析）` : ''}`);
        } else if (noAnswer > 0) {
          setState(`✓ ${res.questions.length} 题（${noAnswer} 题缺答案）`);
          toast(`提取 ${res.questions.length} 题，答案未匹配上，可稍后「补答案」`);
        } else {
          setState(`✓ ${res.questions.length} 题`);
        }
        // 解析报告
        const problemsText = res.problems?.length
          ? '；⚠ ' + res.problems.slice(0, 5).map(p => `第${p.sec}节${p.dupNos.length ? '重号' + p.dupNos.join('、') : ''}${p.missingNos.length ? (p.dupNos.length ? '·' : '') + '缺号' + p.missingNos.slice(0, 10).join('、') : ''}`).join('；')
          : '';
        const warn = [];
        if (degradedCount > 0) warn.push(`自动跳过 ${degradedCount} 道残缺题`);
        if (aFiles.length && filled === 0) warn.push('答案文件未匹配到任何题目（章节/题号对不上）');
        statusEl.textContent = `⚡ 全部 ${res.localCount} 题本地解析（0 次 API 调用）` + (warn.length ? '；' + warn.join('；') : '') + problemsText;
      } catch (e) {
        console.error(e);
        setState('失败');
        stateEl.innerHTML = '⚠ 失败';
        toast(f.name + '：' + e.message.slice(0, 80));
      }
    }
    bar.style.width = '100%';
    statusEl.textContent = '全部完成';
    resultEl.innerHTML = `<button class="btn primary big" onclick="App.navigate('#/home')">完成，返回题库</button>
      <div class="muted small">缺答案的题：可在题库列表点「补答案」，也可在「选题」里勾选缺答案的题，练习时点右上角 ✎ 自己填答案；扫描版 PDF 会自动 OCR（较慢）；.doc 需另存为 .docx</div>`;
  }

  /* ================= 页面：题目列表（搜索 / 筛选 / 勾选 / 折叠） ================= */
  async function pageBankQuestions(params) {
    const bankId = params[0];
    const bank = await DB.bankGet(bankId);
    if (!bank) return navigate('#/home');
    const qs = await DB.questionsByBank(bankId);
    // 有节键按节-题号排（跨节同号不混排），老题无键按题号排
    qs.sort((a, b) => a.key && b.key
      ? a.key.localeCompare(b.key, 'zh', { numeric: true })
      : (a.no ?? 0) - (b.no ?? 0));

    // ---- 按小节分组（key="节序号-题号"；无 key 的老题/兜底题归入"未分节"）----
    const TYPE_NAME = { single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题' };
    const secMap = new Map(); // secIdx(字符串) -> {title, type}
    (bank.sections || []).forEach(s => secMap.set(String(s.secIdx), s));
    const groups = [];
    const groupOf = {};
    for (const q of qs) {
      const sec = q.key ? String(q.key).split('-')[0] : '';
      if (!(sec in groupOf)) {
        groupOf[sec] = groups.length;
        const s = secMap.get(sec);
        groups.push({
          sec,
          title: s?.title || (sec ? `第 ${+sec} 节` : '未分节'),
          type: s?.type || null,
          idxs: []
        });
      }
      groups[groupOf[sec]].idxs.push(qs.indexOf(q));
    }

    // ---- 作答状态（错题 / 未答 / 答对）与收藏，供筛选 ----
    const latest = await DB.latestByQuestion();
    const starSet = new Set(await DB.starIds());
    const stateOf = q => { const r = latest[q.id]; return r ? (r.correct ? 'done' : 'wrong') : 'todo'; };

    // ---- 选择状态：存题目 id（切换筛选/折叠后勾选不丢）----
    const sel = new Set(qs.filter(q => q.answer).map(q => q.id));
    let kw = '', filter = 'all';
    const collapsed = new Set();

    const FILTERS = [
      ['all', '全部', () => true],
      ['wrong', '错题', q => stateOf(q) === 'wrong'],
      ['todo', '未答', q => stateOf(q) === 'todo'],
      ['done', '答对', q => stateOf(q) === 'done'],
      ['star', '收藏', q => starSet.has(q.id)],
      ['missing', '缺答案', q => !q.answer],
      ['exp', '有解析', q => !!q.explanation]
    ];

    topbar(bank.name.slice(0, 10) || '题目列表', '#/home');
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">选择要练的题</div>
        <div class="list-tools">
          <input id="q-search" class="search-input" placeholder="搜索题干 / 选项 / 答案…">
          <div class="chips" id="q-filter"></div>
        </div>
        <div class="chips" id="sec-fold">
          <button class="chip" data-act="fold">全部折叠</button>
          <button class="chip" data-act="unfold">全部展开</button>
        </div>
        <div class="btn-row">
          <button class="btn ghost" id="sel-all">全选可见</button>
          <button class="btn ghost" id="sel-none">清空选择</button>
        </div>
        <div class="btn-row">
          <button class="btn ghost" id="sel-noans">只选有答案</button>
          <button class="btn ghost" id="sel-unans">只选缺答案</button>
        </div>
        <div class="btn-row">
          <button class="btn ghost" id="exp-canon">导出范式</button>
          <button class="btn ghost" id="copy-canon">复制范式</button>
        </div>
        <div class="btn-row">
          <button class="btn ghost" id="del-sel" style="color:var(--bad)">删除选中</button>
        </div>
        <div class="muted small" style="margin-top:6px">导出范式后可在 Word 里补答案 / 加题 / 改题干，再回「范式导入」贴回来覆盖建库（答案随题，无需再对齐）</div>
        <div class="muted small" id="pick-info" style="margin-top:8px"></div>
        <div class="muted small" style="margin-top:4px">缺答案的题（虚线框）也能勾选练习：练习时点右上角 ✎ 自己填答案；点章节标题可折叠</div>
        <div id="no-grid"></div>
        <button class="btn primary big" id="go-quiz" style="margin-top:12px"></button>
      </div>
      <style>
        .sec-group { margin-top:12px; }
        .sec-head { display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px dashed var(--line, #e3e8f0); }
        .sec-head b { flex:1; font-size:14px; min-width:0; }
        .no-grid { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
        .no-cell {
          position:relative; display:inline-flex; align-items:center; justify-content:center; gap:2px;
          min-width:40px; height:34px; padding:0 9px;
          background:var(--surface-2, #f7f9fc); border:1.5px solid transparent; border-left:3px solid transparent;
          border-radius:9px; font-size:13px; font-weight:600; color:var(--text);
          cursor:pointer; user-select:none; -webkit-user-select:none;
          transition:background .15s, color .15s, border-color .15s, box-shadow .15s, transform .1s;
        }
        .no-cell:active { transform:scale(.94); }
        .no-cell input { position:absolute; opacity:0; width:0; height:0; margin:0; }
        .no-cell::before { content:'✓'; font-size:11px; line-height:1; opacity:0; width:0; overflow:hidden; transition:opacity .15s, width .15s; }
        /* 已选：整格填色 + 打勾，一眼能看出选了什么 */
        .no-cell.on { background:var(--primary); border-color:var(--primary-dark); color:var(--on-primary); box-shadow:0 2px 8px var(--primary-glow); }
        .no-cell.on::before { opacity:1; width:11px; }
        .no-cell.no-ans { border-style:dashed; border-color:var(--line, #e3e8f0); opacity:.6; }
        .no-cell.no-ans.on { border-style:solid; opacity:1; }
        .no-cell.st-wrong { border-left-color:var(--bad); }
        .no-cell.st-done { border-left-color:var(--ok); }
        .no-cell.on.st-wrong, .no-cell.on.st-done { border-left-color:var(--primary-dark); }
      </style>`;

    const grid = document.getElementById('no-grid');
    const info = document.getElementById('pick-info');
    const goBtn = document.getElementById('go-quiz');
    const filterEl = document.getElementById('q-filter');

    filterEl.innerHTML = FILTERS.map(([k, label, fn]) => {
      const n = qs.filter(fn).length;
      return `<button class="chip ${k === 'all' ? 'on' : ''}" data-v="${k}">${label} ${n}</button>`;
    }).join('');

    function matchQ(q) {
      if (kw) {
        const hay = [q.stem, q.answer, q.explanation, ...Object.values(q.options || {})].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      const f = FILTERS.find(x => x[0] === filter);
      return f ? f[2](q) : true;
    }

    function update(shown) {
      const n = shown != null ? shown : grid.querySelectorAll('input[data-id]').length;
      info.textContent = `共 ${qs.length} 题 · 当前显示 ${n} 题 · 已选 ${sel.size} 题`;
      goBtn.textContent = `练习选中题（${sel.size}）`;
    }

    function renderGrid() {
      let shown = 0;
      const html = groups.map(g => {
        const idxs = g.idxs.filter(i => matchQ(qs[i]));
        if (!idxs.length) return '';
        shown += idxs.length;
        const isCollapsed = collapsed.has(g.sec);
        const secIds = idxs.map(i => qs[i].id);
        const allOn = secIds.length > 0 && secIds.every(id => sel.has(id));
        return `
          <div class="sec-group">
            <div class="sec-head">
              <button class="sec-toggle" data-fold="${escapeHtml(g.sec)}">${isCollapsed ? '▸' : '▾'}</button>
              <b>${escapeHtml(g.title)}${g.type && !String(g.title).includes(TYPE_NAME[g.type] || '\u0000') ? ` · ${TYPE_NAME[g.type] || ''}` : ''}</b>
              <span class="muted small">${idxs.length}${idxs.length !== g.idxs.length ? '/' + g.idxs.length : ''} 题</span>
              <button class="chip ${allOn ? 'on' : ''}" data-sec="${escapeHtml(g.sec)}">${allOn ? '取消本节' : '本节全选'}</button>
            </div>
            ${isCollapsed ? '' : `<div class="no-grid">
              ${idxs.map(i => {
                const q = qs[i];
                return `<label class="no-cell ${q.answer ? '' : 'no-ans'} st-${stateOf(q)}${sel.has(q.id) ? ' on' : ''}" title="${q.answer ? '有答案' : '缺答案（可勾选，练习时自己填）'}${q.explanation ? ' · 有解析' : ''}">
                  <input type="checkbox" data-id="${q.id}" ${sel.has(q.id) ? 'checked' : ''}>
                  <span>${q.no ?? i + 1}</span>
                </label>`;
              }).join('')}
            </div>`}
          </div>`;
      }).join('');
      grid.innerHTML = html || '<div class="muted small" style="padding:12px 0">没有匹配的题（换个关键词或筛选试试）</div>';

      // 每次重渲染后重新绑定（事件委托会因 innerHTML 变化而失效）
      grid.querySelectorAll('input[data-id]').forEach(box => {
        box.onchange = () => {
          const on = box.checked;
          on ? sel.add(box.dataset.id) : sel.delete(box.dataset.id);
          const cell = box.closest('.no-cell');
          if (cell) cell.classList.toggle('on', on);
          update();
        };
      });
      grid.querySelectorAll('[data-fold]').forEach(b => {
        b.onclick = () => {
          const s = b.dataset.fold;
          collapsed.has(s) ? collapsed.delete(s) : collapsed.add(s);
          renderGrid();
        };
      });
      grid.querySelectorAll('button[data-sec]').forEach(b => {
        b.onclick = () => {
          const g = groups.find(x => String(x.sec) === b.dataset.sec);
          if (!g) return;
          const ids = g.idxs.filter(i => matchQ(qs[i])).map(i => qs[i].id);
          const allOn = ids.length && ids.every(id => sel.has(id));
          ids.forEach(id => allOn ? sel.delete(id) : sel.add(id));
          renderGrid();
        };
      });
      update(shown);
    }

    document.getElementById('q-search').oninput = (e) => { kw = e.target.value.trim().toLowerCase(); renderGrid(); };
    filterEl.onclick = (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      filterEl.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      filter = b.dataset.v;
      renderGrid();
    };
    document.getElementById('sec-fold').onclick = (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      collapsed.clear();
      if (b.dataset.act === 'fold') groups.forEach(g => collapsed.add(g.sec));
      renderGrid();
    };
    // 批量选择必须重渲染，让格子的 .on 选中态跟着变（只改数据不改视觉会「选了却看不出来」）
    document.getElementById('sel-all').onclick = () => {
      grid.querySelectorAll('input[data-id]').forEach(b => sel.add(b.dataset.id));
      renderGrid();
    };
    document.getElementById('sel-none').onclick = () => {
      sel.clear();
      renderGrid();
    };
    document.getElementById('sel-noans').onclick = () => {
      sel.clear();
      qs.filter(q => q.answer).forEach(q => sel.add(q.id));
      renderGrid();
    };
    document.getElementById('sel-unans').onclick = () => {
      sel.clear();
      qs.filter(q => !q.answer).forEach(q => sel.add(q.id));
      renderGrid();
    };

    goBtn.onclick = async () => {
      if (!sel.size) return toast('请先勾选题号');
      // 缺答案的题也允许练（练习时用 ✎ 自己填答案）
      const list = qs.filter(q => sel.has(q.id));
      const noAnsCount = list.filter(q => !q.answer).length;
      session = new QuizSession(list, { shuffle: false });
      if (noAnsCount) toast(`其中 ${noAnsCount} 题缺答案，练习时点右上角 ✎ 自己填`);
      navigate('#/quiz');
    };

    // 导出 / 复制范式：题库 → 范式文本（Word 里改完再「范式导入」贴回来）
    const canonText = () => Canon.fromQuestions(qs, bank.sections, { title: bank.name });
    document.getElementById('exp-canon').onclick = async () => {
      try {
        const r = await saveTextFile(`${bank.name}-范式.txt`, canonText());
        toast('已导出范式：' + r.path);
      } catch (e) { toast('导出失败：' + e.message.slice(0, 60)); }
    };
    document.getElementById('copy-canon').onclick = async () => {
      toast(await copyText(canonText()) ? `已复制 ${qs.length} 题的范式文本` : '复制失败，请用「导出范式」');
    };

    // 删除选中 → 移入回收站（可恢复；彻底删除需在回收站二次确认）
    document.getElementById('del-sel').onclick = async () => {
      if (!sel.size) return toast('请先勾选要删除的题');
      const del = qs.filter(q => sel.has(q.id));
      if (!confirmDialog(`删除选中 ${del.length} 题？\n删除后进入回收站，可在回收站恢复或彻底删除。`)) return;
      await DB.recycleAdd(bank, del);
      for (const q of del) await DB.questionDelete(q.id);
      await DB.bankUpdateCount(bankId);
      toast(`已删除 ${del.length} 题，可在回收站恢复`);
      render();
    };

    renderGrid();
  }

  /* ================= 页面：回收站 ================= */
  async function pageRecycle() {
    topbar('回收站', '#/home');
    const bin = await DB.recycleList();
    bin.sort((a, b) => b.deletedAt - a.deletedAt);
    if (!bin.length) {
      $view().innerHTML = `<div class="empty" style="padding:60px 0">回收站是空的<br><span class="muted small">删除的题目会暂存在这里</span></div>`;
      return;
    }
    const TYPE_NAME = { single: '单选', multi: '多选', judge: '判断', fill: '填空' };
    $view().innerHTML = `
      <div class="card">
        <div class="muted small">共 ${bin.length} 题 · 删除的题可恢复；彻底删除后不可恢复</div>
        <button class="btn ghost big" id="clear-bin" style="margin-top:8px;color:var(--bad)">清空回收站</button>
      </div>
      ${bin.map(x => `
      <div class="card">
        <div class="rec-stem">${escapeHtml((x.question.stem || '').slice(0, 80))}</div>
        <div class="muted small" style="margin-top:6px">
          ${escapeHtml(x.bankName || '')}${x.question.no != null ? ` · 第${x.question.no}题` : ''}${x.question.type ? ` · ${TYPE_NAME[x.question.type] || ''}` : ''} · ${new Date(x.deletedAt).toLocaleString()}
        </div>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn primary" style="padding:6px 16px" data-restore="${x.qid}">恢复</button>
          <button class="btn ghost" style="padding:6px 16px;color:var(--bad)" data-purge="${x.qid}">彻底删除</button>
        </div>
      </div>`).join('')}
      <style>
        .rec-stem { font-size:14px; line-height:1.5; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      </style>`;

    $view().querySelectorAll('[data-restore]').forEach(b => {
      b.onclick = async () => {
        const r = await DB.recycleRestore(b.dataset.restore);
        if (!r || !r.ok) return toast('原题库已删除，无法恢复');
        toast('已恢复');
        render();
      };
    });
    $view().querySelectorAll('[data-purge]').forEach(b => {
      b.onclick = async () => {
        if (!confirmDialog('彻底删除这道题？删除后不可恢复！')) return;
        await DB.recycleRemove(b.dataset.purge);
        toast('已彻底删除');
        render();
      };
    });
    document.getElementById('clear-bin').onclick = async () => {
      if (!confirmDialog(`彻底删除回收站全部 ${bin.length} 题？删除后不可恢复！`)) return;
      await DB.recycleClear();
      toast('回收站已清空');
      render();
    };
  }

  /* ================= 页面：补答案（两步走 · 第二步） ================= */
  async function pageAnswers(params) {
    const bankId = params[0];
    const bank = await DB.bankGet(bankId);
    if (!bank) return navigate('#/home');
    const qs = await DB.questionsByBank(bankId);
    qs.sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
    const noAns = qs.filter(q => !q.answer);

    topbar('补答案', '#/home');
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(bank.name)}</div>
        <div class="muted">共 ${qs.length} 题 · 已有答案 ${qs.length - noAns.length} · 缺答案 <b style="color:var(--bad)">${noAns.length}</b></div>
      </div>

      <div class="card">
        <div class="card-title">方式一 · 上传答案文件（推荐，免费）</div>
        <p class="muted small">支持配套答案文档「2、答案：A（解析：…）」、答案表「1.C 2.A 3.B」「题号：1 答案：C」、纯序列「A B C D」。带章节结构的答案按 章/节/题号 精确匹配，解析一并填入；匹配不上的题可用下方 AI 智能对位兜底。</p>
        <button class="btn primary big" id="ans-file-btn">选择答案文件（可多选）</button>
        <input type="file" id="ans-file-input" multiple accept=".pdf,.docx,.doc,.txt" style="display:none">
        <div class="muted small" id="ans-file-status"></div>
        <div id="ans-ai-match"></div>
      </div>

      <div class="card">
        <div class="card-title">方式二 · AI 解答剩余题目</div>
        <p class="muted small">由 AI 做题生成答案（可能出错，仅供练习参考；建议配合教材核对关键题）。</p>
        <button class="btn ghost big" id="ans-ai-btn" ${noAns.length ? '' : 'disabled'}>${noAns.length ? `AI 解答 ${noAns.length} 题` : '本库无缺答案题'}</button>
        <div class="muted small" id="ans-ai-status">${noAns.length ? '' : '本库所有题目都已有答案，如需复核可使用下方「AI 校验」'}</div>
      </div>

      ${qs.length - noAns.length ? `
      <div class="card">
        <div class="card-title">方式三 · AI 校验答案并补解析</div>
        <p class="muted small">AI 独立重做每道题，与现有答案比对：一致的确认可信；不一致的列出来由你裁决（原答案不改动）。同时给缺解析的题补上 AI 解析。</p>
        <button class="btn ghost big" id="ans-verify-btn">校验 ${qs.length - noAns.length} 道已答题目</button>
        <div class="muted small" id="ans-verify-status"></div>
        <div id="verify-result"></div>
      </div>` : ''}
      <div class="progress"><div class="progress-bar" id="ans-bar"></div></div>`;

    const bar = document.getElementById('ans-bar');
    const fileStatus = document.getElementById('ans-file-status');
    const aiStatus = document.getElementById('ans-ai-status');

    // 方式一：答案文件匹配（结构化：章/节/题号精确对位，解析一并填入；对不上的转 AI 智能对位兜底）
    const input = document.getElementById('ans-file-input');
    const aiMatchBox = document.getElementById('ans-ai-match');
    let lastAnswerRaw = ''; // 最近一次答案文件原文（供 AI 对位）
    document.getElementById('ans-file-btn').onclick = () => input.click();
    input.onchange = async () => {
      if (!input.files.length) return;
      fileStatus.textContent = '提取答案文本…';
      try {
        const texts = [];
        for (const f of [...input.files]) {
          texts.push(Extractor.cleanText(await Extractor.extract(f)));
        }
        lastAnswerRaw = texts.join('\n');
        const parsed = LLM.parseAnswerDocument(lastAnswerRaw);
        const total = parsed.entries.length || parsed.ordered.length;
        if (!total) {
          fileStatus.textContent = '⚠ 本地规则未识别出答案条目。文档里确实有答案但格式特殊的话，可点下方「AI 智能对位」直接读原文对位';
          renderAiMatch();
          return;
        }
        fileStatus.textContent = `识别到 ${total} 个答案，按 章/节/题号 匹配中…`;
        const { filled, explained } = LLM.matchAnswersStructured(noAns, bank.sections, parsed);
        for (const q of noAns) if (q.answer) await DB.questionPut(q);
        const remain = noAns.filter(q => !q.answer).length;
        if (filled) {
          toast(`已补 ${filled} 个答案`);
          if (!remain) {
            fileStatus.textContent = `✓ 成功填入 ${filled} 个答案${explained ? `（含 ${explained} 条解析）` : ''}，全部补齐`;
            render();
            return;
          }
          fileStatus.textContent = `✓ 本地规则已填 ${filled} 个${explained ? `（含 ${explained} 条解析）` : ''}，剩 ${remain} 题对不上`;
        } else {
          fileStatus.textContent = '⚠ 本地规则未能匹配（章节/题号对不上？），可试 AI 智能对位';
        }
        renderAiMatch();
      } catch (e) {
        fileStatus.textContent = '⚠ ' + e.message.slice(0, 100);
      }
    };

    // AI 智能对位兜底：AI 从答案文件原文找答案照抄填入（非 AI 做题），按题型严格校验
    function renderAiMatch() {
      const remain = noAns.filter(q => !q.answer).length;
      aiMatchBox.innerHTML = remain
        ? `<button class="btn ghost big" id="ans-ai-match-btn">AI 智能对位剩余 ${remain} 题</button>
           <div class="muted small" style="margin-top:6px">由 AI 从答案文件原文中找出每题答案照抄填入（不是 AI 做题，正确率高；按题型严格校验，过不了校验的宁缺毋错；需 API Key）</div>
           <div class="muted small" id="ans-ai-match-status"></div>`
        : '';
      const btn = document.getElementById('ans-ai-match-btn');
      if (btn) btn.onclick = runAiMatch;
    }
    async function runAiMatch() {
      const remain = noAns.filter(q => !q.answer);
      if (!remain.length) return toast('没有缺答案的题了');
      if (!lastAnswerRaw) return toast('请先选择答案文件');
      const cfg = await LLM.getConfig();
      if (!cfg.apiKey) { toast('请先到「设置」配置 API Key'); return navigate('#/settings'); }
      const btn = document.getElementById('ans-ai-match-btn');
      const st = document.getElementById('ans-ai-match-status');
      if (btn) btn.disabled = true;
      if (st) st.textContent = 'AI 智能对位中…（答案照抄原文，进度自动保存）';
      try {
        const r = await LLM.aiMatchAnswers(noAns, lastAnswerRaw, bank.sections,
          (done, total, got, si, sc) => {
            if (st) st.textContent = `AI 对位：${done}/${total} 批 · 已填 ${got} 个答案` + (sc > 1 ? `（答案原文分片 ${si}/${sc}）` : '');
          },
          (att, cool) => { if (st) st.textContent = cool > 0 ? `⏳ API 限流，冷却 ${cool}s 后继续` : '网络波动，AI 重试中…'; },
          async (batch) => { for (const q of batch) if (q.answer) await DB.questionPut(q); });
        const left = noAns.filter(q => !q.answer).length;
        if (st) st.textContent = r.filled
          ? `✓ AI 智能对位填入 ${r.filled} 个答案${r.explained ? `（含 ${r.explained} 条解析）` : ''}` + (left ? `，剩 ${left} 题未在答案原文中找到` : '')
          : '答案原文中未找到更多答案，可试「方式二 · AI 解答」';
        toast(`AI 对位补了 ${r.filled} 个答案`);
        render();
      } catch (e) {
        if (st) st.textContent = '⚠ ' + e.message.slice(0, 100);
        if (btn) { btn.disabled = false; btn.textContent = '重试 AI 智能对位'; }
      }
    }

    // 方式二：AI 解答（每批自动落库，断网后重进接着来）
    document.getElementById('ans-ai-btn').onclick = async () => {
      if (!noAns.length) return toast('没有缺答案的题了');
      const cfg = await LLM.getConfig();
      if (!cfg.apiKey) { toast('请先到「设置」配置 API Key'); return navigate('#/settings'); }
      const btn = document.getElementById('ans-ai-btn');
      btn.disabled = true;
      aiStatus.textContent = 'AI 解答中…（自适应批量、流式反馈、进度自动保存，中断可继续）';
      try {
        const solved = await LLM.solveQuestions(noAns, (done, total, got, note) => {
          if (total <= 0) { if (note) aiStatus.textContent = note; return; }
          bar.style.width = Math.round(done / total * 100) + '%';
          aiStatus.textContent = `${note ? note + ' · ' : ''}AI 解答中：${done}/${total} 题 · 已得 ${got} 个答案`;
        }, (chunkIdx, attempt, cool) => {
          aiStatus.textContent = cool > 0 ? `⏳ API 限流，冷却 ${cool}s 后重试（进度已保存）` : '网络波动，重试中…（进度已保存）';
        }, async (batch) => {
          for (const q of batch) if (q.answer) await DB.questionPut(q);
        });
        const remaining = noAns.filter(q => !q.answer).length;
        if (remaining) {
          aiStatus.textContent = `本轮补了 ${solved} 个答案；剩余 ${remaining} 题因网络波动未完成，点按钮继续（已完成的不会重复）`;
          btn.disabled = false;
          btn.textContent = `继续解答剩余 ${remaining} 题`;
          toast(`已补 ${solved} 个，剩 ${remaining} 个待网络恢复`);
        } else {
          aiStatus.textContent = `✓ AI 解答出 ${solved} 个答案`;
          toast(`AI 补了 ${solved} 个答案`);
          render();
        }
      } catch (e) {
        aiStatus.textContent = '⚠ ' + e.message.slice(0, 100);
        btn.disabled = false;
      }
    };

    // 方式三：AI 校验答案 + 补解析
    const verifyBtn = document.getElementById('ans-verify-btn');
    if (verifyBtn) verifyBtn.onclick = async () => {
      const targets = qs.filter(q => q.answer);
      if (!targets.length) return toast('没有可校验的题');
      const cfg = await LLM.getConfig();
      if (!cfg.apiKey) { toast('请先到「设置」配置 API Key'); return navigate('#/settings'); }
      verifyBtn.disabled = true;
      const vStatus = document.getElementById('ans-verify-status');
      const vResult = document.getElementById('verify-result');
      vStatus.textContent = 'AI 校验中…（独立重做每题，自适应批量、流式反馈，进度自动保存）';
      try {
        const res = await LLM.verifyQuestions(targets, (done, total, got, note) => {
          if (total <= 0) { if (note) vStatus.textContent = note; return; }
          bar.style.width = Math.round(done / total * 100) + '%';
          vStatus.textContent = `${note ? note + ' · ' : ''}AI 校验中：${done}/${total} 题 · 已核 ${got} 题`;
        }, (c, a, cool) => {
          vStatus.textContent = cool > 0 ? `⏳ API 限流，冷却 ${cool}s 后重试（进度已保存）` : '网络波动，重试中…（进度已保存）';
        }, async (batch) => {
          for (const q of batch) if (q.aiAnswer || q.explanation) await DB.questionPut(q);
        });
        // 兜底持久化（aiAnswer + 新解析）
        for (const q of targets) await DB.questionPut(q);
        const rate = res.checked ? Math.round(res.agree / res.checked * 100) : 0;
        const remain = targets.filter(q => !q.aiAnswer).length;
        vStatus.textContent = `校验完成：${res.checked} 题中 ${res.agree} 题一致（${rate}%）${res.explained ? ` · 补解析 ${res.explained} 题` : ''}`
          + (remain ? `；剩余 ${remain} 题因网络未校验，再点一次继续（已校验的不重复）` : '');
        if (remain) {
          verifyBtn.disabled = false;
          verifyBtn.textContent = `继续校验剩余 ${remain} 题`;
        }
        if (res.conflicts.length) {
          vResult.innerHTML = `
            <div style="margin-top:10px;color:var(--bad);font-weight:600">⚠ ${res.conflicts.length} 题答案不一致（原答案 vs AI 答案）：</div>
            ${res.conflicts.slice(0, 30).map(c => `
              <div style="font-size:12.5px;padding:6px 0;border-bottom:1px dashed var(--line)">
                <b>第${c.no ?? '?'}题</b> ${escapeHtml(c.stem)}…<br>
                原答案 <b style="color:var(--primary)">${escapeHtml(c.orig)}</b> ｜ AI 认为 <b style="color:var(--bad)">${escapeHtml(c.ai)}</b>
              </div>`).join('')}
            ${res.conflicts.length > 30 ? `<div class="muted small">…仅显示前 30 条</div>` : ''}
            <div class="muted small" style="margin-top:6px">原答案未改动。不一致的题建议查教材确认；确信 AI 对的可手动改答案。</div>`;
        } else {
          vResult.innerHTML = `<div style="margin-top:8px;color:var(--ok)">✓ 全部一致，答案可信</div>`;
        }
        toast(`校验完成：${res.agree}/${res.checked} 一致`);
      } catch (e) {
        vStatus.textContent = '⚠ ' + e.message.slice(0, 100);
        verifyBtn.disabled = false;
      }
    };
  }

  async function pageQuizSetup() {
    topbar('开始练习');
    const banks = (await DB.bankList()).sort((a, b) => b.createdAt - a.createdAt);
    if (!banks.length) {
      $view().innerHTML = `<div class="empty" style="padding-top:40px">暂无题库<br>请先导入文件</div>`;
      return;
    }
    // 读全每库题目：有答案数 + 各章节可练题数（供章节勾选与实时题量）
    const bankData = {};
    await Promise.all(banks.map(async b => {
      const qs = await DB.questionsByBank(b.id);
      const secCount = new Map();  // secIdx(字符串) -> 有答案题数
      let ans = 0;
      for (const q of qs) {
        const k = String(q.secIdx ?? '');
        if (q.answer) { ans++; secCount.set(k, (secCount.get(k) || 0) + 1); }
        else if (!secCount.has(k)) secCount.set(k, 0);
      }
      bankData[b.id] = { qs, ans, secCount };
    }));
    const total = banks.reduce((s, b) => s + bankData[b.id].ans, 0);
    const starCount = (await DB.starQuestions()).filter(q => q.answer).length;
    if (!total) {
      $view().innerHTML = `<div class="empty" style="padding-top:40px">暂无带答案的题目<br>请先导入文件并在题库列表「补答案」</div>`;
      return;
    }

    // ---- 选择状态 ----
    const sel = new Set(banks.map(b => b.id));  // 选中的题库
    const selSecs = new Set();                  // "bankId:secIdx"，空 = 全部章节
    const secCollapsed = new Set();             // 章节区：被折叠起来的题库 id（整库收起）
    let bankKw = '', bankExpanded = false, exam = false, timeMode = 'auto';
    const LIMIT = 6;

    $view().innerHTML = `
      <div class="card">
        <div class="card-title">范围（题库）</div>
        <div class="list-tools">
          <input id="setup-search" class="search-input" placeholder="搜索题库名称…">
          <div class="chips" id="pick-tools">
            <button class="chip" data-act="all">全选</button>
            <button class="chip" data-act="none">清空</button>
            <button class="chip" data-act="ans">只选有答案的库</button>
          </div>
        </div>
        <div class="bank-pick" id="bank-pick"></div>
        <button class="btn ghost" id="pick-more" style="display:none;margin-top:8px"></button>
      </div>

      <div class="card">
        <div class="card-title">范围（章节）</div>
        <div class="muted small" id="sec-sum">不选 = 全部章节</div>
        <div class="chips" id="sec-tools" style="margin-top:8px">
          <button class="chip" data-act="none">清空（=全部章节）</button>
        </div>
        <div id="sec-area"></div>
      </div>

      <div class="card">
        <div class="card-title">题型</div>
        <div class="seg" id="seg-type">
          <button data-v="all" class="on">全部</button>
          <button data-v="choice">选择/判断</button>
          <button data-v="fill">填空</button>
        </div>
        <div class="muted small" id="type-hint" style="margin-top:8px"></div>
      </div>

      <div class="card">
        <div class="card-title">模式</div>
        <div class="seg" id="seg-mode">
          <button data-v="learn" class="on">📖 学习模式</button>
          <button data-v="exam">📝 考试模式</button>
        </div>
        <div id="exam-opts" style="display:none;margin-top:10px">
          <div class="field"><span>考试时长</span>
            <div class="seg" id="seg-time">
              <button data-v="auto" class="on">按 1 分钟/题</button>
              <button data-v="none">不限时</button>
              <button data-v="custom">自定义</button>
            </div>
          </div>
          <div class="field" id="exam-min-wrap" style="display:none"><span>时长（分钟）</span>
            <input type="number" id="exam-min" min="1" max="600" value="60" inputmode="numeric">
          </div>
          <div class="muted small">考试模式：作答时<b>不显示对错与解析</b>，可自由跳题改动；交卷后统一判分，给出成绩单与错题解析。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">顺序</div>
        <div class="seg" id="seg-order">
          <button data-v="order" class="on">顺序</button>
          <button data-v="shuffle">随机</button>
        </div>
      </div>
      <button class="btn primary big" id="start-quiz"></button>
      <button class="btn ghost big" onclick="App.wrongRedo()">错题重做</button>
      ${starCount ? `<button class="btn ghost big" onclick="App.starRedo()">★ 收藏重练（${starCount}）</button>` : ''}`;

    const bankPickEl = document.getElementById('bank-pick');
    const pickMoreBtn = document.getElementById('pick-more');
    const secArea = document.getElementById('sec-area');
    const secSum = document.getElementById('sec-sum');
    const startBtn = document.getElementById('start-quiz');

    /* ---- 题库勾选（搜索 + 折叠，题库多也不用翻到底） ---- */
    function renderBanks() {
      const kw = bankKw.trim().toLowerCase();
      const arr = banks.filter(b => !kw || String(b.name).toLowerCase().includes(kw));
      const show = (bankExpanded || kw) ? arr : arr.slice(0, LIMIT);
      bankPickEl.innerHTML = arr.length ? show.map(b => {
        const d = bankData[b.id];
        return `<label class="pick-item"><input type="checkbox" value="${b.id}" ${sel.has(b.id) ? 'checked' : ''}>
          <span class="pick-name">${escapeHtml(b.name)}</span>
          <span class="muted small pick-num">${d.ans}${d.ans !== b.count ? '/' + b.count : ''}</span>
        </label>`;
      }).join('') : '<div class="muted small" style="padding:8px 0">没有匹配的题库</div>';
      bankPickEl.querySelectorAll('input').forEach(i => {
        i.onchange = () => { i.checked ? sel.add(i.value) : sel.delete(i.value); refresh(); };
      });
      pickMoreBtn.style.display = arr.length > LIMIT && !kw ? '' : 'none';
      pickMoreBtn.textContent = bankExpanded ? '收起列表' : `展开全部 ${arr.length} 个题库`;
    }

    /* ---- 章节勾选（按库分组，chip 点选；不选 = 全部章节） ---- */
    function renderSecs() {
      const parts = [];
      for (const b of banks) {
        if (!sel.has(b.id)) continue;
        const d = bankData[b.id];
        const list = (b.sections || []).filter(s => d.secCount.has(String(s.secIdx)));
        const hasNoSec = d.secCount.has('');
        if (!list.length && !hasNoSec) continue;
        const picked = list.filter(s => selSecs.has(b.id + ':' + s.secIdx)).length + (hasNoSec && selSecs.has(b.id + ':') ? 1 : 0);
        const totalSec = list.length + (hasNoSec ? 1 : 0);
        const folded = secCollapsed.has(b.id);
        parts.push(`
          <div class="sec-pick">
            <div class="sec-pick-head">
              <button class="sec-toggle" data-fold="${b.id}" title="${folded ? '展开本章节' : '折叠本章节'}">${folded ? '▸' : '▾'}</button>
              <b>${escapeHtml(b.name)}</b>
              <span class="muted small">${picked ? `已选 ${picked}/${totalSec}` : `${totalSec} 章`}</span>
              <button class="chip" data-bank="${b.id}">全选/清空</button>
            </div>
            ${folded ? '' : `<div class="chips">
              ${list.map(s => {
                const key = b.id + ':' + s.secIdx;
                const n = d.secCount.get(String(s.secIdx)) || 0;
                return `<button class="chip ${selSecs.has(key) ? 'on' : ''}" data-sec="${key}" title="${escapeHtml(s.title || '')}">${escapeHtml(shortTitle(s.title))}（${n}）</button>`;
              }).join('')}
              ${hasNoSec ? `<button class="chip ${selSecs.has(b.id + ':') ? 'on' : ''}" data-sec="${b.id}:" title="没有章节信息的题目">未分节（${d.secCount.get('') || 0}）</button>` : ''}
            </div>`}
          </div>`);
      }
      secArea.innerHTML = parts.length ? parts.join('') : '<div class="muted small" style="padding:8px 0">所选题库没有章节信息（可按题库整体练习）</div>';
      secSum.textContent = selSecs.size ? `已选 ${selSecs.size} 个章节（不选 = 全部章节）` : '不选 = 全部章节';
      // 整库折叠/展开
      secArea.querySelectorAll('button[data-fold]').forEach(btn => {
        btn.onclick = () => {
          const bid = btn.dataset.fold;
          secCollapsed.has(bid) ? secCollapsed.delete(bid) : secCollapsed.add(bid);
          renderSecs();
        };
      });
      // 章节 chip
      secArea.querySelectorAll('button[data-sec]').forEach(btn => {
        btn.onclick = () => {
          const key = btn.dataset.sec;
          selSecs.has(key) ? selSecs.delete(key) : selSecs.add(key);
          renderSecs(); refresh();
        };
      });
      // 整库全选/清空
      secArea.querySelectorAll('button[data-bank]').forEach(btn => {
        btn.onclick = () => {
          const bid = btn.dataset.bank;
          const d = bankData[bid];
          const keys = [];
          (banks.find(x => x.id === bid)?.sections || []).forEach(s => { if (d.secCount.has(String(s.secIdx))) keys.push(bid + ':' + s.secIdx); });
          if (d.secCount.has('')) keys.push(bid + ':');
          const allOn = keys.every(k => selSecs.has(k));
          keys.forEach(k => allOn ? selSecs.delete(k) : selSecs.add(k));
          renderSecs(); refresh();
        };
      });
    }

    function shortTitle(t) {
      const s = String(t || '未命名章节');
      return s.length > 18 ? s.slice(0, 17) + '…' : s;
    }

    /* ---- 实时可练题量 ---- */
    function curFilter() {
      const raw = document.querySelector('#seg-type .on').dataset.v;
      return raw === 'all' ? 'answered' : raw + '|answered';
    }
    function countAvail() {
      const raw = document.querySelector('#seg-type .on').dataset.v;
      let n = 0;
      for (const b of banks) {
        if (!sel.has(b.id)) continue;
        for (const q of bankData[b.id].qs) {
          if (!q.answer) continue;                                        // 练习只用有答案的题
          if (selSecs.size && !selSecs.has(q.bankId + ':' + String(q.secIdx ?? ''))) continue;
          if (raw === 'choice' && !['single', 'multi', 'judge'].includes(q.type)) continue;
          if (raw === 'fill' && q.type !== 'fill') continue;
          n++;
        }
      }
      return n;
    }
    function curMinutes(n) {
      if (!exam) return 0;
      if (timeMode === 'none') return 0;
      if (timeMode === 'custom') return Math.max(1, Math.min(600, parseInt(document.getElementById('exam-min').value, 10) || 60));
      return Math.max(1, n);   // 1 分钟/题
    }
    function refresh() {
      const n = countAvail();
      const mins = curMinutes(n);
      startBtn.textContent = n
        ? `开始${exam ? '考试' : '练习'}（${n} 题${exam && mins ? ` · ${mins} 分钟` : exam ? ' · 不限时' : ''}）`
        : '该筛选下没有可练的题（或都缺答案）';
      startBtn.disabled = !n;
      renderTypeHint(n);
    }
    function renderTypeHint(n) {
      document.getElementById('type-hint').textContent = `当前范围可练 ${n} 题`;
    }

    /* ---- 交互绑定 ---- */
    const searchEl = document.getElementById('setup-search');
    searchEl.oninput = () => { bankKw = searchEl.value; renderBanks(); };
    pickMoreBtn.onclick = () => { bankExpanded = !bankExpanded; renderBanks(); };
    document.getElementById('pick-tools').onclick = (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      if (b.dataset.act === 'all') banks.forEach(x => sel.add(x.id));
      else if (b.dataset.act === 'none') sel.clear();
      else banks.forEach(x => { if (bankData[x.id].ans) sel.add(x.id); });
      renderBanks(); renderSecs(); refresh();
    };
    document.getElementById('sec-tools').onclick = (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      selSecs.clear(); renderSecs(); refresh();
    };
    const segType = document.getElementById('seg-type');
    const segOrder = document.getElementById('seg-order');
    const segMode = document.getElementById('seg-mode');
    const segTime = document.getElementById('seg-time');
    [[segType], [segOrder], [segMode], [segTime]].forEach(([seg]) => {
      seg.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        if (seg === segMode) {
          exam = b.dataset.v === 'exam';
          document.getElementById('exam-opts').style.display = exam ? '' : 'none';
        }
        if (seg === segTime) {
          timeMode = b.dataset.v;
          document.getElementById('exam-min-wrap').style.display = timeMode === 'custom' ? '' : 'none';
        }
        refresh();
      };
    });
    document.getElementById('exam-min').oninput = refresh;

    startBtn.onclick = async () => {
      const ids = [...sel];
      if (!ids.length) return toast('请至少选择一个题库');
      const shuffle = segOrder.querySelector('.on').dataset.v === 'shuffle';
      const n = countAvail();
      const mins = curMinutes(n);
      session = await QuizBuilder.fromBanks(ids, {
        shuffle,
        filterType: curFilter(),
        secKeys: selSecs,
        exam,
        minutes: mins
      });
      if (!session.total) return toast('该筛选下没有可练的题（可能都缺答案）');
      if (exam) toast(mins ? `考试开始 · ${mins} 分钟` : '考试开始 · 不限时');
      navigate('#/quiz');
    };

    renderBanks();
    renderSecs();
    refresh();
  }

  async function wrongRedo() {
    session = await QuizBuilder.wrongRedo();
    if (!session.total) return toast('没有错题');
    navigate('#/quiz');
  }

  async function starRedo() {
    const qs = (await DB.starQuestions()).filter(q => q.answer);
    if (!qs.length) return toast('收藏的题都缺答案');
    session = new QuizSession(qs, { shuffle: true, mode: 'star' });
    navigate('#/quiz');
  }

  /* ================= 页面：答题 ================= */
  async function pageQuiz() {
    if (!session) return navigate('#/quiz-setup');
    // 考试中：超时自动交卷；已交卷：直接看成绩单
    if (session.inExam && session.deadline && Date.now() >= session.deadline) return submitExam(true);
    if (session.inExam && session.graded) return navigate('#/quiz-result');
    if (!session.inExam && session.finished) return navigate('#/quiz-result');

    const q = session.current;
    topbar(`${session.pos} / ${session.total}`, session.inExam ? null : '#/quiz-setup');
    const multi = q.type === 'multi';
    const optKeys = q.options ? Object.keys(q.options) : [];
    const starSet = new Set(await DB.starIds());
    const inExam = session.inExam;
    const examPicked = inExam ? (session.examAnswers.get(q.id) || '') : '';
    const donePct = session.total ? Math.round(session.progress.done / session.total * 100) : 0;

    $view().innerHTML = `
      <div class="quiz-head">
        <span class="q-type ${q.type}">${typeLabel[q.type]}</span>
        ${inExam ? `<span class="exam-timer" id="exam-timer">--:--</span>` : `<span class="quiz-prog">${session.progress.done} 已答</span>`}
        <button class="star-btn" id="sheet-btn" title="答题卡" style="font-size:19px">▦</button>
        <button class="star-btn" id="star-btn" title="收藏本题">☆</button>
        <button class="star-btn" id="edit-btn" title="修改答案与解析" style="font-size:19px">✎</button>
      </div>
      <div class="quiz-bar"><div class="quiz-bar-fill" style="width:${donePct}%"></div></div>
      ${inExam ? `<div class="exam-banner">📝 考试中 · 已答 ${session.progress.done}/${session.total} · 作答时不显示对错，交卷后统一评分</div>` : ''}
      <div class="card" id="sheet-card" style="display:none"></div>
      <div class="card" id="edit-card" style="display:none"></div>
      ${!q.answer ? `<div class="card" style="border-left:4px solid var(--bad)">
        <div class="small" style="color:var(--bad)">本题暂无标准答案 —— 点右上角 ✎ 填入答案与解析后即可作答判分（不填也能直接翻下一题）</div>
      </div>` : ''}
      <div class="card">
        <div class="stem">${renderStem(q)}</div>
        ${q.type === 'fill' ? `
          <div class="fill-area">
            ${(q.answer || '').split('|||').map((_, i) => `<input type="text" class="fill-input" placeholder="第 ${i + 1} 空" inputmode="text"
              value="${escapeHtml(String(examPicked || '').split('|||')[i] || '')}">`).join('')}
            <button class="btn primary" id="fill-submit">${inExam ? '保存答案' : '提交答案'}</button>
          </div>` : `
          <div class="options">
            ${optKeys.map(k => `
              <button class="option ${inExam && examPicked.toUpperCase().includes(k) ? 'picked' : ''}" data-k="${k}" ${multi ? '' : 'data-single'}>
                <span class="opt-key">${k}</span>
                <span class="opt-text">${escapeHtml(q.options[k])}</span>
              </button>`).join('')}
          </div>
          ${multi ? `<button class="btn primary big" id="multi-submit">${inExam ? '保存答案' : '提交答案'}</button>` : ''}`}
        <div class="judge-area" id="judge-area" style="display:none"></div>
        ${inExam ? `<div class="muted small" style="margin-top:10px">答案会自动保存，可随时回看或修改；点「交卷」后统一判分</div>` : ''}
      </div>
      <div class="quiz-nav">
        <button class="btn ghost" id="skip-btn" ${session.index === 0 ? 'disabled' : ''}>上一题</button>
        ${inExam
          ? `${session.index < session.total - 1 ? '<button class="btn ghost" id="next-btn">下一题</button>' : ''}
             <button class="btn primary" id="submit-exam-btn">交卷</button>`
          : '<button class="btn ghost" id="next-btn" style="display:none">下一题</button>'}
      </div>`;

    const judgeArea = document.getElementById('judge-area');
    const nextBtn = document.getElementById('next-btn');
    const answered = session.answered.get(q.id);
    const sheetCard = document.getElementById('sheet-card');
    const sheetBtn = document.getElementById('sheet-btn');
    let sheetOpen = false;

    /* ---- 答题卡：题号总览 + 状态着色 + 点题号跳题 ---- */
    function renderSheet() {
      const p = session.progress;
      const cells = session.list.map((item, i) => {
        const a = session.answered.get(item.id);
        const cls = ['sheet-cell'];
        let pick = '';
        if (inExam) {
          const ea = session.examAnswers.get(item.id);
          if (ea) { cls.push('filled'); pick = String(ea); }   // 考试中只标「已答」，不泄露对错
        } else if (a) {
          cls.push(a.correct ? 'done' : 'wrong');
          pick = String(a.userAnswer ?? '');
        }
        if (i === session.index) cls.push('cur');
        if (starSet.has(item.id)) cls.push('star');
        // 格子里带上「你选了什么」，一眼看清；填空答案太长就只留配色
        if (item.type === 'fill') pick = '';
        else { pick = pick.replace(/\|\|\|/g, '/'); if (pick.length > 3) pick = pick.slice(0, 3) + '…'; }
        return `<button class="${cls.join(' ')}" data-i="${i}" title="${pick ? '已答：' + escapeHtml(pick) : '未答'}">${i + 1}${pick ? `<span class="cell-pick">${escapeHtml(pick)}</span>` : ''}</button>`;
      }).join('');
      sheetCard.innerHTML = `
        <div class="card-title">答题卡 · 已答 ${p.done}/${p.total}${!inExam && p.done ? ` · 对 ${p.correct} · 错 ${p.wrong}` : ''}</div>
        <div class="sheet-grid">${cells}</div>
        <div class="sheet-legend">
          <span><i></i>未答</span>
          ${inExam ? '<span><i class="filled"></i>已答</span>' : '<span><i class="done"></i>答对</span><span><i class="wrong"></i>答错</span>'}
          <span><i class="cur"></i>当前题</span>
          <span>★ 收藏</span>
        </div>
        <div class="muted small" style="margin-top:8px">${inExam ? '格子下方小字是你已选答案；点题号直接跳到该题，答案可随时修改' : '格子下方小字是你选的答案；点题号直接跳到该题，已答过的题可随时回看答案与解析'}</div>`;
      sheetCard.querySelectorAll('.sheet-cell').forEach(b => {
        b.onclick = () => {
          session.jump(+b.dataset.i);
          saveProgress();
          render();
        };
      });
    }

    /* ---- 顶部进度条 + 已答文字：作答后实时更新 ---- */
    function updateBar() {
      const p = session.progress;
      const bar = document.querySelector('.quiz-bar-fill');
      if (bar) bar.style.width = (session.total ? Math.round(p.done / session.total * 100) : 0) + '%';
      const prog = document.querySelector('.quiz-prog');
      if (prog) prog.textContent = `${p.done} 已答`;
    }

    function showResult(res) {
      // 缺标准答案：不判分（先去 ✎ 补答案）
      if (res.noAnswer) return toast('本题暂无标准答案 —— 点右上角 ✎ 填入答案后即可作答判分');
      judgeArea.style.display = '';
      judgeArea.className = 'judge-area show ' + (res.correct ? 'ok' : 'bad');
      const yourAns = q.type === 'fill' ? res.userAnswer : res.userAnswer;
      const stdAns = q.type === 'fill' ? res.answer.replace(/\|\|\|/g, ' ／ ') : res.answer;
      judgeArea.innerHTML = `
        <div class="judge-title">${res.correct ? '✓ 回答正确' : '✗ 回答错误'}</div>
        <div class="judge-answer">正确答案：${escapeHtml(stdAns)}${q.type !== 'fill' ? '' : `（你的：${escapeHtml(String(yourAns).replace(/\|\|\|/g, ' ／ '))}）`}</div>
        ${res.explanation ? `<div class="judge-exp">解析：${escapeHtml(res.explanation)}</div>` : ''}
        ${q.aiAnswer && q.aiAnswer !== q.answer ? `<div class="judge-exp" style="color:var(--bad)">⚠ AI 校验认为此题答案可能是 ${escapeHtml(q.aiAnswer)}
          <button class="btn ghost" style="padding:4px 12px;font-size:12.5px;margin-left:8px" onclick="window.__acceptAI()">采纳 AI 答案</button></div>` : ''}
        ${!res.correct && q.type === 'fill' ? '' : ''}`;
      if (nextBtn) nextBtn.style.display = '';
      // 标记选项对错
      if (q.type !== 'fill') {
        document.querySelectorAll('.option').forEach(el => {
          const k = el.dataset.k;
          const inStd = q.answer.toUpperCase().includes(k);
          const inUser = String(res.userAnswer).toUpperCase().includes(k);
          el.classList.add('disabled');
          if (inStd) el.classList.add('right');
          if (inUser && !inStd) el.classList.add('wrong');
        });
        const fi = document.querySelector('.fill-area'); if (fi) fi.style.display = 'none';
      } else {
        document.querySelectorAll('.fill-input').forEach(i => i.disabled = true);
        const fs = document.getElementById('fill-submit'); if (fs) fs.style.display = 'none';
      }
      // 答题卡开着时实时更新对错着色
      if (sheetOpen) renderSheet();
      updateBar();
    }

    if (answered) showResult(answered);
    // 缺标准答案的题：不判分，直接允许翻下一题
    if (!q.answer && nextBtn) nextBtn.style.display = '';

    /* ---- 考试模式：只存答案不判分（自动保存，可随时改） ---- */
    const saveExam = (val) => {
      if (!String(val).replace(/\|\|\|/g, '').trim()) session.examAnswers.delete(q.id);
      else session.answer(val);
      saveProgress();
      const banner = document.querySelector('.exam-banner');
      if (banner) banner.textContent = `📝 考试中 · 已答 ${session.progress.done}/${session.total} · 作答时不显示对错，交卷后统一评分`;
      updateBar();
      if (sheetOpen) renderSheet();
    };

    if (q.type === 'fill') {
      const inputs = [...document.querySelectorAll('.fill-input')];
      if (inExam) inputs.forEach(i => i.oninput = () => saveExam(inputs.map(x => x.value.trim()).join('|||')));
      const submit = () => {
        const vals = inputs.map(i => i.value.trim()).join('|||');
        if (!vals.replace(/\|\|\|/g, '')) return toast('请先填写答案');
        if (inExam) { saveExam(vals); return toast('已保存，交卷后统一判分'); }
        const res = session.submit(vals);
        if (res) showResult({ ...res, userAnswer: vals });
      };
      document.getElementById('fill-submit').onclick = submit;
    } else {
      // 考试模式：选项可反复改；picked 初值来自已保存的答案（回看时高亮）
      let picked = new Set(inExam && examPicked ? examPicked.toUpperCase().split('') : []);
      document.querySelectorAll('.option').forEach(el => {
        el.onclick = () => {
          if (!inExam && (answered || el.classList.contains('disabled'))) return;
          const k = el.dataset.k;
          if (multi) {
            picked.has(k) ? picked.delete(k) : picked.add(k);
            el.classList.toggle('picked');
            if (inExam) saveExam([...picked].sort().join(''));
          } else {
            picked = new Set([k]);
            document.querySelectorAll('.option').forEach(x => x.classList.remove('picked'));
            el.classList.add('picked');
            if (inExam) { saveExam(k); return; }
            const res = session.submit(k);
            if (res) showResult({ ...res, userAnswer: k });
          }
        };
      });
      const ms = document.getElementById('multi-submit');
      if (ms) ms.onclick = () => {
        if (!picked.size) return toast('请先选择答案');
        const ans = [...picked].sort().join('');
        if (inExam) { saveExam(ans); return toast('已保存，交卷后统一判分'); }
        const res = session.submit(ans);
        if (res) showResult({ ...res, userAnswer: ans });
      };
    }

    document.getElementById('skip-btn').onclick = () => { if (session.index > 0) { session.index--; saveProgress(); render(); } };
    if (nextBtn) nextBtn.onclick = () => {
      session.next();
      saveProgress();
      if (session.finished) navigate('#/quiz-result'); // hash 变化自动触发 render
      else render(); // hash 未变，手动渲染
    };
    // 考试：手动交卷
    const examSubmitBtn = document.getElementById('submit-exam-btn');
    if (examSubmitBtn) examSubmitBtn.onclick = () => submitExam(false);
    if (inExam && session.deadline) startExamTimer();

    // 答题卡开关
    if (sheetBtn) sheetBtn.onclick = () => {
      sheetOpen = !sheetOpen;
      if (sheetOpen) {
        renderSheet();
        sheetCard.style.display = '';
        sheetCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        sheetCard.style.display = 'none';
      }
    };

    // 收藏本题：状态已在渲染时读好，点击切换
    const starBtn = document.getElementById('star-btn');
    if (starBtn && starSet.has(q.id)) { starBtn.textContent = '★'; starBtn.classList.add('on'); }
    if (starBtn) starBtn.onclick = async () => {
      const added = await DB.starToggle(q.id);
      starBtn.textContent = added ? '★' : '☆';
      starBtn.classList.toggle('on', added);
      if (added) starSet.add(q.id); else starSet.delete(q.id);
      if (sheetOpen) renderSheet();
      toast(added ? '已收藏' : '已取消收藏');
    };

    /* ---- 编辑答案与解析（当场纠错） ---- */
    const editCard = document.getElementById('edit-card');
    const editBtn = document.getElementById('edit-btn');
    let editOpen = false;
    function renderEditPanel() {
      const isFill = q.type === 'fill';
      editCard.innerHTML = `
        <div class="card-title">修改本题（第 ${q.no ?? '?'} 题）</div>
        <div class="field"><span>答案${isFill ? '（多空用 / 分隔）' : ''}</span>
          ${isFill
            ? `<input type="text" id="edit-ans" value="${escapeHtml(String(q.answer ?? '').replace(/\|\|\|/g, '/'))}" placeholder="标准答案">`
            : `<div class="seg" id="edit-letters" style="flex-wrap:wrap">
                ${optKeys.map(k => `<button data-k="${k}" class="${q.answer && q.answer.toUpperCase().includes(k) ? 'on' : ''}" style="flex:0 0 auto;min-width:52px;padding:8px 14px">${k}</button>`).join('')}
              </div>`}
        </div>
        <div class="field"><span>解析</span>
          <textarea id="edit-exp" rows="3" style="border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;background:var(--card);color:var(--text);width:100%">${escapeHtml(q.explanation || '')}</textarea>
        </div>
        <div class="btn-row">
          <button class="btn ghost" id="edit-cancel">取消</button>
          <button class="btn primary" id="edit-save">保存修改</button>
        </div>`;
      // 字母选择
      const letters = editCard.querySelector('#edit-letters');
      if (letters) {
        letters.onclick = e => {
          const b = e.target.closest('button[data-k]'); if (!b) return;
          if (q.type === 'multi') b.classList.toggle('on');
          else { letters.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); }
        };
      }
      editCard.querySelector('#edit-cancel').onclick = () => { editOpen = false; editCard.style.display = 'none'; };
      editCard.querySelector('#edit-save').onclick = async () => {
        let newAns;
        if (isFill) {
          newAns = document.getElementById('edit-ans').value.trim().split('/').map(s => s.trim()).filter(Boolean).join('|||');
          if (!newAns) return toast('答案不能为空');
        } else {
          newAns = [...letters.querySelectorAll('button.on')].map(b => b.dataset.k).sort().join('');
          if (!newAns) return toast('请选择答案字母');
        }
        const newExp = document.getElementById('edit-exp').value.trim();
        q.answer = newAns;
        q.explanation = newExp || null;
        await DB.questionPut(q);
        // 本题若已答过，清除作答状态让用户按新答案重做
        session.answered.delete(q.id);
        editOpen = false;
        toast('已修改');
        render();
      };
    }
    if (editBtn) editBtn.onclick = () => {
      editOpen = !editOpen;
      if (editOpen) { renderEditPanel(); editCard.style.display = ''; editCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else editCard.style.display = 'none';
    };

    /* ---- 冲突时一键采纳 AI 答案 ---- */
    function acceptAI() {
      q.answer = q.aiAnswer;
      delete q.aiAnswer;
      session.answered.delete(q.id);
      DB.questionPut(q).then(() => { toast('已采纳 AI 答案'); render(); });
    }
    window.__acceptAI = acceptAI;

    // 左右滑翻题：左滑=下一题（需已答），右滑=上一题
    let touchX = null, touchY = null, touchT = 0;
    $view().addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { touchX = null; return; }
      touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; touchT = Date.now();
    }, { passive: true });
    $view().addEventListener('touchend', e => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      const dt = Date.now() - touchT;
      touchX = null;
      // 快速横向滑动 60px+ 且横向位移明显大于纵向
      if (dt < 600 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) { // 左滑 → 下一题（考试模式可自由翻题，无需先作答）
          if (!inExam && !session.answered.get(session.current.id) && session.current.answer) return toast('请先作答再翻下一题');
          if (nextBtn && nextBtn.style.display !== 'none') nextBtn.click();
        } else if (session.index > 0) { // 右滑 → 上一题
          document.getElementById('skip-btn').click();
        }
      }
    }, { passive: true });

    saveProgress();
  }

  function renderStem(q) {
    let s = escapeHtml(q.stem);
    if (q.type === 'fill') s = s.replace(/_{2,}/g, '<span class="blank">（　　）</span>');
    return s;
  }

  /* ================= 页面：结果（练习 / 考试成绩单） ================= */
  function pageQuizResult() {
    if (!session) return navigate('#/home');
    if (session.exam && !session.graded) session.grade();   // 兜底：未交卷进来先判分
    const exam = session.exam;
    const r = session.result();
    topbar(exam ? '考试成绩' : '练习结果', '#/home');

    if (!exam) {
      const p = session.progress;
      const acc = p.done ? Math.round(p.correct / p.done * 100) : 0;
      $view().innerHTML = `
        <div class="result-hero">
          <div class="result-ring" style="--p:${acc}">
            <div class="result-acc">${acc}<small>%</small></div>
          </div>
          <div class="result-row">
            <div class="result-cell"><b>${p.done}</b><span>已答</span></div>
            <div class="result-cell"><b>${p.correct}</b><span>答对</span></div>
            <div class="result-cell"><b>${p.wrong}</b><span>答错</span></div>
          </div>
        </div>
        <button class="btn primary big" onclick="App.replay()">再来一轮（错题优先）</button>
        <button class="btn ghost big" onclick="App.finishQuiz()">返回题库</button>`;
      return;
    }

    // ---- 考试：成绩单 + 逐题解析（可筛选 / 逐题翻阅 / 题号跳转） ----
    const wrongs = session.wrongList();
    const mm = Math.floor(r.timeUsed / 60), ss = r.timeUsed % 60;
    // 把整张卷子摊平：每题带上「你选了什么 / 对不对」，供逐题回看
    const rows = session.list.map((q, i) => {
      const a = session.answered.get(q.id);
      const ua = a ? a.userAnswer : (session.examAnswers.get(q.id) || null);
      const status = !a ? 'none' : (a.correct ? 'ok' : 'bad');
      return { q, a, ua, status, no: i + 1 };
    });
    const nOk = rows.filter(x => x.status === 'ok').length;
    const nBad = rows.filter(x => x.status === 'bad').length;
    const nNone = rows.filter(x => x.status === 'none').length;

    $view().innerHTML = `
      <div class="result-hero">
        <div class="result-ring" style="--p:${r.acc}">
          <div class="result-acc">${r.acc}<small>分</small></div>
        </div>
        <div class="result-row">
          <div class="result-cell"><b>${r.total}</b><span>总题数</span></div>
          <div class="result-cell"><b style="color:var(--ok)">${r.correct}</b><span>答对</span></div>
          <div class="result-cell"><b style="color:var(--bad)">${r.wrong}</b><span>答错</span></div>
          <div class="result-cell"><b>${r.unanswered}</b><span>未答</span></div>
        </div>
        <div class="muted small" style="margin-top:10px">用时 ${mm} 分 ${ss} 秒 · 已答 ${r.answered} 题</div>
      </div>

      <div class="card">
        <div class="card-title">逐题解析</div>
        <div class="chips" id="rev-filter">
          <button class="chip" data-v="all">全部 ${r.total}</button>
          <button class="chip" data-v="bad">答错 ${nBad}</button>
          <button class="chip" data-v="none">未答 ${nNone}</button>
          <button class="chip" data-v="ok">答对 ${nOk}</button>
        </div>
        <div class="rev-nav">
          <button class="btn ghost" id="rev-prev">‹ 上一题</button>
          <span class="rev-pos" id="rev-pos"></span>
          <button class="btn ghost" id="rev-next">下一题 ›</button>
        </div>
        <div id="rev-body"></div>
        <button class="btn ghost" id="rev-jump-btn" style="margin-top:10px">▦ 题号速览（点号码跳题）</button>
        <div id="rev-jump" style="display:none"></div>
      </div>

      ${wrongs.length
        ? `<button class="btn primary big" onclick="App.examWrongRedo()">重做错题（${wrongs.length}）</button>`
        : `<div class="card"><div class="card-title">全部答对 🎉</div><div class="muted small">这套题没有错题，继续保持。</div></div>`}
      <button class="btn ghost big" onclick="App.replay()">再来一轮</button>
      <button class="btn ghost big" onclick="App.finishQuiz()">返回题库</button>`;

    /* ---- 逐题解析：筛选 + 逐题翻阅 + 题号跳转 ---- */
    let revFilter = (nBad + nNone) ? 'bad' : 'all';   // 优先看错题；全对则看全部
    let revIdx = 0;
    const revRows = () => revFilter === 'all' ? rows
      : revFilter === 'bad' ? rows.filter(x => x.status === 'bad')
      : revFilter === 'none' ? rows.filter(x => x.status === 'none')
      : rows.filter(x => x.status === 'ok');

    // 单题详情卡：选项高亮「正确答案 / 你的选择」，填空给「你的 / 正确」对照
    function reviewCard(x) {
      const { q, ua, status, no } = x;
      const badge = status === 'ok' ? '<span class="rev-status ok">答对</span>'
        : status === 'bad' ? '<span class="rev-status bad">答错</span>'
        : '<span class="rev-status none">未作答</span>';
      let body;
      if (q.type === 'fill') {
        const u = (ua != null && ua !== '') ? escapeHtml(String(ua).replace(/\|\|\|/g, ' ／ ')) : '（未作答）';
        const c = escapeHtml((q.answer || '—').replace(/\|\|\|/g, ' ／ '));
        body = `<div class="rev-ans">
          <div class="rev-ans-row"><span class="rev-ans-k">你的</span><span class="${status === 'ok' ? 'rev-ua-ok' : (ua ? 'rev-ua-bad' : 'rev-ua-none')}">${u}</span></div>
          <div class="rev-ans-row"><span class="rev-ans-k">正确</span><span class="rev-ua-ok">${c}</span></div>
        </div>`;
      } else {
        const optKeys = q.options ? Object.keys(q.options) : [];
        const norm = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
        const correct = new Set(norm(q.answer).split(''));
        const picked = new Set(norm(ua).split(''));
        body = `<div class="options">${optKeys.map(k => {
          const isC = correct.has(k), isP = picked.has(k);
          const cls = ['option', 'disabled'];
          if (isC) cls.push('right');
          if (isP && !isC) cls.push('wrong');
          if (isP) cls.push('picked');
          const mark = isC && isP ? '<span class="opt-mark ok">你的选择 ✓</span>'
            : isC ? '<span class="opt-mark ok">正确答案</span>'
            : isP ? '<span class="opt-mark bad">你的选择</span>' : '';
          return `<button class="${cls.join(' ')}">
            <span class="opt-key">${k}</span>
            <span class="opt-text">${escapeHtml(q.options[k])}</span>
            ${mark}
          </button>`;
        }).join('')}</div>`;
      }
      return `<div class="rev-card">
        <div class="rev-head">
          <span class="rev-no">${no}</span>
          <span class="q-type ${q.type}">${typeLabel[q.type]}</span>
          ${badge}
        </div>
        <div class="stem sm">${renderStem(q)}</div>
        ${body}
        ${q.explanation ? `<div class="judge-exp sm">解析：${escapeHtml(q.explanation)}</div>` : '<div class="muted small" style="margin-top:8px">（本题无解析）</div>'}
      </div>`;
    }

    function renderReview() {
      const list = revRows();
      const bodyEl = document.getElementById('rev-body');
      const posEl = document.getElementById('rev-pos');
      const prevBtn = document.getElementById('rev-prev');
      const nextBtn = document.getElementById('rev-next');
      if (!list.length) {
        bodyEl.innerHTML = '<div class="muted small" style="padding:12px 0">该筛选下没有题目</div>';
        posEl.textContent = '0 / 0';
        prevBtn.disabled = nextBtn.disabled = true;
        const j0 = document.getElementById('rev-jump');
        if (j0) j0.innerHTML = '';
        return;
      }
      if (revIdx >= list.length) revIdx = list.length - 1;
      if (revIdx < 0) revIdx = 0;
      const x = list[revIdx];
      bodyEl.innerHTML = reviewCard(x);
      posEl.textContent = `${revIdx + 1} / ${list.length} · 第 ${x.no} 题`;
      prevBtn.disabled = revIdx === 0;
      nextBtn.disabled = revIdx === list.length - 1;
      const jump = document.getElementById('rev-jump');
      if (jump && jump.style.display !== 'none') {
        jump.innerHTML = `<div class="sheet-grid">${list.map((y, i) =>
          `<button class="sheet-cell ${y.status === 'ok' ? 'done' : y.status === 'bad' ? 'wrong' : ''} ${i === revIdx ? 'cur' : ''}" data-ri="${i}">${y.no}</button>`).join('')}</div>`;
        jump.querySelectorAll('.sheet-cell').forEach(b => {
          b.onclick = () => { revIdx = +b.dataset.ri; renderReview(); document.getElementById('rev-body').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
        });
      }
    }

    document.getElementById('rev-filter').querySelectorAll('.chip').forEach(b => {
      b.classList.toggle('on', b.dataset.v === revFilter);
      b.onclick = () => {
        revFilter = b.dataset.v;
        revIdx = 0;
        document.getElementById('rev-filter').querySelectorAll('.chip').forEach(o => o.classList.toggle('on', o === b));
        renderReview();
      };
    });
    document.getElementById('rev-prev').onclick = () => { if (revIdx > 0) { revIdx--; renderReview(); } };
    document.getElementById('rev-next').onclick = () => { if (revIdx < revRows().length - 1) { revIdx++; renderReview(); } };
    document.getElementById('rev-jump-btn').onclick = () => {
      const j = document.getElementById('rev-jump');
      const open = j.style.display === 'none';
      j.style.display = open ? '' : 'none';
      document.getElementById('rev-jump-btn').textContent = open ? '▦ 收起题号速览' : '▦ 题号速览（点号码跳题）';
      if (open) renderReview();
    };
    renderReview();
  }

  function finishQuiz() {
    session = null;
    DB.metaSet('lastSession', null);
    navigate('#/home');
  }
  async function clearProgress() {
    await DB.metaSet('lastSession', null);
    toast('已清除，重新开始');
    render();
  }

  async function replay() {
    session = null;
    navigate('#/quiz-setup');
  }

  /** 考试交卷后：只重做错题与未答（切回学习模式，逐题给解析） */
  async function examWrongRedo() {
    if (!session) return navigate('#/quiz-setup');
    const list = session.wrongList().map(x => x.q);
    if (!list.length) return toast('没有错题');
    session = new QuizSession(list, { shuffle: true });
    navigate('#/quiz');
  }

  /* ================= 页面：错题本 ================= */
  async function pageWrong() {
    topbar('错题本');
    const qs = await DB.wrongQuestions();
    if (!qs.length) {
      $view().innerHTML = `<div class="empty" style="padding-top:40px">没有错题<br>继续保持！</div>`;
      return;
    }
    $view().innerHTML = `
      <button class="btn primary big" onclick="App.wrongRedo()">重做全部错题（${qs.length}）</button>
      <div class="wrong-list">
        ${qs.map(q => `
          <div class="card wrong-card">
            <div class="wrong-head"><span class="q-type ${q.type}">${typeLabel[q.type]}</span></div>
            <div class="stem sm">${renderStem(q)}</div>
            <div class="wrong-ans">答案：${escapeHtml(q.answer.replace(/\|\|\|/g, ' ／ '))}</div>
            ${q.explanation ? `<div class="judge-exp sm">解析：${escapeHtml(q.explanation)}</div>` : ''}
          </div>`).join('')}
      </div>`;
  }

  /* ================= 页面：统计 ================= */
  async function pageStats() {
    topbar('学习统计');
    const s = await DB.stats();
    const days = Object.entries(s.byDay).sort().slice(-14);
    const max = Math.max(1, ...days.map(([, v]) => v.total));
    const acc = s.total ? Math.round(s.correct / s.total * 100) : 0;
    const wrongCount = (await DB.wrongQuestions()).length;

    /* ---- 章节正确率：题目 → 章节 → 最近一次作答（薄弱章节置顶） ---- */
    const banks = await DB.bankList();
    const qById = new Map();
    for (const b of banks) (await DB.questionsByBank(b.id)).forEach(q => qById.set(q.id, q));
    const latest = await DB.latestByQuestion();
    const secTitle = new Map();
    for (const b of banks) for (const sec of (b.sections || [])) secTitle.set(b.id + ':' + String(sec.secIdx), sec.title);
    const bankName = new Map(banks.map(b => [b.id, b.name]));
    const agg = new Map();
    for (const [qid, rec] of Object.entries(latest)) {
      const q = qById.get(qid);
      if (!q) continue;
      const secIdx = String(q.secIdx ?? '');
      const key = q.bankId + ':' + secIdx;
      const cur = agg.get(key) || { key, bankId: q.bankId, secIdx, total: 0, correct: 0 };
      cur.total++;
      if (rec.correct) cur.correct++;
      agg.set(key, cur);
    }
    const rows = [...agg.values()].map(x => ({
      ...x,
      acc: Math.round(x.correct / x.total * 100),
      title: secTitle.get(x.key) || (x.secIdx === '' ? '未分节' : `第 ${x.secIdx} 节`),
      bank: bankName.get(x.bankId) || ''
    })).sort((a, b) => a.acc - b.acc || b.total - a.total);
    let onlyWeak = false;
    const LIMIT = 12;

    $view().innerHTML = `
      <div class="stats-row">
        <div class="stat-cell"><b>${s.total}</b><span>累计答题</span></div>
        <div class="stat-cell"><b>${acc}%</b><span>正确率</span></div>
        <div class="stat-cell"><b>${wrongCount}</b><span>当前错题</span></div>
      </div>
      <div class="card">
        <div class="card-title">章节正确率（薄弱在前）</div>
        ${rows.length ? `
        <div class="chips" id="sec-filter" style="margin-bottom:10px">
          <button class="chip on" data-v="all">全部章节（${rows.length}）</button>
          <button class="chip" data-v="weak">只看薄弱 &lt;60%（${rows.filter(r => r.acc < 60).length}）</button>
        </div>
        <div id="sec-acc-list"></div>
        <button class="btn ghost" id="sec-more" style="display:none;margin-top:8px"></button>
        <div class="muted small" style="margin-top:8px">按「最近一次作答」统计；点某一行可直接开始练这一章</div>`
        : '<div class="muted">还没有作答记录，练几道题就能看到各章节的掌握情况</div>'}
      </div>
      <div class="card">
        <div class="card-title">近 ${days.length} 日答题量</div>
        ${days.length ? `<div class="chart">
          ${days.map(([d, v]) => `<div class="col" title="${d}：${v.total} 题">
            <div class="col-track"><div class="col-bar" style="height:${Math.round(v.total / max * 100)}%"></div></div>
            <span class="col-label"><span class="lb-full">${d.slice(5)}</span><span class="lb-mini">${d.slice(8)}</span></span></div>`).join('')}
        </div>` : '<div class="muted">暂无答题记录</div>'}
      </div>`;

    if (!rows.length) return;
    let expanded = false;
    const listEl = document.getElementById('sec-acc-list');
    const moreBtn = document.getElementById('sec-more');

    function renderRows() {
      let arr = onlyWeak ? rows.filter(r => r.acc < 60) : rows;
      const show = expanded ? arr : arr.slice(0, LIMIT);
      listEl.innerHTML = arr.length ? show.map(r => `
        <div class="sec-acc-row" data-bank="${r.bankId}" data-sec="${escapeHtml(r.secIdx)}">
          <div class="sec-acc-top">
            <span class="sec-acc-name" title="${escapeHtml((r.bank ? r.bank + ' · ' : '') + r.title)}">${escapeHtml((r.bank ? r.bank + ' · ' : '') + r.title)}</span>
            <span class="sec-acc-num" style="color:${r.acc >= 60 ? 'var(--ok)' : 'var(--bad)'}">${r.acc}%</span>
          </div>
          <div class="acc-track"><div class="acc-fill" style="width:${r.acc}%;background:${r.acc >= 60 ? 'var(--ok)' : 'var(--bad)'}"></div></div>
          <div class="muted small">${r.correct}/${r.total} 题 · 点此行练这一章</div>
        </div>`).join('') : '<div class="muted small">这一档暂时没有章节</div>';
      listEl.querySelectorAll('.sec-acc-row').forEach(el => {
        el.onclick = () => practiceSection(el.dataset.bank, el.dataset.sec);
      });
      if (arr.length > LIMIT) {
        moreBtn.style.display = '';
        moreBtn.textContent = expanded ? '收起' : `展开全部 ${arr.length} 个章节`;
      } else moreBtn.style.display = 'none';
    }
    document.getElementById('sec-filter').onclick = (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      document.getElementById('sec-filter').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onlyWeak = b.dataset.v === 'weak';
      expanded = false;
      renderRows();
    };
    moreBtn.onclick = () => { expanded = !expanded; renderRows(); };
    renderRows();
  }

  /** 统计页点章节 → 直接开练这一章（学习模式，只练有答案的题） */
  async function practiceSection(bankId, secIdx) {
    const key = bankId + ':' + (secIdx || '');
    session = await QuizBuilder.fromBanks([bankId], { filterType: 'answered', secKeys: new Set([key]) });
    if (!session.total) return toast('该章节没有带答案的题可练');
    navigate('#/quiz');
  }

  /* ================= 页面：设置 ================= */
  async function pageSettings() {
    topbar('设置');
    const cfg = await LLM.getConfig();
    const theme = (await DB.metaGet('theme')) || 'auto';
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">外观</div>
        <div class="seg" id="seg-theme">
          <button data-v="auto" class="${theme === 'auto' ? 'on' : ''}">跟随系统</button>
          <button data-v="light" class="${theme === 'light' ? 'on' : ''}">☀ 日间</button>
          <button data-v="dark" class="${theme === 'dark' ? 'on' : ''}">🌙 夜间</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">AI 接口（AI 辅助录入答案 / AI 解答 / AI 校验 使用）</div>
        <label class="field"><span>Base URL</span>
          <input id="set-url" value="${escapeHtml(cfg.baseUrl)}" placeholder="https://api.deepseek.com/v1">
        </label>
        <label class="field"><span>API Key</span>
          <input id="set-key" type="password" value="${escapeHtml(cfg.apiKey)}" placeholder="sk-...">
        </label>
        <label class="field"><span>模型名称</span>
          <input id="set-model" value="${escapeHtml(cfg.model)}" placeholder="deepseek-chat">
        </label>
        <label class="field"><span>解析并发数（1-8，越大越快，过高可能被限流）</span>
          <input id="set-conc" type="number" min="1" max="8" value="${cfg.concurrency || 4}">
        </label>
        <div class="muted small">常用：DeepSeek（api.deepseek.com/v1，model: deepseek-chat）· 智谱（open.bigmodel.cn/api/paas/v4，model: glm-4-flash）· 其他 OpenAI 兼容接口均可</div>
        <div class="btn-row">
          <button class="btn ghost" id="test-btn">测试连接</button>
          <button class="btn primary" id="save-btn">保存</button>
        </div>
        <div class="muted small" id="test-result"></div>
      </div>
      <div class="card">
        <div class="card-title">数据</div>
        <button class="btn ghost" onclick="App.clearRecords()">清空答题记录</button>
      </div>
      <div class="card">
        <div class="card-title">备份与恢复</div>
        <p class="muted small">题库存于浏览器，清浏览器数据会丢失。导出 JSON 备份可跨设备迁移（换手机 / 换浏览器时用）。</p>
        <button class="btn primary" id="backup-btn">导出全部题库</button>
        <button class="btn ghost" id="restore-btn" style="margin-left:8px">导入备份</button>
        <input type="file" id="restore-input" accept=".json" style="display:none">
        <div class="muted small" id="backup-status"></div>
      </div>
      <div class="muted small center">刷题宝 v${VERSION} · 本地题库存储于浏览器 IndexedDB<br>手机浏览器打开即用，可"添加到主屏幕"当 APP 使用</div>`;

    // 备份：导出全部题库 JSON（APK 走原生桥接写 Download，浏览器走 <a download>）
    document.getElementById('backup-btn').onclick = async () => {
      const st = document.getElementById('backup-status');
      try {
        const banks = await DB.bankList();
        if (!banks.length) return toast('题库为空，无可导出');
        const all = { version: 1, exportedAt: new Date().toISOString(), banks, questions: {} };
        for (const b of banks) all.questions[b.id] = await DB.questionsByBank(b.id);
        const fileName = `刷题宝备份_${new Date().toISOString().slice(0, 10)}.json`;
        const r = await saveTextFile(fileName, JSON.stringify(all), 'application/json');
        st.textContent = `✓ 已导出 ${banks.length} 个题库、${banks.reduce((s, b) => s + b.count, 0)} 题 → ${r.path}`;
      } catch (e) {
        st.textContent = '⚠ ' + (e.message || String(e)).slice(0, 80);
      }
    };
    // 恢复：导入备份 JSON（按题库名合并，已有同名库跳过）
    const restoreInput = document.getElementById('restore-input');
    document.getElementById('restore-btn').onclick = () => restoreInput.click();
    restoreInput.onchange = async () => {
      const f = restoreInput.files[0];
      if (!f) return;
      const st = document.getElementById('backup-status');
      st.textContent = '读取备份…';
      try {
        const data = JSON.parse(await f.text());
        if (!data.banks || !data.questions) throw new Error('不是有效的备份文件');
        const existing = await DB.bankList();
        const existingNames = new Set(existing.map(b => b.name));
        let added = 0, skipped = 0;
        for (const b of data.banks) {
          if (existingNames.has(b.name)) { skipped++; continue; }
          const qs = data.questions[b.id] || [];
          const newId = DB.uid();
          const nb = { ...b, id: newId, createdAt: Date.now() };
          const nqs = qs.map(q => ({ ...q, id: DB.uid(), bankId: newId }));
          await DB.questionAddMany(nqs);
          await DB.bankAdd(nb);
          added++;
        }
        st.textContent = `✓ 恢复完成：导入 ${added} 个题库${skipped ? `，跳过同名 ${skipped} 个` : ''}`;
        toast('备份已恢复');
      } catch (e) {
        st.textContent = '⚠ ' + e.message.slice(0, 80);
      }
    };

    // 外观切换：立即生效并保存
    const segTheme = document.getElementById('seg-theme');
    if (segTheme) segTheme.onclick = async (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      segTheme.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      await DB.metaSet('theme', b.dataset.v);
      applyTheme();
      toast(b.dataset.v === 'auto' ? '已跟随系统' : (b.dataset.v === 'dark' ? '已切换夜间' : '已切换日间'));
    };


    document.getElementById('save-btn').onclick = async () => {
      await LLM.saveConfig({
        baseUrl: document.getElementById('set-url').value.trim(),
        apiKey: document.getElementById('set-key').value.trim(),
        model: document.getElementById('set-model').value.trim() || 'deepseek-chat',
        concurrency: Math.max(1, Math.min(8, parseInt(document.getElementById('set-conc').value, 10) || 4))
      });
      toast('已保存');
    };
    document.getElementById('test-btn').onclick = async () => {
      const r = document.getElementById('test-result');
      r.textContent = '测试中…';
      // 先临时保存再测试
      await LLM.saveConfig({
        baseUrl: document.getElementById('set-url').value.trim(),
        apiKey: document.getElementById('set-key').value.trim(),
        model: document.getElementById('set-model').value.trim() || 'deepseek-chat',
        concurrency: Math.max(1, Math.min(8, parseInt(document.getElementById('set-conc').value, 10) || 4))
      });
      try {
        const ok = await LLM.testConnection();
        r.textContent = '✓ 连接成功：' + ok.slice(0, 50);
      } catch (e) {
        r.textContent = '✗ ' + e.message.slice(0, 120);
      }
    };
  }

  async function clearRecords() {
    if (!confirmDialog('清空全部答题记录和错题本？题目不受影响。')) return;
    await DB.clearRecords();
    toast('已清空');
    render();
  }

  /* ================= 工具 ================= */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ================= 启动 ================= */
  async function init() {
    try {
      await DB.open();
      await applyTheme();
      // 系统主题变化时（仅"跟随系统"模式）实时跟随
      if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => applyTheme();
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
      window.addEventListener('hashchange', render);
      render();
      if (DB.isFallback && DB.isFallback()) {
        const keep = DB.fallbackPersistent && DB.fallbackPersistent();
        toast(keep
          ? '当前环境禁用了 IndexedDB，已改用浏览器本地存储，可正常使用'
          : '当前环境禁用了本地数据库，已改用临时存储：关闭页面后数据不保留，建议用手机浏览器打开本文件', 5000);
      }
    } catch (e) {
      // 兜底：任何启动异常也要给出提示，绝不白屏
      console.error('[App] 启动失败', e);
      const v = document.getElementById('view');
      if (v) v.innerHTML = '<div class="card"><div class="card-title">启动失败</div><div class="muted">' +
        ((e && e.message) || e) + '</div></div>';
    }
  }

  return { init, navigate, startBank, delBank, renameBank, wrongRedo, starRedo, replay, finishQuiz, clearProgress, resumeLast, clearRecords, examWrongRedo, toast };
})();

document.addEventListener('DOMContentLoaded', App.init);
