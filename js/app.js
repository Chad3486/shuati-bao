/* ========== 主应用：hash 路由 + 页面渲染 ========== */
const App = (() => {
  const VERSION = '1.8.22'; // 与 apk-src/app/build.gradle 的 versionName 保持一致（build-single.mjs 会按 tag 覆盖）
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
    'quiz-sheet': pageQuizSheet,
    'quiz-result': pageQuizResult,
    'wrong': pageWrong,
    'star': pageStar,
    'wrong-setup': () => pageReviewSetup('wrong'),
    'star-setup': () => pageReviewSetup('star'),
    'search': pageSearch,
    'history': pageHistory,
    'stats': pageStats,
    'audit': pageAudit,
    'ability': pageAbility,
    'daily': pageDaily,
    'me': pageMe,
    'settings': pageSettings
  };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, ...params] = h.split('/');
    return { path: path || 'home', params };
  }

  function navigate(hash) { location.hash = hash; }

  /* ---- 后台保活桥（第二期）：AI 长任务进行时拉起 Android 前台服务——
     锁屏后进程不被冻结/杀掉，通知栏实时进度，结束自动撤通知释放唤醒锁。
     仅 APK 内生效（AndroidBridge 注入时）；浏览器/单文件版全部静默 no-op。 ---- */
  const BG = {
    on() {
      try { return typeof AndroidBridge !== 'undefined' && AndroidBridge.isAvailable(); }
      catch (e) { return false; }
    },
    start(text) { if (BG.on()) try { AndroidBridge.keepAliveStart(text || '任务进行中'); } catch (e) {} },
    update(text) { if (BG.on()) try { AndroidBridge.keepAliveUpdate(text); } catch (e) {} },
    stop() { if (BG.on()) try { AndroidBridge.keepAliveStop(); } catch (e) {} }
  };

  /* ---- 全局任务中心（v1.7.1）：AI 长任务的"仪表盘" ----
     病根：进度只写在当前页局部 DOM 上，切个页就随视图销毁；流式只给"已生成 X 字"的字数。
     做法：面板直接挂在 body（不在 #view 内），换页/锁屏回来都常驻可见；
     进度条 + 耗时 + 实时流式输出（真实内容，非字数）一键展开；
     通知栏（BG）由这里统一 start/update/stop，各任务不再各管一套。 ---- */
  const TC = {
    wrap: null, t0: 0, tick: null, title: '',
    ensure() {
      if (this.wrap && document.body.contains(this.wrap)) return;
      const w = document.createElement('div');
      w.id = 'tc-panel';
      w.style.cssText = 'position:fixed;left:12px;right:12px;bottom:78px;z-index:97;display:none;pointer-events:none;';
      w.innerHTML =
        '<div style="pointer-events:auto;background:#202634;color:#e8eaf0;border-radius:12px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:13px;line-height:1.5;">' +
          '<div style="display:flex;align-items:center;gap:8px;min-width:0;">' +
            '<span data-tc-icon style="flex:none;">⏳</span>' +
            '<b data-tc-title style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></b>' +
            '<span data-tc-time style="flex:none;color:#8b93a7;font-variant-numeric:tabular-nums;">0:00</span>' +
            '<button data-tc-toggle style="flex:none;border:0;border-radius:6px;padding:2px 8px;background:#313a4d;color:#cfd6e4;font-size:12px;">输出</button>' +
          '</div>' +
          '<div style="height:4px;background:rgba(255,255,255,.14);border-radius:2px;margin:8px 0 6px;overflow:hidden;">' +
            '<div data-tc-bar style="height:100%;width:0;background:#4f8cff;transition:width .3s;"></div>' +
          '</div>' +
          '<div data-tc-note style="color:#aab2c5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:1.2em;"></div>' +
          '<pre data-tc-out style="display:none;max-height:170px;overflow:auto;margin:8px 0 0;padding:8px;background:#161b26;border-radius:8px;white-space:pre-wrap;word-break:break-all;font-size:12px;color:#a8e0a8;"></pre>' +
        '</div>';
      document.body.appendChild(w);
      this.wrap = w;
      w.querySelector('[data-tc-toggle]').onclick = () => {
        const out = w.querySelector('[data-tc-out]');
        out.style.display = out.style.display === 'none' ? 'block' : 'none';
        if (out.style.display === 'block') out.scrollTop = out.scrollHeight;
      };
    },
    q(sel) { return this.wrap ? this.wrap.querySelector(sel) : null; },
    start(title) {
      this.ensure();
      this.title = title;
      const q = s => this.q(s);
      q('[data-tc-title]').textContent = title;
      q('[data-tc-icon]').textContent = '⏳';
      q('[data-tc-bar]').style.width = '0%';
      q('[data-tc-note]').textContent = '准备中…';
      q('[data-tc-out]').textContent = '';
      q('[data-tc-time]').textContent = '0:00';
      this.wrap.style.display = 'block';
      clearInterval(this.tick);
      this.t0 = Date.now();
      this.tick = setInterval(() => {
        const s = Math.round((Date.now() - this.t0) / 1000);
        const el = this.q('[data-tc-time]');
        if (el) el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      }, 1000);
      BG.start(title); // 通知栏同步：任务开始即拉前台服务
    },
    set(done, total, note) {
      if (!this.wrap) return;
      if (total) this.q('[data-tc-bar]').style.width = Math.min(100, Math.round(done / total * 100)) + '%';
      if (note != null) this.q('[data-tc-note]').textContent = note;
      BG.update(`${this.title} · ${done}/${total}${note ? ' · ' + note : ''}`);
    },
    note(text) { if (this.wrap && text != null) this.q('[data-tc-note]').textContent = text; },
    /* 流式实时输出：显示真实内容（末尾 1500 字），用户上翻查看时不抢滚动条 */
    delta(acc) {
      if (!this.wrap) return;
      const out = this.q('[data-tc-out]');
      acc = acc || '';
      const tail = acc.length > 1500 ? '…' + acc.slice(-1500) : acc;
      const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.textContent = tail || '（等待模型输出…）';
      if (stick) out.scrollTop = out.scrollHeight;
      // v1.7.3：acc 为空 = 重试后清屏，此时不覆盖 note——保留「第 N/4 次重试 · 原因」提示
      if (acc) this.note(`流式生成中 · 已 ${acc.length} 字`);
    },
    finish(ok, summary) {
      if (!this.wrap) return;
      clearInterval(this.tick);
      this.q('[data-tc-icon]').textContent = ok ? '✓' : '⚠';
      this.q('[data-tc-note]').textContent = summary || '';
      this.q('[data-tc-bar]').style.width = '100%';
      BG.stop(); // 通知栏撤了；面板保留 8 秒让人看清结果再自动收起
      setTimeout(() => { if (this.wrap) this.wrap.style.display = 'none'; }, 8000);
    }
  };

  /* ---- 逐批入库器（v1.7.1）：每片范式文本一到手就解析入库，不等整份转完 ----
     「等了半天题库还是空的」的病根就是旧版全部转/识别完才统一入库，
     中途网络一抖、解析一挂，全白等。现在第 1 片转完题库列表马上就有题；
     片内解析不出的先攒着，收尾 flush() 时合并再试一次（跨片断题兜底）。 */
  function pieceSaver(name, source) {
    let bank = null, total = 0, noAns = 0, sections = [], loose = [];
    const insert = async r => {
      if (!bank) {
        bank = { id: DB.uid(), name, createdAt: Date.now(), count: 0, source, sections: null };
        await DB.bankAdd(bank);
      }
      r.questions.forEach(q => { delete q._srcLine; q.bankId = bank.id; });
      await DB.questionAddMany(r.questions);
      total += r.questions.length;
      noAns += r.questions.filter(q => !q.answer).length;
      if (r.sections && r.sections.length) sections.push(...r.sections);
      bank.count = total;
      bank.sections = sections.length ? sections : null;
      await DB.bankAdd(bank); // 覆盖写：题库列表的题数实时在涨
    };
    return {
      add: async piece => {
        if (!piece) return 0;
        let r = null;
        try { r = Canon.parse(piece); } catch (e) { r = null; }
        if (!r || !r.questions.length) { loose.push(piece); return 0; }
        await insert(r);
        return r.questions.length;
      },
      /* 收尾：没解析出题的片合并起来最后再试一次；返回这轮补入的题数 */
      flush: async () => {
        if (!loose.length) return 0;
        let r = null;
        try { r = Canon.parse(loose.join('\n\n')); } catch (e) { r = null; }
        loose = [];
        if (r && r.questions.length) { await insert(r); return r.questions.length; }
        return 0;
      },
      stats: () => ({ total, noAns })
    };
  }

  function render() {
    const { path, params } = parseHash();
    clearExamTimer();   // 离开答题页就停掉倒计时，避免计时器写已移除的 DOM
    const page = routes[path] || pageHome;
    const tabs = ['home', 'quiz-setup', 'wrong', 'stats', 'me'];
    const active = tabs.includes(path) ? path
      : path.startsWith('quiz') ? 'quiz-setup'
      : path === 'star' || path === 'star-setup' || path === 'wrong-setup' ? 'wrong'
      : path === 'history' ? 'stats'
      : path === 'settings' ? 'me'
      : 'home';
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
      ['wrong', '复习', 'M12 8v4m0 4h.01M12 3l9 16H3l9-16z'],
      ['stats', '统计', 'M4 20V10m6 10V4m6 16v-7m4 7H2'],
      ['me', '我的', 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z']
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

  /* v1.8.16 兜底：旧进度被新练习顶掉前，自动存一条「练习（未完成）」进练习记录，永不真丢 */
  async function archivePartialSession(data) {
    try {
      const s = await QuizSession.restore(data);
      if (!s || !s.total) return;
      const rows = s.list.map(q => {
        const a = s.answered.get(q.id);
        if (a) return { qid: q.id, ua: a.userAnswer, status: a.correct ? 'ok' : 'bad' };
        const ua = s.examAnswers.has(q.id) ? s.examAnswers.get(q.id) : null;
        if (ua != null && String(ua).trim() && q.answer) return { qid: q.id, ua, status: QuizSession.judge(q, ua) ? 'ok' : 'bad' };
        return { qid: q.id, ua: ua || null, status: 'none' };
      });
      const answeredN = rows.filter(x => x.status !== 'none').length;
      if (!answeredN) return;
      const correctN = rows.filter(x => x.status === 'ok').length;
      const wrongN = rows.filter(x => x.status === 'bad').length;
      await historyPush({
        id: DB.uid(), at: s.startTime || Date.now(), partial: true, exam: !!s.exam,
        label: s.exam ? '考试（未交卷·自动保存）' : '练习（未完成·自动保存）',
        total: s.total, answered: answeredN, correct: correctN, wrong: wrongN,
        unanswered: s.total - answeredN,
        acc: s.exam ? Math.round(correctN / s.total * 100) : Math.round(correctN / answeredN * 100),
        timeUsed: Math.max(0, Math.round((Date.now() - (s.startTime || Date.now())) / 1000)),
        rows
      });
      toast('上一份未完成进度已自动存入练习记录');
    } catch (e) { /* 存档失败不拦新练习 */ }
  }

  /* v1.8.15 防误覆盖：还有没做完的练习时，开新练习前先确认一次，
     防止手滑开新练习把上次的答题进度顶掉（已交卷/没答过的不拦） */
  async function guardUnfinishedSession() {
    let data = null;
    try { data = await DB.metaGet('lastSession'); } catch (e) { return true; }
    if (!data || !Array.isArray(data.ids) || data.graded) return true;
    const answered = (data.answered || []).length + (data.examAnswers || []).length;
    if (!answered) return true;
    if (answered < data.ids.length) {
      const go = confirmDialog(`上次有没做完的练习（已答 ${answered}/${data.ids.length} 题）。\n开始新练习会丢掉这份进度，确定继续？`);
      if (!go) return false;
    }
    try { await archivePartialSession(data); } catch (e) { /* 静默 */ }
    return true;
  }

  /* v1.8.16 顺序偏好：练习设置页选过「随机/顺序」后记住，题库直开 / 章节直练也按它来。
     默认随机（乱序含选项）；设置页切换时写入 DB meta 'prefShuffle' */
  async function prefShuffle() {
    try {
      const v = await DB.metaGet('prefShuffle');
      return v === null || v === undefined ? true : !!v;
    } catch (e) { return true; }
  }
  async function savePrefShuffle(on) { try { await DB.metaSet('prefShuffle', !!on); } catch (e) { /* 静默 */ } }

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

  /* 保存二进制文件（Blob）：APK 走 JS 桥接写系统 Download 目录，浏览器走 <a download> */
  async function saveBlobFile(fileName, blob) {
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

  /* 保存文本文件 */
  async function saveTextFile(fileName, text, mime = 'text/plain') {
    return saveBlobFile(fileName, new Blob([text], { type: mime + ';charset=utf-8' }));
  }

  /* 保存范式 .docx（Canon.buildDocx → Uint8Array） */
  async function saveDocxFile(fileName, text) {
    const bytes = Canon.buildDocx(text);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    return saveBlobFile(fileName, blob);
  }

  /* 读任意题库文件为纯文本（.txt/.md 直读；DOCX 走提取器） */
  async function readAnyText(file) {
    const n = file.name.toLowerCase();
    if (/\.(txt|md|markdown|text)$/.test(n)) return await file.text();
    return await Extractor.extract(file);
  }

  /* ---- AI 功能通用：确认已配置 API Key（未配置则引导去设置页） ---- */
  async function ensureApiKey() {
    const cfg = await LLM.getConfig();
    if (cfg.apiKey) return true;
    toast('请先到「设置」配置 API Key');
    navigate('#/settings');
    return false;
  }

  /* ---- 文件 → 范式文本：本地抽文字（免费）→ 已是范式就直接用 → 否则 AI 只做排版 ----
     AI 只负责「重排格式」，答案一律从原卷照抄，不做题：产物丢给本地 Canon.parse 预览后导入 */
  async function aiCanonFromFiles(files, ui = {}) {
    const say = ui.onStatus || (() => {});
    const prog = ui.onProgress || (() => {});
    const texts = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      say(`提取文字 ${i + 1}/${files.length}：${f.name}（本地解析，不花 API）…`);
      const raw = await Extractor.extract(f, (p, t) => say(`提取 ${f.name}：${p}/${t} 页`));
      texts.push(Extractor.cleanText(raw));
    }
    const raw = texts.join('\n\n').trim();
    if (raw.replace(/\s/g, '').length < 50) throw new Error('没提取到文字（可能是图片型 / 扫描件文件，请改用含可复制文字的文档）');
    const local = Canon.convert(raw);
    if (local.passthrough) {
      say('✓ 这份文档已经是范式格式，直接使用（0 次 API 调用）');
      prog(1);
      return local.text;
    }
    /* v1.7.3：先走「AI 只出标注」快速通道（输出量零头，快 5~10 倍）；
       标注路线没走通再退回全量重排。两条路产物都是范式文本，交给下方预览页人工核对 */
    const liteRetry = (att, cool, why) => say(`第 ${att}/4 次重试 · ${why || '网络波动'}${cool > 0 ? `，冷却 ${cool}s` : ''}`);
    let text = '';
    try {
      text = await LLM.fileToCanonLite(raw, {
        onProgress: (done, total, note) => {
          prog(total ? done / total : 0);
          say(`AI 标注转换中：${note || ''} · AI 只出定位和答案，题干本地照抄`);
        },
        onRetry: liteRetry,
        onDelta: ui.onDelta || null
      });
      say('✓ 快速通道完成 · 请核对下方范式（题干为原文照抄）');
    } catch (e) {
      console.warn('标注快速通道失败，退回全量重排：', e);
    }
    if (!text) {
      text = await LLM.fileToCanon(raw,
        (done, total, note) => {
          prog(total ? done / total : 0);
          say(`AI 转换中：${note || ''} · 只做排版，答案从原卷照抄`);
        },
        liteRetry,
        ui.onDelta || null);
    }
    prog(1);
    return text;
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

  /** 提交当前题库（答题卡页按钮）：考试模式=交卷判分；学习/背题模式=结束本次练习直接出成绩单 */
  function submitSession() {
    if (!session) return navigate('#/quiz-setup');
    if (session.inExam) return submitExam(false);
    const p = session.progress;
    const left = session.total - p.done;
    const msg = left
      ? `确定提交本次题库？已答 ${p.done} 题，还有 ${left} 题未作答（未答不计入统计）。`
      : `确定提交本次题库？已全部作答（${p.done} 题）。`;
    if (!confirmDialog(msg)) return;
    clearExamTimer();
    session._submitted = true; // 防止提交后返回答题页继续作答
    DB.metaSet('lastSession', null);
    toast(`已提交 · 已答 ${p.done} 题`);
    navigate('#/quiz-result');
  }

  /* ================= 页面：题库首页 ================= */
  async function pageHome() {
    topbar('我的题库');
    const banks = await DB.bankList();
    const total = banks.reduce((s, b) => s + (b.count || 0), 0);
    const last = await DB.metaGet('lastSession');
    const recycle = await DB.recycleList();

    // 每库缺答案数 + 章节数（各一次遍历）；顺带收集全部题目给「每日一练」用
    const info = {};
    const allQ = [];
    await Promise.all(banks.map(async b => {
      const qs = await DB.questionsByBank(b.id);
      allQ.push(...qs);
      info[b.id] = { noAns: qs.filter(q => !q.answer).length, secs: (b.sections || []).length };
    }));

    // 每日一练（按题库）：各库今天一组，卡片显示还没练的库数；点进去选题库
    let dailyInfo = null, streak = { days: 0, todayDone: false };
    if (allQ.length) {
      try {
        const overview = await dailyOverview(banks, allQ, await historyList());
        if (overview.length) {
          const pending = overview.filter(x => !x.meta.done);
          dailyInfo = { total: overview.length, pending: pending.length, done: overview.length - pending.length };
          streak = (pending[0] || overview[0]).streak || streak;
        }
      } catch (e) {
        console.error('[daily] 首页卡片生成失败', e);
      }
    }

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
      ${dailyInfo ? `
      <div class="daily-card" onclick="App.navigate('#/daily')">
        <div class="daily-top"><span>每日一练 · 按题库</span><span class="daily-streak">🔥 连续 ${streak.days || 0} 天</span></div>
        <div class="daily-title">${dailyInfo.pending ? '还有 ' + dailyInfo.pending + ' 个题库没练' : '今天全部练完 ✓'}</div>
        <div class="daily-sub">${dailyInfo.pending
          ? '每个题库一组 8 题 · 点进去选题库'
          : `已完成 ${dailyInfo.done} / ${dailyInfo.total} 个题库，点开可再来一组`}</div>
        <div class="daily-foot">
          <div class="daily-bar"><i style="width:${dailyInfo.total ? Math.round(dailyInfo.done / dailyInfo.total * 100) : 0}%"></i></div>
          <span class="daily-btn">${dailyInfo.pending ? '开始' : '看小结'}</span>
        </div>
      </div>` : ''}
      <div class="quick-grid">
        <button class="quick-tile" onclick="App.navigate('#/import')">
          <span class="quick-ico" style="background:rgba(59,130,246,.14);color:#2f6bff">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="M8 10l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
          </span>
          <span>导入题库</span>
        </button>
        <button class="quick-tile" onclick="App.navigate('#/canon')">
          <span class="quick-ico" style="background:rgba(139,92,246,.14);color:#7c3aed">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 11h6"/><path d="M9 15h4"/></svg>
          </span>
          <span>粘贴导入</span>
        </button>
        <button class="quick-tile" onclick="App.navigate('#/search')">
          <span class="quick-ico" style="background:rgba(16,163,127,.14);color:#0e9f6e">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          </span>
          <span>搜题</span>
        </button>
        <button class="quick-tile" onclick="App.wrongRedo()">
          <span class="quick-ico" style="background:rgba(239,68,68,.14);color:#e05656">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>
          </span>
          <span>错题重做</span>
        </button>
      </div>
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
    if (!await guardUnfinishedSession()) return;
    session = await QuizBuilder.fromBanks([id], { filterType: 'answered', shuffle: await prefShuffle() });
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
      </div>

      <div class="card">
        <div class="card-title">① 文件 → AI 转范式（可选）</div>
        <p class="muted small">上传 Word 原卷（题目文件与配套答案文件可一起选）：先在本地<b>免费</b>提取文字，再让 AI 把原卷<b>重排成范式文本</b>——答案只从原卷<b>照抄</b>，AI 不做题。转完自动填进下面文本框，核对后一键导入。需在「设置」配置 API Key。</p>
        <button class="btn primary big" id="canon-ai-conv">选择 Word 文件</button>
        <input type="file" id="canon-ai-file" multiple accept=".docx,.doc,.txt,.md" style="display:none">
        <div class="progress" id="canon-ai-prog" style="display:none"><div class="progress-bar" id="canon-ai-bar"></div></div>
        <div class="muted small" id="canon-ai-conv-status"></div>
        <pre id="canon-ai-live" style="display:none;max-height:180px;overflow:auto;font-size:11px;line-height:1.5;white-space:pre-wrap;background:#0F1620;color:#9FD8C2;border-radius:8px;padding:8px;margin-top:8px"></pre>
      </div>

      <div class="card">
        <div class="card-title">② 贴入范式文本</div>
        <textarea id="canon-text" class="canon-area" placeholder="在这里粘贴范式文本…&#10;&#10;【单选】1. 电力二极管属于（ ）器件。&#10;A. 不可控器件&#10;B. 半控器件&#10;答案：B"></textarea>
        <div class="btn-row">
          <button class="btn ghost" id="canon-conv">Word 转换器</button>
          <button class="btn ghost" id="canon-docx">导出 Word (.docx)</button>
        </div>
        <input type="file" id="canon-old" accept=".txt,.md,.markdown,.docx,.doc" style="display:none">
        <div class="muted small" id="canon-file-status"></div>
        <div class="btn-row">
          <button class="btn ghost" id="canon-clear">清空</button>
          <button class="btn primary" id="canon-check">解析预览</button>
        </div>
        <div class="muted small" id="canon-count"></div>
        <div class="muted small" id="canon-docx-status"></div>
      </div>

      <div class="card" id="canon-report" style="display:none">
        <div class="card-title">③ 解析结果</div>
        <div id="canon-report-body"></div>
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
    const importStatus = document.getElementById('canon-import-status');

    // 文本框一改，上次的解析结果就失效（防止导入了旧内容）
    const invalidate = () => {
      canonParsed = null;
      reportCard.style.display = 'none';
      const n = ta.value.replace(/\s/g, '').length;
      countEl.textContent = n ? `当前文本 ${ta.value.length} 字符` : '';
    };
    ta.addEventListener('input', invalidate);

    document.getElementById('canon-clear').onclick = () => {
      ta.value = '';
      invalidate();
      fileStatus.textContent = '';
      importStatus.textContent = '';
      docxStatus.textContent = '';
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
        ${s.missing ? '<div class="muted small">缺答案的题也能导入；导入后在题库「补答案」页上传答案文件、AI 照抄对位，或让 AI 直接解答。</div>' : ''}
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

      return r;
    }

    /* ---- 文件 → AI 转范式：本地先免费抽文字，再让 AI 只做排版（答案照抄原卷，不做题） ---- */
    const aiFileInput = document.getElementById('canon-ai-file');
    const aiConvBtn = document.getElementById('canon-ai-conv');
    const aiConvStatus = document.getElementById('canon-ai-conv-status');
    const aiProg = document.getElementById('canon-ai-prog');
    const aiBar = document.getElementById('canon-ai-bar');
    aiConvBtn.onclick = () => aiFileInput.click();
    aiFileInput.onchange = async () => {
      const files = [...aiFileInput.files];
      aiFileInput.value = '';
      if (!files.length) return;
      if (!await ensureApiKey()) return;
      aiConvBtn.disabled = true;
      aiProg.style.display = '';
      aiBar.style.width = '0%';
      // v1.7.1：任务中心接管进度与通知栏——转范式逐片调 API，长文档可能十几分钟，换页/锁屏回来照样看得见
      TC.start('AI 转范式');
      const liveEl = document.getElementById('canon-ai-live');
      liveEl.textContent = '';
      try {
        const text = await aiCanonFromFiles(files, {
          onStatus: s => { aiConvStatus.textContent = s; TC.note(s); },
          onProgress: p => { aiBar.style.width = Math.round(p * 100) + '%'; TC.set(Math.round(p * 100), 100, `转换中 ${Math.round(p * 100)}%`); },
          onRetry: (att, cool, why) => { TC.note(`第 ${att}/4 次重试 · ${why || '网络波动'}${cool > 0 ? `，冷却 ${cool}s` : ''}`); },
          // 流式：AI 生成内容实时回显（1~2 秒出首字，页面内 + 任务中心双处可见）
          onDelta: acc => {
            liveEl.style.display = '';
            liveEl.textContent = acc.length > 600 ? '…' + acc.slice(-600) : acc;
            liveEl.scrollTop = liveEl.scrollHeight;
            TC.delta(acc);
          }
        });
        ta.value = text;
        invalidate();
        const r = runCheck();
        aiConvStatus.textContent = `✓ 已转成范式并填入下方文本框${r ? `：${r.stats.total} 题 · 有答案 ${r.stats.answered}` : ''}，核对无误后点「导入题库」`;
        toast('AI 转范式完成，请核对后导入');
        TC.finish(true, `转换完成${r ? ` · ${r.stats.total} 题` : ''}`);
      } catch (e) {
        aiConvStatus.textContent = '⚠ ' + e.message.slice(0, 140);
        TC.finish(false, '中断：' + e.message.slice(0, 60));
      } finally {
        aiConvBtn.disabled = false;
        aiProg.style.display = 'none';
        const liveEl = document.getElementById('canon-ai-live');
        if (liveEl) liveEl.style.display = 'none';
      }
    };

    /* ---- 导出范式 Word（.docx） ---- */
    const docxBtn = document.getElementById('canon-docx');
    const docxStatus = document.getElementById('canon-docx-status');

    docxBtn.onclick = async () => {
      const text = ta.value;
      if (text.replace(/\s/g, '').length < 5) { toast('文本框是空的，先贴入或转出范式文本'); return; }
      try {
        const name = (document.getElementById('canon-name').value.trim() || '刷题宝-范式') + '.docx';
        const r = await saveDocxFile(name, text);
        docxStatus.textContent = `✓ 已导出 Word：${r.path}（Word / WPS 可编辑；改完回本页点「Word 转换器」选它即可导回）`;
        toast('已导出范式 Word');
      } catch (e) {
        docxStatus.textContent = '⚠ 导出失败：' + e.message.slice(0, 100);
      }
    };

    // 「导入文件」页转好后带过来的范式文本：直接填进文本框并预览
    DB.metaGet('canonDraft').then(d => {
      if (!d) return;
      DB.metaSet('canonDraft', null);
      ta.value = d;
      invalidate();
      fileStatus.textContent = '✓ 已载入「AI 转范式」结果，核对后点「导入题库」';
      runCheck();
    });

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
      importStatus.textContent = `✓ 已导入「${name}」共 ${qs.length} 题${noAns ? `（${noAns} 题缺答案）` : ''}，可在题库页点「🩺 体检」查一遍`;
      toast(`已导入 ${qs.length} 题`);
      navigate('#/home');
    };
  }

  /* ================= 页面：导入 ================= */
  let lastPickedFiles = [];   // 「导入文件」页最近一次选中的文件（供「改用 AI 转范式」复用）

  function pageImport() {
    topbar('导入题库', '#/home');
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">选择文件</div>
        <p class="muted">支持多选 DOCX（Word）/ TXT / MD / <b>图片（JPG/PNG）</b>。选完文件后一条路走完，答案、解析原样带走，不用再手动补。图片和图片型 Word 由 AI 视觉模型识别。</p>
        <label class="field" style="margin-top:6px"><span>解析引擎</span>
          <div class="seg" id="seg-engine">
            <button data-v="auto" class="on">自动</button>
            <button data-v="local">本地正则（免AI）</button>
            <button data-v="ai">仅 AI</button>
          </div>
        </label>
        <div class="muted small" id="engine-hint"></div>
        <label class="field" style="margin-top:10px"><span>自定义切题正则（高级 · 可留空）</span>
          <input type="text" id="custom-re" placeholder="行首匹配；第一个括号捕获题号，如 ^第\s*(\d+)\s*题">
        </label>
        <div class="muted small" id="custom-re-hint">留空 = 内置规则（1. 2.、(1) (2)）。设置后「本地正则」引擎只按这个行首模式切题（对文字版 DOCX/TXT/MD 生效），保存后重新导入生效。</div>
        <button class="btn primary big" style="margin-top:10px" id="pick-btn">选择文件</button>
        <input type="file" id="file-input" multiple accept=".docx,.doc,.txt,.md,.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" style="display:none">
        <div id="file-list" class="file-list"></div>
      </div>
      <div class="card" id="parse-card" style="display:none">
        <div class="card-title">解析</div>
        <div class="muted" id="parse-status"></div>
        <div class="progress"><div class="progress-bar" id="parse-bar"></div></div>
        <div id="parse-result"></div>
      </div>`;

    const input = document.getElementById('file-input');
    document.getElementById('pick-btn').onclick = () => input.click();
    input.onchange = () => { lastPickedFiles = [...input.files]; handleFiles(lastPickedFiles); };

    /* 解析引擎选择：本地正则 = 老桌面版的秒级正则引擎，零 API、免费；持久化保存 */
    const HINTS = {
      auto: '自动 = 配了 Key 走 AI 转范式（乱排版更稳），没配 Key 走本地正则（秒级、零费用）',
      local: '本地正则：不用 API Key、不花钱、毫秒级；排版乱的文档可能切不准，建议导入后抽查',
      ai: '仅 AI：每次导入都走 AI 转范式（需在「设置」配好 Key），没 Key 的文件会跳过'
    };
    const segEngine = document.getElementById('seg-engine');
    const engineHint = document.getElementById('engine-hint');
    DB.metaGet('importEngine').then(saved => {
      const v = saved || 'auto';
      segEngine.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
      engineHint.textContent = HINTS[v];
    });
    segEngine.onclick = async (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      segEngine.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      engineHint.textContent = HINTS[b.dataset.v];
      await DB.metaSet('importEngine', b.dataset.v);
    };

    /* 自定义切题正则（v1.8.13）：持久化 + 语法校验（空行可匹配的一律拒绝） */
    const customReInput = document.getElementById('custom-re');
    const customReHint = document.getElementById('custom-re-hint');
    DB.metaGet('importRegex').then(v => { customReInput.value = v || ''; });
    customReInput.addEventListener('change', async () => {
      const v = customReInput.value.trim();
      if (!v) { await DB.metaSet('importRegex', ''); customReHint.textContent = '✓ 已清除，恢复内置切题规则'; return; }
      try {
        const r = new RegExp(v);
        if (r.test('')) { customReHint.textContent = '⚠ 这个正则能匹配空内容，会乱切；请加 ^ 锚定行首（如 ^第\\s*(\\d+)\\s*题）'; return; }
      } catch (e) { customReHint.textContent = '⚠ 正则语法错误：' + e.message; return; }
      await DB.metaSet('importRegex', v);
      customReHint.textContent = '✓ 已保存，重新导入时本地正则引擎按此模式切题';
    });
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

    // 第 1 步 · 全部提取文本（v1.7：DOCX 顺带收集嵌图，供图片型文档视觉兜底）
    const texts = new Map();
    const docImgs = new Map();    // i → [{name,dataUrl}]（DOCX 嵌入图，仅兜底时用）
    const imgStore = new Map();   // i → dataUrl（用户直接选的图片文件，压缩后待识别）
    const isImageFile = f => /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|bmp)$/i.test(f.name);
    const fileToDataUrl = f => new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = () => no(new Error('读取图片失败'));
      r.readAsDataURL(f);
    });
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const stateEl = rows.get(i).querySelector('.file-state');
      const setState = (s) => { stateEl.textContent = s; stateEl.dataset.state = s; };
      try {
        if (isImageFile(f)) {
          // 图片文件：压缩到长边 1600px（试卷文字足够清晰，请求体也不爆炸），等视觉识别
          setState('读图中…');
          imgStore.set(i, await Extractor.shrinkImage(await fileToDataUrl(f)));
          setState('图片就绪');
          texts.set(i, '');
          continue;
        }
        setState('提取文本…');
        const ex = await Extractor.extractFull(f);
        const text = Extractor.cleanText(ex.text);
        docImgs.set(i, ex.images || []);
        if (text.replace(/\s|\[图片[^\]]*\]/g, '').length < 50) {
          // 文档基本没文字：若有嵌图等视觉兜底来救；彻底没内容才算失败
          if ((ex.images || []).length) {
            docImgs.set(i, ex.images);
            texts.set(i, text);   // 保住 [图片] 标记与极少量文字，兜底分支会判断走视觉
            setState('图片型文档');
            continue;
          }
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
      if (isImageFile(f)) return; // 图片不走文本分类，第 5 步统一视觉识别
      const isAns = /答案|answer/i.test(f.name) || LLM.answerLineRatio(text) >= 0.3;
      rows.get(i).querySelector('.file-state').textContent = isAns ? '答案文件' : '题目文件';
      (isAns ? aFiles : qFiles).push({ f, i, text });
    });
    const imgFiles = files.map((f, i) => ({ f, i })).filter(({ f, i }) => imgStore.has(i));
    if (!qFiles.length && !imgFiles.length) {
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
      bar.style.width = '5%';
      const t0 = Date.now();
      try {
        // v1.8 快速通道 = AI 转范式直通：配了 API Key → AI 直接把原卷转成范式、逐片入库，
        // 答案/解析原样带走，导入即用；没配 Key → 本地解析保底。不再本地先行、不再两条路绕
        // v1.8.11：引擎可选（自动 / 本地正则免AI / 仅AI），本地正则成为一等公民
        const cfg = await LLM.getConfig();
        const engine = (await DB.metaGet('importEngine')) || 'auto';
        if (engine === 'ai' && !cfg.apiKey) {
          setState('跳过（无 Key）');
          statusEl.textContent = '⚠ 已选「仅 AI」但没配 API Key，本题库跳过；把引擎改成「自动 / 本地正则」或到「设置」配好 Key 再导';
          continue;
        }
        if (engine === 'ai' || (engine === 'auto' && cfg.apiKey)) {
          setState('AI 转范式…');
          // v1.7.1：全局任务中心接管进度与通知栏（换页/锁屏回来自动可见）；逐批入库不等整份
          const dImgs = docImgs.get(i) || [];
          const textOnly = text.replace(/\[图片[^\]]*\]/g, '').trim();
          const srcLabel = (dImgs.length && textOnly.length < dImgs.length * 15) ? 'AI 视觉识别' : 'AI 转范式';
          const save = pieceSaver(f.name.replace(/\.(docx|doc|txt|md)$/i, '').slice(0, 40), f.name + `（${srcLabel}）`);
          let gotTotal = 0;
          const onPiece = async (pi, tot, txt) => {
            const got = await save.add(txt);
            gotTotal += got;
            TC.set(pi, tot, got ? `已入库 ${gotTotal} 题` : '本片暂未解析出题，收尾合并再试');
          };
          TC.start(`${srcLabel} · ${f.name}`);
          try {
            if (srcLabel === 'AI 视觉识别') {
              setState('AI 视觉识别中…');
              const shrunk = [];
              for (const im of dImgs) {
                shrunk.push({ name: im.name, dataUrl: await Extractor.shrinkImage(im.dataUrl) });
              }
              await LLM.visionCanon(shrunk, {
                onProgress: (done, total, note) => {
                  setState(`AI 视觉识别中… ${done}/${total}`);
                  bar.style.width = Math.round(done / total * 95) + '%';
                  TC.set(done, total, `已入库 ${gotTotal} 题`);
                },
                onRetry: (att, cool, why) => { TC.note(`第 ${att}/4 次重试 · ${why || '网络波动'}${cool > 0 ? `，冷却 ${cool}s` : ''}`); },
                onDelta: acc => { TC.delta(acc); },
                onPiece
              });
            } else {
              // v1.8.4：重写 — 直接 fetch 调 API，绕过 LLM.fileToCanon 屎山
              setState('AI 转范式并入库中…');

              // 答案表检测
              const ansSpan = LLM.findAnswerTableSpan(text);
              let answerTable = ansSpan.text.trim();
              if (answerTable.length > 40000) answerTable = answerTable.slice(0, 40000);

              // 分片
              const CHUNK = 4000;
              const chunks = [];
              let buf = [], size = 0;
              const flush = () => { const t = buf.join('\n').trim(); if (t) chunks.push(t); buf = []; size = 0; };
              for (const line of text.split('\n')) {
                buf.push(line); size += line.length + 1;
                if (size < CHUNK) continue;
                const t = line.trim();
                if (!t || /^\d{1,3}\s*[.、．]/.test(t) || /^第\s*[一二三四五六七八九十\d]+\s*章/.test(t) || /^[一二三四五六七八九十]+\s*[、.．]/.test(t) || /^【/.test(t) || /^#{1,2}\s/.test(t) || size >= CHUNK * 1.6) flush();
              }
              flush();
              if (!chunks.length) throw new Error('文档切片失败');

              // Prompt
              const CANON_PROMPT = `你是题库格式转换专家。把【原卷文档】转换为「范式」格式。

范式格式：
1. 章标题：# 第1章 xxx
2. 节标题：## 1.1 xxx
3. 题型标记+题号：【单选】1. 题干（简答/计算等按【填空】）
4. 选项每行一个：A. 内容（从 A 开始连续）
5. 答案单独一行：答案：B（多选 答案：ABD；判断 答案：对/错）
6. 解析单独一行：解析：xxx

红线：
- 答案只能照抄原卷或答案表，严禁自己推理
- 题干选项原文照抄，不改写
- 丢弃页眉页脚水印
- 只输出范式文本，不要解释或代码块`;

              const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
              const allPieces = [];

              for (let ci = 0; ci < chunks.length; ci++) {
                setState(`AI 转范式… 片段 ${ci + 1}/${chunks.length}`);
                bar.style.width = Math.round((ci + 1) / chunks.length * 95) + '%';
                TC.set(ci, chunks.length, `已入库 ${gotTotal} 题`);

                const userContent = answerTable
                  ? `【答案表（只能从这里照抄答案）】\n${answerTable}\n\n【原卷文档】\n${chunks[ci]}`
                  : `【原卷文档】\n${chunks[ci]}`;

                let piece = '';
                for (let retry = 0; retry < 3; retry++) {
                  try {
                    const resp = await fetch(url, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
                      body: JSON.stringify({
                        model: cfg.model,
                        messages: [
                          { role: 'system', content: CANON_PROMPT },
                          { role: 'user', content: userContent }
                        ],
                        temperature: 0.1,
                        max_tokens: 8192
                      })
                    });
                    if (!resp.ok) {
                      const errText = await resp.text().catch(() => '');
                      throw new Error(`API ${resp.status}: ${errText.slice(0, 100)}`);
                    }
                    const data = await resp.json();
                    piece = (data.choices?.[0]?.message?.content || '').trim()
                      .replace(/^```(?:text|markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
                    break;
                  } catch (e) {
                    console.warn(`[转范式] 片段 ${ci + 1} 重试 ${retry + 1}:`, e.message);
                    if (retry < 2) await new Promise(r => setTimeout(r, 3000 * (retry + 1)));
                  }
                }

                if (piece) {
                  allPieces.push(piece);
                  // 立即解析入库
                  const got = await save.add(piece);
                  gotTotal += got;
                  TC.set(ci + 1, chunks.length, `已入库 ${gotTotal} 题`);
                }
              }

              gotTotal += await save.flush();
              const st = save.stats();
              if (!st.total) {
                setState('未发现题目');
                statusEl.textContent = '⚠ AI 转完没解析出题目，建议在「粘贴文本导入」里人工核对';
                TC.finish(false, '转换完成，但没解析出题目');
                continue;
              }
              setState(`✓ ${st.total} 题${st.noAns ? `（${st.noAns} 题缺答案）` : ''}`);
              const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
              statusEl.textContent = `✓ 「${f.name}」AI 转范式并入库 ${st.total} 题 · 用时 ${secs}s`
                + (st.noAns ? `（缺答案 ${st.noAns}，可稍后「补答案」）` : '');
              toast(`AI 转范式导入 ${st.total} 题`);
              TC.finish(true, `已入库 ${st.total} 题${st.noAns ? ` · 缺答案 ${st.noAns}` : ''}`);
            }
            gotTotal += await save.flush(); // 收尾：攒着的片合并再试一次
            const st = save.stats();
            if (!st.total) {
              setState('未发现题目');
              statusEl.textContent = '⚠ AI 转完没解析出题目：建议在「粘贴文本导入（高级）」里人工核对原文';
              TC.finish(false, '转换完成，但没解析出题目');
              continue;
            }
            setState(`✓ ${srcLabel} ${st.total} 题${st.noAns ? `（${st.noAns} 题缺答案）` : ''}`);
            const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
            statusEl.textContent = `✓ 「${f.name}」${srcLabel}并入库 ${st.total} 题 · 用时 ${secs}s`
              + (st.noAns ? `（缺答案 ${st.noAns}，可稍后「补答案」）` : '');
            toast(`${srcLabel}导入 ${st.total} 题`);
            TC.finish(true, `已入库 ${st.total} 题${st.noAns ? ` · 缺答案 ${st.noAns}` : ''}`);
          } catch (e) {
            console.error(e);
            const st = save.stats();
            setState(st.total ? `⚠ 中断（已入库 ${st.total} 题）` : '未发现题目');
            statusEl.textContent = '⚠ AI 转范式失败：' + e.message.slice(0, 120)
              + (st.total ? `。已入库的 ${st.total} 题不丢，可重新导入补齐` : '。可在「粘贴文本导入（高级）」里重试');
            TC.finish(false, `中断：${e.message.slice(0, 60)}${st.total ? ` · 已入库 ${st.total} 题不丢` : ''}`);
          }
          continue;
        }
        // ---- 无 API Key：本地解析保底（零调用、免费；支持自定义切题正则） ----
        setState('本地解析…');
        const customSrc = ((await DB.metaGet('importRegex')) || '').trim();
        const res = await LLM.parseDocument(text, (done, total, got) => {
          const elapsed = Math.round((Date.now() - t0) / 1000);
          statusEl.textContent = `本地解析中：已提取 ${got} 题 · 已用 ${elapsed}s`;
          bar.style.width = Math.round(done / total * 95) + '%';
        }, customSrc);
        if (!res.questions.length) {
          setState('未发现题目');
          const hasImg = (docImgs.get(i) || []).length > 0;
          statusEl.textContent = hasImg
            ? '⚠ 本地解析没切出题：这份文件以图片为主，本地正则认不了图片。识别图片试卷需在「设置」配好 API Key、引擎选「自动 / 仅 AI」走 AI 视觉；文字部分可复制到「粘贴文本导入（高级）」'
            : '⚠ 本地解析没切出题，且未配置 API Key。可在导入页填「自定义切题正则」后重试；或到「设置」配 Key 走 AI 转范式；或到「粘贴文本导入（高级）」人工核对原文';
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

        const noAnswer = res.questions.filter(q => !q.answer).length;

        const bank = {
          id: DB.uid(),
          name: f.name.replace(/\.(docx|doc)$/i, ''),
          createdAt: Date.now(),
          count: res.questions.length,
          source: f.name,
          sections: res.sections || null
        };
        res.questions.forEach(q => q.bankId = bank.id);
        await DB.questionAddMany(res.questions);
        await DB.bankAdd(bank);
        const totalFilled = filled, totalExp = explained;
        if (totalFilled) {
          setState(`✓ ${res.questions.length} 题 · 答案填入 ${totalFilled}`);
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
    // 第 5 步 · 图片文件 → AI 视觉识别入库（v1.7：图片型题库的新路，OCR 的替代者）
    if (imgFiles.length) {
      const cfg = await LLM.getConfig();
      if (!cfg.apiKey) {
        for (const { i } of imgFiles) {
          const el = rows.get(i).querySelector('.file-state');
          el.textContent = '⚠ 需 API Key';
        }
        statusEl.textContent = '⚠ 图片识别需要 AI 视觉模型：先到「设置」配置 API Key 与「视觉模型」，再重新导入';
      } else {
        // v1.7.1：任务中心接管进度/通知栏；逐张识别逐张入库，不等全部识别完
        const save = pieceSaver(
          imgFiles[0].f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) + (imgFiles.length > 1 ? ` 等${imgFiles.length}张` : ''),
          `图片视觉识别（${imgFiles.length} 张）`);
        let okN = 0, failN = 0, gotTotal = 0;
        TC.start(`AI 视觉识别 · 共 ${imgFiles.length} 张`);
        for (let k = 0; k < imgFiles.length; k++) {
          const { f, i } = imgFiles[k];
          const stateEl = rows.get(i).querySelector('.file-state');
          TC.set(k, imgFiles.length, `识别「${f.name}」· 已入库 ${gotTotal} 题`);
          try {
            await LLM.visionCanon([{ name: f.name, dataUrl: imgStore.get(i) }], {
              onProgress: (done, total, note) => {
                stateEl.textContent = note || '识别中…';
                bar.style.width = Math.round((k + done / total) / imgFiles.length * 95) + '%';
                TC.set(k + done / total, imgFiles.length, `识别「${f.name}」· 已入库 ${gotTotal} 题`);
              },
              onRetry: (att, cool, why) => { TC.note(`第 ${att}/4 次重试 · ${why || '网络波动'}${cool > 0 ? `，冷却 ${cool}s` : ''}`); },
              onDelta: acc => { TC.delta(acc); },
              onPiece: async (pi, tot, txt) => {
                const got = await save.add(txt);
                gotTotal += got;
                if (got) TC.note(`「${f.name}」已入库 ${got} 题 · 累计 ${gotTotal}`);
              }
            });
            okN++;
            stateEl.textContent = '✓ 已识别';
          } catch (e) {
            console.error(e);
            failN++;
            stateEl.textContent = '⚠ 识别失败';
            statusEl.textContent = `⚠ ${f.name} 识别失败：${e.message.slice(0, 100)}${failN < imgFiles.length ? '（继续识别其余图片）' : ''}`;
            TC.note(`「${f.name}」识别失败，继续下一张`);
          }
        }
        gotTotal += await save.flush(); // 收尾：没解析出题的图合并再试一次
        const st = save.stats();
        if (!st.total) {
          statusEl.textContent = '⚠ 识别出了文本但没解析出题目：可到「粘贴文本导入」把识别文本人工核对后导入';
          TC.finish(false, '识别完成，但没解析出题目');
        } else {
          statusEl.textContent = `✓ 视觉识别导入 ${st.total} 题（图片成功 ${okN} 张${failN ? `，失败 ${failN} 张` : ''}）`
            + (st.noAns ? `，缺答案 ${st.noAns} 题可稍后「补答案」或 AI 解答` : '');
          toast(`视觉识别导入 ${st.total} 题`);
          TC.finish(failN === 0, `已入库 ${st.total} 题 · 图片成功 ${okN}/${imgFiles.length} 张`);
        }
      }
    }

    bar.style.width = '100%';
    statusEl.textContent = '全部完成';
    BG.stop(); // 导入流程结束：撤保活通知（无 AI 任务时为空操作）
    resultEl.innerHTML = `<button class="btn primary big" onclick="App.navigate('#/home')">完成，返回题库</button>
      ${lastPickedFiles.length ? '<button class="btn ghost big" id="to-canon-btn">解析不满意？改用 AI 转范式导入</button>' : ''}
      <div class="muted small">缺答案的题：可在题库列表点「补答案」，也可在「选题」里勾选缺答案的题，练习时点右上角 ✎ 自己填答案；✎ 面板还能改题型、选项和解析；.doc 需另存为 .docx</div>`;
    // 本地解析不理想时：把同一批文件交给 AI 重排成范式文本，转到「范式导入」页核对后导入（答案零对齐）
    const toCanonBtn = document.getElementById('to-canon-btn');
    if (toCanonBtn) toCanonBtn.onclick = async () => {
      if (!await ensureApiKey()) return;
      toCanonBtn.disabled = true;
      TC.start('AI 转范式');
      try {
        const text = await aiCanonFromFiles(lastPickedFiles, {
          onStatus: s => { statusEl.textContent = s; TC.note(s); },
          onProgress: p => { bar.style.width = Math.round(p * 100) + '%'; TC.set(Math.round(p * 100), 100, `转换中 ${Math.round(p * 100)}%`); },
          onRetry: (att, cool, why) => { TC.note(`第 ${att}/4 次重试 · ${why || '网络波动'}${cool > 0 ? `，冷却 ${cool}s` : ''}`); },
          onDelta: acc => { TC.delta(acc); }
        });
        await DB.metaSet('canonDraft', text);
        toast('已转成范式，去核对后导入');
        TC.finish(true, '转换完成，去核对后导入');
        navigate('#/canon');
      } catch (e) {
        statusEl.textContent = '⚠ ' + e.message.slice(0, 140);
        TC.finish(false, '中断：' + e.message.slice(0, 60));
        toCanonBtn.disabled = false;
      }
    };
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
      ['exp', '有解析', q => !!q.explanation],
      ['ai', 'AI 答案', q => !!q.aiAnswer]
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
          <button class="btn ghost" onclick="App.openAudit('${bank.id}')">🩺 体检</button>
          <button class="btn ghost" onclick="App.dailyBank('${bank.id}')">📅 今日一练</button>
        </div>
        <div class="muted small" id="pick-info" style="margin-top:8px"></div>
        <button class="btn primary big" id="go-quiz" style="margin-top:8px"></button>
        <details style="margin-top:12px">
          <summary class="muted small" style="cursor:pointer;font-weight:600">更多操作（批量选 / AI 核对 / 导出范式 / 删除）</summary>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn ghost" id="sel-noans">只选有答案</button>
            <button class="btn ghost" id="sel-unans">只选缺答案</button>
          </div>
          <div class="btn-row">
            <button class="btn ghost" id="ai-review-btn">🤖 逐题核对 AI 答案</button>
          </div>
          <div class="btn-row">
            <button class="btn ghost" id="exp-canon">导出范式 Word</button>
            <button class="btn ghost" id="copy-canon">复制范式</button>
          </div>
          <div class="btn-row">
            <button class="btn ghost" id="del-sel" style="color:var(--bad)">删除选中</button>
          </div>
          <div class="muted small" style="margin-top:6px">缺答案的题（虚线框）也能勾选练习，答题时点 ✎ 自己补答案；导出的范式 Word 在 Word / WPS 补答案后，回「范式导入」用 Word 转换器覆盖建库（答案随题，无需对齐）</div>
        </details>
        <div id="no-grid"></div>
        <div id="ai-review"></div>
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
          transition:background .12s, border-color .12s, transform .1s;
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
        .ai-card { margin-top:10px; padding:12px; border:1px solid var(--line, #e3e8f0); border-left:3px solid var(--warn, #e0a344); border-radius:12px; background:var(--surface-2, #f7f9fc); }
        .ai-card .ai-badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; background:var(--warn-bg, #fff3e0); color:var(--warn, #b26a00); }
        .ai-card .ai-stem { margin:6px 0; font-size:14px; line-height:1.6; }
        .ai-card .ai-opt { font-size:13px; color:var(--text-2, #5f6b7a); margin:2px 0 2px 12px; }
        .ai-card .ai-ans { margin-top:6px; font-size:14px; }
        .ai-card .ai-exp { margin-top:4px; font-size:13px; color:var(--text-2, #5f6b7a); }
        .ai-card input.edit-ans { width:100%; box-sizing:border-box; margin-top:6px; padding:8px 10px; border:1.5px solid var(--line, #e3e8f0); border-radius:8px; background:var(--surface, #fff); color:var(--text); font-size:14px; }
      </style>`;

    const grid = document.getElementById('no-grid');
    const info = document.getElementById('pick-info');
    const goBtn = document.getElementById('go-quiz');
    const filterEl = document.getElementById('q-filter');

    filterEl.innerHTML = FILTERS.map(([k, label, fn]) => {
      const n = qs.filter(fn).length;
      return `<button class="chip ${k === 'all' ? 'on' : ''}" data-v="${k}">${label} ${n}</button>`;
    }).join('');

    /* ---- v1.7 · 第三期：分页渲染 ----
       大题库（上千题）原先一次画完所有格子：首屏 DOM 上千节点，勾选/筛选/折叠每次全量重排，
       中低端机明显卡顿。改为：每节先画前 PAGE 题，节尾「显示更多」按页增量；
       格子勾选改事件委托（不再每次渲染重绑上千个 onchange）；搜索加防抖。 ---- */
    const PAGE = 80;
    const secShown = new Map(); // sec → 已显示题数（「显示更多」翻页）

    function matchQ(q) {
      if (kw) {
        const hay = [q.stem, q.answer, q.explanation, ...Object.values(q.options || {})].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      const f = FILTERS.find(x => x[0] === filter);
      return f ? f[2](q) : true;
    }

    let shownCount = 0;

    function update(shown) {
      const n = shown != null ? shown : shownCount;
      info.textContent = `共 ${qs.length} 题 · 当前显示 ${n} 题 · 已选 ${sel.size} 题`;
      goBtn.textContent = `练习选中题（${sel.size}）`;
    }

    function cellHtml(q, i) {
      return `<label class="no-cell ${q.answer ? '' : 'no-ans'} st-${stateOf(q)}${sel.has(q.id) ? ' on' : ''}" title="${q.answer ? '有答案' : '缺答案（可勾选，练习时自己填）'}${q.explanation ? ' · 有解析' : ''}">
        <input type="checkbox" data-id="${q.id}" ${sel.has(q.id) ? 'checked' : ''}>
        <span>${q.no ?? i + 1}</span>
      </label>`;
    }

    /* 只画某一节的格子（含分页与「显示更多」）；展开/翻页时按节局部重建，
       不再整页重排——846 题整页重渲染一次要几百毫秒，是「点一下卡一下」的主因 */
    function sectionBodyHtml(g) {
      const idxs = g.idxs.filter(i => matchQ(qs[i]));
      const lim = secShown.get(g.sec) || PAGE;
      const shownIdxs = idxs.slice(0, lim);
      const hidden = idxs.length - shownIdxs.length;
      return `<div class="no-grid">${shownIdxs.map(i => cellHtml(qs[i], i)).join('')}</div>` +
        (hidden > 0 ? `<button class="btn ghost" data-more="${escapeHtml(g.sec)}" style="margin-top:6px">显示更多（还有 ${hidden} 题）</button>` : '');
    }

    function recountShown() {
      let n = 0;
      for (const g of groups) {
        if (collapsed.has(g.sec)) continue;
        const idxs = g.idxs.filter(i => matchQ(qs[i]));
        n += Math.min(idxs.length, secShown.get(g.sec) || PAGE);
      }
      shownCount = n;
      update(n);
    }

    function renderGrid() {
      const html = groups.map(g => {
        const idxs = g.idxs.filter(i => matchQ(qs[i]));
        if (!idxs.length) return '';
        const isCollapsed = collapsed.has(g.sec);
        const secIds = idxs.map(i => qs[i].id);
        const allOn = secIds.length > 0 && secIds.every(id => sel.has(id));
        return `
          <div class="sec-group" data-sec="${escapeHtml(g.sec)}">
            <div class="sec-head">
              <button class="sec-toggle" data-fold="${escapeHtml(g.sec)}">${isCollapsed ? '▸' : '▾'}</button>
              <b>${escapeHtml(g.title)}${g.type && !String(g.title).includes(TYPE_NAME[g.type] || '\u0000') ? ` · ${TYPE_NAME[g.type] || ''}` : ''}</b>
              <span class="muted small">${idxs.length}${idxs.length !== g.idxs.length ? '/' + g.idxs.length : ''} 题</span>
              <button class="chip ${allOn ? 'on' : ''}" data-sec="${escapeHtml(g.sec)}">${allOn ? '取消本节' : '本节全选'}</button>
            </div>
            <div class="sec-body">${isCollapsed ? '' : sectionBodyHtml(g)}</div>
          </div>`;
      }).join('');
      grid.innerHTML = html || '<div class="muted small" style="padding:12px 0">没有匹配的题（换个关键词或筛选试试）</div>';
      recountShown();
    }

    /* 同步选中态到已渲染的格子与节按钮（不重排 DOM），选几百题也不用整页重渲染 */
    function syncCells(root) {
      const scope = root || grid;
      scope.querySelectorAll('input[data-id]').forEach(b => {
        const on = sel.has(b.dataset.id);
        if (b.checked !== on) b.checked = on;
        const cell = b.closest('.no-cell');
        if (cell) cell.classList.toggle('on', on);
      });
      scope.querySelectorAll('button[data-sec]').forEach(btn => {
        const g = groups.find(x => String(x.sec) === btn.dataset.sec);
        if (!g) return;
        const ids = g.idxs.filter(i => matchQ(qs[i])).map(i => qs[i].id);
        const allOn = ids.length > 0 && ids.every(id => sel.has(id));
        btn.classList.toggle('on', allOn);
        btn.textContent = allOn ? '取消本节' : '本节全选';
      });
      update(shownCount);
    }

    // 事件委托：innerHTML 重写不失效，也不再每次渲染循环重绑上千个 onchange
    grid.addEventListener('change', (e) => {
      const box = e.target.closest('input[data-id]');
      if (!box) return;
      const on = box.checked;
      on ? sel.add(box.dataset.id) : sel.delete(box.dataset.id);
      const cell = box.closest('.no-cell');
      if (cell) cell.classList.toggle('on', on);
      update(shownCount);
      // 本节「全选/取消」按钮文案跟着变，但不重排
      const grp = box.closest('.sec-group');
      const g = grp && groups.find(x => String(x.sec) === (grp.dataset.sec || ''));
      const btn = grp && grp.querySelector('button[data-sec]');
      if (g && btn) {
        const ids = g.idxs.filter(i => matchQ(qs[i])).map(i => qs[i].id);
        const allOn = ids.length > 0 && ids.every(id => sel.has(id));
        btn.classList.toggle('on', allOn);
        btn.textContent = allOn ? '取消本节' : '本节全选';
      }
    });
    grid.addEventListener('click', (e) => {
      const more = e.target.closest('button[data-more]');
      if (more) {
        const sec = more.dataset.more;
        secShown.set(sec, (secShown.get(sec) || PAGE) + PAGE);
        const grp = more.closest('.sec-group');
        const g = groups.find(x => String(x.sec) === sec);
        const body = grp && grp.querySelector('.sec-body');
        if (g && body) body.innerHTML = sectionBodyHtml(g);
        recountShown();
        return;
      }
      const fold = e.target.closest('[data-fold]');
      if (fold) {
        const sec = fold.dataset.fold;
        const grp = fold.closest('.sec-group');
        const body = grp && grp.querySelector('.sec-body');
        const wasFolded = collapsed.has(sec);
        if (wasFolded) {
          collapsed.delete(sec);
          const g = groups.find(x => String(x.sec) === sec);
          if (g && body) body.innerHTML = sectionBodyHtml(g);
          fold.textContent = '▾';
        } else {
          collapsed.add(sec);
          if (body) body.innerHTML = '';
          fold.textContent = '▸';
        }
        recountShown();
        return;
      }
      const secBtn = e.target.closest('button[data-sec]');
      if (secBtn) {
        const g = groups.find(x => String(x.sec) === secBtn.dataset.sec);
        if (!g) return;
        const ids = g.idxs.filter(i => matchQ(qs[i])).map(i => qs[i].id);
        const allOn = ids.length > 0 && ids.every(id => sel.has(id));
        ids.forEach(id => allOn ? sel.delete(id) : sel.add(id));
        const grp = secBtn.closest('.sec-group');
        syncCells(grp || grid);
      }
    });


    // ===== AI 答案逐题核对（采纳 / 修改 / 重跑）=====
    const aiBtnEl = document.getElementById('ai-review-btn');
    const aiBox = document.getElementById('ai-review');
    function reviewCard(q) {
      const idx = qs.indexOf(q) + 1;
      const opts = q.options ? Object.entries(q.options).map(([k, v]) => `<div class="ai-opt">${escapeHtml(k)}. ${escapeHtml(v)}</div>`).join('') : '';
      return `
        <div class="ai-card" data-id="${q.id}">
          <div><span class="muted small">第 ${q.no ?? idx} 题 · ${TYPE_NAME[q.type] || ''}</span> <span class="ai-badge">AI 解答·需核对</span></div>
          <div class="ai-stem">${escapeHtml(q.stem)}</div>
          ${opts}
          <div class="ai-ans">AI 答案：<b>${escapeHtml(q.answer || '（空）')}</b></div>
          ${q.explanation ? `<div class="ai-exp">解析：${escapeHtml(q.explanation)}</div>` : ''}
          <div class="btn-row" style="margin-top:8px">
            <button class="btn primary" data-act="adopt">✓ 采纳</button>
            <button class="btn ghost" data-act="edit">✎ 修改</button>
            <button class="btn ghost" data-act="rerun">↻ 重跑</button>
          </div>
        </div>`;
    }
    function renderReview() {
      const list = qs.filter(q => q.aiAnswer);
      aiBtnEl.textContent = `🤖 逐题核对 AI 答案（${list.length}）`;
      aiBtnEl.style.display = list.length ? '' : 'none';
      if (!aiBox.dataset.open) return;
      aiBox.innerHTML = list.length
        ? '<div class="muted small" style="margin-top:10px">逐题核对：「采纳」转为正式答案 ·「修改」手动改正 ·「重跑」让 AI 重新解这道题</div>' + list.map(reviewCard).join('')
        : '<div class="muted small" style="margin-top:10px">✓ 没有待核对的 AI 答案了</div>';
      aiBox.querySelectorAll('.ai-card').forEach(card => {
        const q = qs.find(x => x.id === card.dataset.id);
        if (!q) return;
        card.querySelector('.btn-row').onclick = async (e) => {
          const b = e.target.closest('button[data-act]');
          if (!b) return;
          const act = b.dataset.act;
          if (act === 'adopt') {
            q.aiAnswer = false;
            await DB.questionPut(q);
            toast('已采纳为正式答案');
            renderReview(); renderGrid();
          } else if (act === 'edit') {
            if (card.querySelector('.edit-ans')) return;
            const inp = document.createElement('input');
            inp.className = 'edit-ans';
            inp.value = q.answer || '';
            inp.placeholder = '输入正确答案（选择题填字母，如 C / ACD）';
            const save = document.createElement('button');
            save.className = 'btn primary'; save.textContent = '保存';
            const cancel = document.createElement('button');
            cancel.className = 'btn ghost'; cancel.textContent = '取消';
            const er = document.createElement('div');
            er.className = 'btn-row';
            er.style.marginTop = '6px';
            er.append(save, cancel);
            card.append(inp, er);
            inp.focus();
            cancel.onclick = () => { inp.remove(); er.remove(); };
            save.onclick = async () => {
              const v = inp.value.trim();
              if (!v) return toast('答案不能为空');
              q.answer = v;
              q.aiAnswer = false;
              await DB.questionPut(q);
              toast('已保存修改');
              renderReview(); renderGrid();
            };
          } else if (act === 'rerun') {
            b.disabled = true; b.textContent = '重跑中…';
            const oldAns = q.answer, oldAI = q.aiAnswer;
            q.answer = '';
            try {
              await LLM.solveMissing([q], null, null, { markAI: true, concurrency: 1 });
              if (!q.answer) {
                q.answer = oldAns; q.aiAnswer = oldAI;
                toast('这次没解出来，已保留原 AI 答案');
              } else {
                q.aiAnswer = true;
                await DB.questionPut(q);
                toast('已重新解答，请核对');
              }
            } catch (err) {
              q.answer = oldAns; q.aiAnswer = oldAI;
              toast('重跑失败：' + String(err.message || '').slice(0, 60));
            }
            renderReview(); renderGrid();
          }
        };
      });
    }
    aiBtnEl.onclick = () => {
      aiBox.dataset.open = '1';
      renderReview();
      aiBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    renderReview();

    // 搜索防抖：大题库逐键全量重排很卡，停 200ms 再过滤
    let searchTimer = null;
    document.getElementById('q-search').oninput = (e) => {
      const v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { kw = v.trim().toLowerCase(); renderGrid(); }, 200);
    };
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
      syncCells();
    };
    document.getElementById('sel-none').onclick = () => {
      sel.clear();
      syncCells();
    };
    document.getElementById('sel-noans').onclick = () => {
      sel.clear();
      qs.filter(q => q.answer).forEach(q => sel.add(q.id));
      syncCells();
    };
    document.getElementById('sel-unans').onclick = () => {
      sel.clear();
      qs.filter(q => !q.answer).forEach(q => sel.add(q.id));
      syncCells();
    };

    goBtn.onclick = async () => {
      if (!sel.size) return toast('请先勾选题号');
      // 缺答案的题也允许练（练习时用 ✎ 自己填答案）
      const list = qs.filter(q => sel.has(q.id));
      const noAnsCount = list.filter(q => !q.answer).length;
      guardUnfinishedSession().then(go => {
        if (!go) return;
        session = new QuizSession(list, { shuffle: false });
        if (noAnsCount) toast(`其中 ${noAnsCount} 题缺答案，练习时点右上角 ✎ 自己填`);
        navigate('#/quiz');
      });
    };

    // 导出 / 复制范式：题库 → 范式文本（导出 .docx 在 Word 里改完，回「范式导入」载入即可导回）
    const canonText = () => Canon.fromQuestions(qs, bank.sections, { title: bank.name });
    document.getElementById('exp-canon').onclick = async () => {
      try {
        const r = await saveDocxFile(`${bank.name}-范式.docx`, canonText());
        toast('已导出范式 Word：' + r.path);
      } catch (e) { toast('导出失败：' + e.message.slice(0, 60)); }
    };
    document.getElementById('copy-canon').onclick = async () => {
      toast(await copyText(canonText()) ? `已复制 ${qs.length} 题的范式文本` : '复制失败，请用「导出范式 Word」');
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
        <div class="card-title">方式一 · 上传答案文件自动补答案（推荐，免费）</div>
        <p class="muted small">支持配套答案文档「2、答案：A（解析：…）」「答案：A（A. 原文）解析：…」、答案速查表（Word 表格）、答案表「1.C 2.A 3.B」「题号：1 答案：C」、纯序列「A B C D」。带章节结构的答案按 章/节/题号 精确匹配，解析一并填入；匹配不上的题可用下方 AI 智能对位兜底（AI 只从答案原文照抄，不做题）。</p>
        <button class="btn primary big" id="ans-file-btn">选择答案文件（可多选）</button>
        <input type="file" id="ans-file-input" multiple accept=".docx,.doc,.txt" style="display:none">
        <div class="muted small" id="ans-file-status"></div>
        <div id="ans-ai-match"></div>
      </div>
      ${noAns.length ? `
      <div class="card">
        <div class="card-title">方式二 · AI 解答剩余题目（可选，产生 API 费用）</div>
        <p class="muted small">答案文件和对位都搞不定的题，让 AI 直接做题补答案：<b>只解缺答案的 ${noAns.length} 题，已有答案的一律不动</b>；解出的会标「AI 解答·需核对」，建议人工核对。需在「设置」配置 API Key，按量计费。</p>
        <button class="btn ghost big" id="ans-ai-btn">AI 解答 ${noAns.length} 题</button>
        <div class="btn-row" id="ans-ai-ctrl" style="display:none">
          <button class="btn ghost" id="ans-ai-pause" style="color:var(--bad)">⏸ 暂停</button>
        </div>
        <div class="progress" id="ans-ai-prog" style="display:none"><div class="progress-bar" id="ans-ai-bar"></div></div>
        <div class="muted small" id="ans-ai-status"></div>
        <div class="muted small" id="solve-timer" style="margin-top:4px"></div>
      </div>` : '<div class="card"><div class="muted small">本库所有题目都已有答案，无需补答案。</div></div>'}`;

    const fileStatus = document.getElementById('ans-file-status');

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
          (att, cool, why) => { if (st) st.textContent = `第 ${att}/4 次重试 · ${why || '网络波动'}${cool > 0 ? `，冷却 ${cool}s` : ''}`; },
          async (batch) => { for (const q of batch) if (q.answer) await DB.questionPut(q); });
        const left = noAns.filter(q => !q.answer).length;
        if (st) st.textContent = r.filled
          ? `✓ AI 智能对位填入 ${r.filled} 个答案${r.explained ? `（含 ${r.explained} 条解析）` : ''}` + (left ? `，剩 ${left} 题未在答案原文中找到` : '')
          : '答案原文中未找到更多答案；若原卷排版太乱，可到「范式导入」页用「文件 → AI 转范式」把整份原卷重排后再导入';
        toast(`AI 对位补了 ${r.filled} 个答案`);
        render();
      } catch (e) {
        if (st) st.textContent = '⚠ ' + e.message.slice(0, 100);
        if (btn) { btn.disabled = false; btn.textContent = '重试 AI 智能对位'; }
      }
    }

    // 方式二：AI 解答剩余题目（原卷没答案时的兜底；只解缺答案的题，可暂停，逐题落库不丢进度）
    if (noAns.length) {
      const aiBtn = document.getElementById('ans-ai-btn');
      const aiStatus = document.getElementById('ans-ai-status');
      const aiProg = document.getElementById('ans-ai-prog');
      const aiBar = document.getElementById('ans-ai-bar');
      const aiCtrl = document.getElementById('ans-ai-ctrl');
      const aiPause = document.getElementById('ans-ai-pause');
      let stop = false, aborter = null;
      aiPause.onclick = () => {
        stop = true;
        if (aborter) aborter.abort('paused');
        aiPause.disabled = true;
        aiPause.textContent = '⏸ 停止中…（正在中断当前请求）';
      };
      const saveQ = q => { DB.questionPut(q).catch(() => {}); };

      aiBtn.onclick = async () => {
        const todo = noAns.filter(q => !q.answer);
        if (!todo.length) return toast('没有缺答案的题了');
        const cfg = await LLM.getConfig();
        if (!cfg.apiKey) { toast('请先到「设置」配置 API Key'); return navigate('#/settings'); }

        // 费用预估确认（单价读「设置」页的输入/输出价，与实耗同一口径）
        const estBatches = Math.ceil(todo.length / 10);
        const estPrompt = estBatches * 900;
        const estCompletion = estBatches * 150;
        const estCost = LLM.costOf({ prompt_tokens: estPrompt, completion_tokens: estCompletion }, cfg).toFixed(3);
        const conc = Math.max(1, Math.min(4, parseInt(cfg.concurrency, 10) || 4));
        const capTxt = cfg.capYuan > 0 ? `\n单次费用上限 ¥${cfg.capYuan}（实耗达到即自动暂停）` : '';
        if (!confirmDialog(
          `将让 AI 解答 ${todo.length} 道缺答案的题\n` +
          `约 ${estBatches} 批 · ${conc} 路并发\n` +
          `预估消耗：输入 ~${estPrompt} tok + 输出 ~${estCompletion} tok\n` +
          `预估费用：约 ¥${estCost}（按 ¥${cfg.priceIn}/¥${cfg.priceOut} 每百万 tok 估算，实际以账单为准）${capTxt}\n\n` +
          `解出的答案标「AI 解答·需核对」；「⏸ 暂停」立即中断当前请求，已解出的立即存库，之后再点按钮可续跑。\n\n` +
          `确认开始？`)) { aiStatus.textContent = '已取消（未调用 API）'; return; }

        stop = false;
        aborter = new AbortController();
        aiPause.disabled = false;
        aiPause.textContent = '⏸ 暂停';
        aiBtn.disabled = true;
        aiCtrl.style.display = '';
        aiProg.style.display = '';
        aiBar.style.width = '0%';
        aiStatus.textContent = `准备中…`;
        TC.start(`AI 解答 · ${todo.length} 题`);
        const t0 = Date.now();
        const solveTimer = setInterval(() => {
          const elapsed = Math.round((Date.now() - t0) / 1000);
          const timerEl = document.getElementById('solve-timer');
          if (timerEl) timerEl.textContent = `已等待 ${elapsed}s`;
        }, 1000);
        try {
          // === v1.8.7：解题改走 LLM.chat()，复用统一网络层（超时/重试/429 冷却/signal 中断） ===
          const BATCH = 10;
          const PROMPT = `你是答题专家。给下列题目补上正确答案。
请严格按照以下 JSON 格式输出，不要输出任何其他文字：
{"answers":[{"idx":0,"answer":"C"}]}
规则：
- idx 是输入里每题的序号（从0开始）
- 选择题 answer 为选项字母，如 "C" 或 "ACD"
- 判断题 answer 为 "对" 或 "错"
- 填空题 answer 为答案文本
- 只给答案，不要写解析
- 不确定的题不要猜，宁可不答
- 必须输出有效的 JSON，不要 markdown 代码块`;
          const batches = [];
          for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
          const total = batches.length;
          let solved = 0, done = 0, lastFailNote = '';
          const usage = { prompt_tokens: 0, completion_tokens: 0 };
          let stopReason = '';   // '' | 'paused' | 'cap'

          // 从模型返回里抠出 answers 数组（兼容 5 种返回格式，0/1 起始自动识别）
          const parseAnswers = raw => {
            if (!raw) return null;
            let obj = null;
            try {
              const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
              obj = JSON.parse(cleaned);
            } catch {
              const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
              if (s >= 0 && e > s) try { obj = JSON.parse(raw.slice(s, e + 1)); } catch {}
            }
            if (!obj) return null;
            if (Array.isArray(obj.answers)) return obj.answers;
            if (Array.isArray(obj)) return obj;
            if (typeof obj === 'object') {
              const keys = Object.keys(obj);
              if (keys.length && keys.every(k => /^\d+$/.test(k))) {
                const nums = keys.map(Number).sort((a, b) => a - b);
                const oneBased = nums[0] === 1 && nums[nums.length - 1] === nums.length;
                return nums.map(n => ({ idx: oneBased ? n - 1 : n, answer: obj[String(n)] }));
              }
            }
            return null;
          };

          // 单批：一次请求 → 解析 → 立即入库（解出的先落库，暂停/中断不丢）
          const solveBatch = async batch => {
            const body = batch.map((q, i) => ({ idx: i, type: q.type, stem: String(q.stem || '').slice(0, 200), options: q.options || undefined }));
            const raw = await LLM.chat(
              [{ role: 'system', content: PROMPT }, { role: 'user', content: JSON.stringify(body) }],
              { signal: aborter ? aborter.signal : null, _solveMode: true }
            );
            const u = LLM.getLastUsage();
            if (u) {
              usage.prompt_tokens += u.prompt_tokens || 0;
              usage.completion_tokens += u.completion_tokens || 0;
            }
            const answers = parseAnswers(raw);
            if (!answers) {
              lastFailNote = 'JSON 解析失败: ' + String(raw).replace(/\s+/g, ' ').slice(0, 60);
              return 0;
            }
            for (const a of answers) {
              const q = batch[+a.idx];
              if (!q || q.answer) continue;
              let ans = String(a.answer || '').trim();
              if (!ans) continue;
              if (q.type === 'judge') {
                if (/^(对|正确|√|A|1)$/i.test(ans)) ans = 'A';
                else if (/^(错|错误|×|B|0)$/i.test(ans)) ans = 'B';
                else continue;
              } else if (q.options) {
                ans = ans.toUpperCase().replace(/[^A-Z]/g, '');
                if (!ans || [...ans].some(c => !q.options[c])) continue;
              } else {
                ans = ans.replace(/[。；;]\s*$/, '').trim();
                if (!ans || /^(略|见解析|无)$/.test(ans)) continue;
              }
              q.answer = ans;
              q.aiAnswer = true;
              solved++;
              saveQ(q);
            }
            return solved;
          };

          // 并发池：按设置里的「并发数」多路同时跑，暂停/费用上限立即收手
          const conc = Math.max(1, Math.min(4, parseInt(cfg.concurrency, 10) || 4));
          const updateProgress = () => {
            aiBar.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
            aiStatus.textContent = stopReason === 'paused'
              ? `已暂停：已解出 ${solved} 题（已存库，点按钮可续跑）`
              : `AI 解答中：${done}/${total} 批 · 已解出 ${solved} 题`;
            TC.set(done, total, `已解出 ${solved} 题`);
          };
          let cursor = 0;
          const worker = async () => {
            while (!stop && !stopReason) {
              const i = cursor++;
              if (i >= total) return;
              try {
                await solveBatch(batches[i]);
              } catch (e) {
                if (e.aborted || (aborter && aborter.signal.aborted)) { stopReason = 'paused'; return; }
                lastFailNote = String(e.message || e).slice(0, 80);
              }
              done++;
              if (cfg.capYuan > 0 && LLM.costOf(usage, cfg) >= cfg.capYuan && !stopReason) stopReason = 'cap';
              updateProgress();
            }
          };
          updateProgress();
          await Promise.all(Array.from({ length: Math.min(conc, total) }, () => worker()));
          if (stop && !stopReason) stopReason = 'paused';

          aiBar.style.width = '100%';
          const left = todo.filter(q => !q.answer).length;
          const usedCost = LLM.costOf(usage, cfg).toFixed(3);
          const fin = stopReason === 'paused'
            ? `已暂停 · 已解出 ${solved} 题${left ? ` · 剩 ${left} 题` : ''}`
            : stopReason === 'cap'
              ? `触达费用上限 ¥${cfg.capYuan} · 已解出 ${solved} 题${left ? ` · 剩 ${left} 题` : ''}`
              : solved > 0
                ? `完成 · 解出 ${solved} 题${left ? ` · 剩 ${left} 题未解出` : ''}`
                : '解出 0 题';
          TC.finish(solved > 0, fin);
          if (solved > 0) {
            aiStatus.innerHTML = `✓ ${fin}<br><span style="font-size:12px;color:#aab2c5">本次实耗约 ¥${usedCost}（输入 ${usage.prompt_tokens} + 输出 ${usage.completion_tokens} tok）</span>`;
            toast(`AI 解出 ${solved} 题答案，请核对${left ? `，剩 ${left} 题未解出` : ''}`);
            render();
          } else {
            aiStatus.innerHTML = '⚠ 没解出任何答案<br>'
              + `<span style="font-size:12px;color:#aab2c5">原因：${escapeHtml(lastFailNote || '未知')}</span><br>`
              + '<span style="font-size:12px">请检查 API 配置是否正确</span>';
          }
        } catch (e) {
          aiStatus.textContent = '⚠ ' + String(e.message || e).slice(0, 140);
          TC.finish(false, '中断：' + String(e.message || e).slice(0, 60) + '（已解出的已存库）');
          toast('解答中断（已解出的已存库，可重试）');
        } finally {
          aborter = null;
          clearInterval(solveTimer); // 清除计时器
          aiBtn.disabled = false;
          aiCtrl.style.display = 'none';
          aiProg.style.display = 'none';
        }
      };
    }
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
    const secExpanded = new Set();              // 章节区：默认整库折叠，点库头才展开（v1.8.12）
    let bankKw = '', bankExpanded = false, exam = false, timeMode = 'auto';
    const LIMIT = 6;

    $view().innerHTML = `
      <div class="card">
        <div class="card-title">范围（题库）</div>
        <button class="btn ghost big" id="bank-open" style="width:100%"></button>
        <div class="muted small" style="margin-top:8px">点上面弹出题库选择（默认全选，可搜索）</div>
      </div>

      <div class="card">
        <div class="card-title">范围（章节）</div>
        <button class="btn ghost big" id="sec-open" style="width:100%"></button>
        <div class="muted small" style="margin-top:8px">不选 = 全部章节；点上面弹出章节选择</div>
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
        <div class="muted small" style="margin-top:8px">随机 = 题目顺序 + 选项顺序都打乱（答案自动换算，判分不受影响）</div>
      </div>
      <button class="btn primary big" id="start-quiz"></button>
      <button class="btn primary big" onclick="App.navigate('#/wrong-setup')">错题重做</button>
      ${starCount ? `<button class="btn ghost big" onclick="App.navigate('#/star-setup')">★ 收藏重练（${starCount}）</button>` : ''}

      <div id="sec-sheet" style="display:none;position:fixed;inset:0;z-index:99">
        <div id="sec-mask" style="position:absolute;inset:0;background:rgba(0,0,0,.45)"></div>
        <div style="position:absolute;left:0;right:0;bottom:0;max-height:72vh;background:var(--card);border-radius:16px 16px 0 0;display:flex;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,.25)">
          <div style="padding:14px 16px 8px;display:flex;align-items:center;gap:8px">
            <b style="flex:1;font-size:15px">选择章节</b>
            <button class="chip" id="sec-sheet-clear">清空（=全部章节）</button>
            <button class="btn primary" id="sec-sheet-done" style="padding:8px 16px">完成</button>
          </div>
          <div id="sec-area" style="overflow-y:auto;padding:0 16px calc(20px + env(safe-area-inset-bottom));flex:1;-webkit-overflow-scrolling:touch"></div>
        </div>
      </div>

      <div id="bank-sheet" style="display:none;position:fixed;inset:0;z-index:99">
        <div id="bank-mask" style="position:absolute;inset:0;background:rgba(0,0,0,.45)"></div>
        <div style="position:absolute;left:0;right:0;bottom:0;max-height:76vh;background:var(--card);border-radius:16px 16px 0 0;display:flex;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,.25)">
          <div style="padding:14px 16px 8px;display:flex;align-items:center;gap:8px">
            <b style="flex:1;font-size:15px">选择题库</b>
            <button class="btn primary" id="bank-sheet-done" style="padding:8px 16px">完成</button>
          </div>
          <div style="padding:0 16px 8px">
            <input id="setup-search" class="search-input" style="width:100%" placeholder="搜索题库名称…">
            <div class="chips" id="pick-tools" style="margin-top:8px">
              <button class="chip" data-act="all">全选</button>
              <button class="chip" data-act="none">清空</button>
              <button class="chip" data-act="ans">只选有答案的库</button>
            </div>
          </div>
          <div class="bank-pick" id="bank-pick" style="overflow-y:auto;padding:0 16px;flex:1;-webkit-overflow-scrolling:touch"></div>
          <div style="padding:8px 16px calc(12px + env(safe-area-inset-bottom))">
            <button class="btn ghost" id="pick-more" style="display:none;width:100%"></button>
          </div>
        </div>
      </div>`;

    const bankPickEl = document.getElementById('bank-pick');
    const pickMoreBtn = document.getElementById('pick-more');
    /* 题库选择弹层：点摘要按钮拉起，遮罩/完成关闭（v1.8.13） */
    const bankSheet = document.getElementById('bank-sheet');
    document.getElementById('bank-open').onclick = () => { bankSheet.style.display = ''; };
    document.getElementById('bank-mask').onclick = () => { bankSheet.style.display = 'none'; };
    document.getElementById('bank-sheet-done').onclick = () => { bankSheet.style.display = 'none'; };
    const secArea = document.getElementById('sec-area');
    const secOpenBtn = document.getElementById('sec-open');
    const secSheet = document.getElementById('sec-sheet');
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
      document.getElementById('bank-open').textContent = sel.size === banks.length
        ? `📂 全部 ${banks.length} 个题库（点此修改） ›`
        : `📂 已选 ${sel.size}/${banks.length} 个题库（点此修改） ›`;
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
        const folded = !secExpanded.has(b.id);
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
      secOpenBtn.textContent = selSecs.size ? `📂 已选 ${selSecs.size} 个章节（点此修改） ›` : `📂 全部章节（点此选择） ›`;
      // 整库折叠/展开
      secArea.querySelectorAll('button[data-fold]').forEach(btn => {
        btn.onclick = () => {
          const bid = btn.dataset.fold;
          secExpanded.has(bid) ? secExpanded.delete(bid) : secExpanded.add(bid);
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
    /* ---- 章节选择：点击默认拉起底部弹层，不在页面里铺开 ---- */
    secOpenBtn.onclick = () => { secSheet.style.display = ''; };
    document.getElementById('sec-mask').onclick = () => { secSheet.style.display = 'none'; };
    document.getElementById('sec-sheet-done').onclick = () => { secSheet.style.display = 'none'; };
    document.getElementById('sec-sheet-clear').onclick = () => {
      selSecs.clear(); renderSecs(); refresh();
    };
    const segType = document.getElementById('seg-type');
    const segOrder = document.getElementById('seg-order');
    prefShuffle().then(v => {   // 打开页面先还原上次选的顺序（默认随机）
      segOrder.querySelectorAll('button').forEach(x => x.classList.toggle('on', (x.dataset.v === 'shuffle') === v));
    });
    const segMode = document.getElementById('seg-mode');
    const segTime = document.getElementById('seg-time');
    [[segType], [segOrder], [segMode], [segTime]].forEach(([seg]) => {
      seg.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        if (seg === segOrder) savePrefShuffle(b.dataset.v === 'shuffle');   // 记住顺序偏好（题库直开也生效）
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
      if (!await guardUnfinishedSession()) return;
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
    if (!await guardUnfinishedSession()) return;
    session = await QuizBuilder.wrongRedo();
    if (!session.total) return toast('没有错题');
    navigate('#/quiz');
  }

  async function starRedo() {
    const qs = (await DB.starQuestions()).filter(q => q.answer);
    if (!qs.length) return toast('收藏的题都缺答案');
    if (!await guardUnfinishedSession()) return;
    session = new QuizSession(qs, { shuffle: true, mode: 'star' });
    navigate('#/quiz');
  }

  /* ================= 页面：错题重做 / 收藏重练 范围选择 =================
     与「开始练习」同风格：按题库分类勾选范围 + 题型/模式/顺序，替代旧的"一键全量开练" */
  async function pageReviewSetup(kind) {
    const isWrong = kind === 'wrong';
    topbar(isWrong ? '错题重做' : '★ 收藏重练', isWrong ? '#/wrong' : '#/star');
    const banks = await DB.bankList();
    const bankName = new Map(banks.map(b => [b.id, b.name]));
    const pool = (isWrong ? await DB.wrongQuestions() : (await DB.starQuestions()).filter(q => q.answer))
      .filter(q => bankName.has(q.bankId));
    if (!pool.length) {
      $view().innerHTML = `<div class="empty" style="padding-top:40px">${isWrong ? '没有错题<br>继续保持！' : '还没有能练的收藏题<br><span class="muted small">收藏的题补上答案后可在这里重练</span>'}</div>`;
      return;
    }
    const cnt = new Map();               // bankId -> 可练题数
    for (const q of pool) cnt.set(q.bankId, (cnt.get(q.bankId) || 0) + 1);
    const list = banks.filter(b => cnt.has(b.id));
    const sel = new Set(list.map(b => b.id));
    let filterType = 'all', exam = false, timeMode = 'auto', shuffle = true;
    /* 章节筛选（v1.8.13）：selSecs 空 = 全部章节；分组默认折叠 */
    const selSecs = new Set();
    const secExp = new Set();
    const secMeta = new Map();          // "bankId:secIdx" -> { bankId, secIdx, n }
    for (const q of pool) {
      const s = String(q.secIdx ?? '');
      const k = q.bankId + ':' + s;
      const m = secMeta.get(k) || { bankId: q.bankId, secIdx: s, n: 0 };
      m.n++; secMeta.set(k, m);
    }
    const secTitle = new Map();
    for (const b of banks) for (const s of (b.sections || [])) secTitle.set(b.id + ':' + String(s.secIdx), s.title);

    $view().innerHTML = `
      <div class="card">
        <div class="card-title">范围（题库）</div>
        <button class="btn ghost big" id="rv-open" style="width:100%"></button>
        <div class="muted small" style="margin-top:8px">点上面弹出题库选择（全部展开，无需折叠）</div>
      </div>
      <div class="card">
        <div class="card-title">范围（章节）</div>
        <button class="btn ghost big" id="rv-sec-open" style="width:100%"></button>
        <div class="muted small" style="margin-top:8px">不选 = 全部章节；点上面弹出章节选择（分组默认折叠）</div>
      </div>
      <div class="card">
        <div class="card-title">题型</div>
        <div class="seg" id="rv-type">
          <button data-v="all" class="on">全部</button>
          <button data-v="choice">选择/判断</button>
          <button data-v="fill">填空</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">模式</div>
        <div class="seg" id="rv-mode">
          <button data-v="learn" class="on">📖 学习模式</button>
          <button data-v="exam">📝 考试模式</button>
        </div>
        <div id="rv-exam-opts" style="display:none;margin-top:10px">
          <div class="field"><span>考试时长</span>
            <div class="seg" id="rv-time">
              <button data-v="auto" class="on">按 1 分钟/题</button>
              <button data-v="none">不限时</button>
              <button data-v="custom">自定义</button>
            </div>
          </div>
          <div class="field" id="rv-min-wrap" style="display:none"><span>时长（分钟）</span>
            <input type="number" id="rv-min" min="1" max="600" value="60" inputmode="numeric">
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">顺序</div>
        <div class="seg" id="rv-order">
          <button data-v="shuffle" class="on">随机</button>
          <button data-v="order">顺序</button>
        </div>
        <div class="muted small" style="margin-top:8px">随机 = 题目顺序 + 选项顺序都打乱（答案自动换算，判分不受影响）</div>
      </div>
      <button class="btn primary big" id="rv-start"></button>

      <div id="rv-sheet" style="display:none;position:fixed;inset:0;z-index:99">
        <div id="rv-mask" style="position:absolute;inset:0;background:rgba(0,0,0,.45)"></div>
        <div style="position:absolute;left:0;right:0;bottom:0;max-height:72vh;background:var(--card);border-radius:16px 16px 0 0;display:flex;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,.25)">
          <div style="padding:14px 16px 8px;display:flex;align-items:center;gap:8px">
            <b style="flex:1;font-size:15px">选择题库</b>
            <button class="chip" id="rv-tools-all">全选</button>
            <button class="chip" id="rv-tools-none">清空</button>
            <button class="btn primary" id="rv-done" style="padding:8px 16px">完成</button>
          </div>
          <div id="rv-pick" class="bank-pick" style="overflow-y:auto;padding:0 16px calc(20px + env(safe-area-inset-bottom));flex:1;-webkit-overflow-scrolling:touch"></div>
        </div>
      </div>

      <div id="rv-sec-sheet" style="display:none;position:fixed;inset:0;z-index:99">
        <div id="rv-sec-mask" style="position:absolute;inset:0;background:rgba(0,0,0,.45)"></div>
        <div style="position:absolute;left:0;right:0;bottom:0;max-height:72vh;background:var(--card);border-radius:16px 16px 0 0;display:flex;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,.25)">
          <div style="padding:14px 16px 8px;display:flex;align-items:center;gap:8px">
            <b style="flex:1;font-size:15px">选择章节</b>
            <button class="chip" id="rv-sec-clear">清空（=全部章节）</button>
            <button class="btn primary" id="rv-sec-done" style="padding:8px 16px">完成</button>
          </div>
          <div id="rv-sec-area" style="overflow-y:auto;padding:0 16px calc(20px + env(safe-area-inset-bottom));flex:1;-webkit-overflow-scrolling:touch"></div>
        </div>
      </div>`;

    const pickEl = document.getElementById('rv-pick');
    const startBtn = document.getElementById('rv-start');
    const rvOpenBtn = document.getElementById('rv-open');
    const rvSheet = document.getElementById('rv-sheet');

    const matchType = q => filterType === 'all' ? true
      : filterType === 'choice' ? (q.type === 'single' || q.type === 'multi' || q.type === 'judge')
      : q.type === 'fill';
    const matchSec = q => !selSecs.size || selSecs.has(q.bankId + ':' + String(q.secIdx ?? ''));

    function renderPick() {
      pickEl.innerHTML = list.map(b => `
        <label class="pick-item"><input type="checkbox" value="${b.id}" ${sel.has(b.id) ? 'checked' : ''}>
          <span class="pick-name">${escapeHtml(bankName.get(b.id))}</span>
          <span class="muted small pick-num">${cnt.get(b.id)}</span>
        </label>`).join('');
      pickEl.querySelectorAll('input').forEach(i => {
        i.onchange = () => { i.checked ? sel.add(i.value) : sel.delete(i.value); refresh(); };
      });
      rvOpenBtn.textContent = sel.size === list.length
        ? `📂 全部 ${list.length} 个题库（点此修改） ›`
        : `📂 已选 ${sel.size}/${list.length} 个题库（点此修改） ›`;
    }
    function countAvail() { return pool.filter(q => sel.has(q.bankId) && matchType(q) && matchSec(q)).length; }
    function curMinutes(n) {
      if (!exam || timeMode === 'none') return 0;
      if (timeMode === 'custom') return Math.max(1, parseInt(document.getElementById('rv-min').value, 10) || 60);
      return Math.max(1, n);             // 按 1 分钟/题
    }
    function refresh() {
      const n = countAvail();
      startBtn.textContent = n ? `开始${isWrong ? '重做' : '重练'}（${n} 题）` : '该范围没有可练的题';
      startBtn.style.opacity = n ? '' : '.5';
    }
    /* 题库选择：进入页面默认拉起底部弹层，全部展开、无折叠；主页留摘要按钮可再次打开 */
    document.getElementById('rv-tools-all').onclick = () => { list.forEach(x => sel.add(x.id)); renderPick(); refresh(); };
    document.getElementById('rv-tools-none').onclick = () => { sel.clear(); renderPick(); refresh(); };
    rvOpenBtn.onclick = () => { rvSheet.style.display = ''; };
    document.getElementById('rv-mask').onclick = () => { rvSheet.style.display = 'none'; };
    document.getElementById('rv-done').onclick = () => { rvSheet.style.display = 'none'; };

    /* ---- 章节选择弹层（v1.8.13）：按库分组、默认折叠，点库头展开；清空 = 全部章节 ---- */
    const rvSecArea = document.getElementById('rv-sec-area');
    const rvSecOpenBtn = document.getElementById('rv-sec-open');
    const rvSecSheet = document.getElementById('rv-sec-sheet');
    function renderRvSecs() {
      const parts = [];
      for (const b of list) {
        if (!sel.has(b.id)) continue;
        const secs = [...secMeta.values()].filter(m => m.bankId === b.id);
        if (!secs.length) continue;
        const picked = secs.filter(m => selSecs.has(b.id + ':' + m.secIdx)).length;
        const folded = !secExp.has(b.id);
        parts.push(`
          <div class="sec-pick">
            <div class="sec-pick-head">
              <button class="sec-toggle" data-rvfold="${b.id}" title="${folded ? '展开本章节' : '折叠本章节'}">${folded ? '▸' : '▾'}</button>
              <b>${escapeHtml(bankName.get(b.id))}</b>
              <span class="muted small">${picked ? `已选 ${picked}/${secs.length}` : `${secs.length} 章`}</span>
              <button class="chip" data-rvbank="${b.id}">全选/清空</button>
            </div>
            ${folded ? '' : `<div class="chips">
              ${secs.map(m => {
                const key = b.id + ':' + m.secIdx;
                return `<button class="chip ${selSecs.has(key) ? 'on' : ''}" data-rvsec="${key}" title="${escapeHtml(secTitle.get(key) || '')}">${escapeHtml(secTitle.get(key) || (m.secIdx === '' ? '未分节' : `第 ${m.secIdx} 章`))}（${m.n}）</button>`;
              }).join('')}
            </div>`}
          </div>`);
      }
      rvSecArea.innerHTML = parts.join('') || '<div class="muted small" style="padding:12px 0">当前题库没有章节信息，章节筛选不可用</div>';
      rvSecArea.querySelectorAll('button[data-rvfold]').forEach(btn => {
        btn.onclick = () => { const bid = btn.dataset.rvfold; secExp.has(bid) ? secExp.delete(bid) : secExp.add(bid); renderRvSecs(); };
      });
      rvSecArea.querySelectorAll('button[data-rvbank]').forEach(btn => {
        btn.onclick = () => {
          const bid = btn.dataset.rvbank;
          const keys = [...secMeta.values()].filter(m => m.bankId === bid).map(m => bid + ':' + m.secIdx);
          const all = keys.every(k => selSecs.has(k));
          keys.forEach(k => all ? selSecs.delete(k) : selSecs.add(k));
          renderRvSecs(); refresh();
        };
      });
      rvSecArea.querySelectorAll('button[data-rvsec]').forEach(btn => {
        btn.onclick = () => { const k = btn.dataset.rvsec; selSecs.has(k) ? selSecs.delete(k) : selSecs.add(k); renderRvSecs(); refresh(); };
      });
      rvSecOpenBtn.textContent = selSecs.size ? `📂 已选 ${selSecs.size} 个章节（点此修改） ›` : `📂 全部章节（点此选择） ›`;
    }
    rvSecOpenBtn.onclick = () => { renderRvSecs(); rvSecSheet.style.display = ''; };
    document.getElementById('rv-sec-mask').onclick = () => { rvSecSheet.style.display = 'none'; };
    document.getElementById('rv-sec-done').onclick = () => { rvSecSheet.style.display = 'none'; };
    document.getElementById('rv-sec-clear').onclick = () => { selSecs.clear(); renderRvSecs(); refresh(); };
    rvSecOpenBtn.textContent = '📂 全部章节（点此选择） ›';
    [[document.getElementById('rv-type'), v => filterType = v],
     [document.getElementById('rv-time'), v => { timeMode = v; document.getElementById('rv-min-wrap').style.display = v === 'custom' ? '' : 'none'; }]]
      .forEach(([seg, set]) => {
        seg.onclick = e => {
          const b = e.target.closest('button[data-v]'); if (!b) return;
          seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
          b.classList.add('on'); set(b.dataset.v); refresh();
        };
      });
    document.getElementById('rv-mode').onclick = e => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      document.getElementById('rv-mode').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      exam = b.dataset.v === 'exam';
      document.getElementById('rv-exam-opts').style.display = exam ? '' : 'none';
      refresh();
    };
    document.getElementById('rv-min').addEventListener('input', refresh);
    document.getElementById('rv-order').onclick = e => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      document.getElementById('rv-order').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); shuffle = b.dataset.v === 'shuffle';
      savePrefShuffle(shuffle);   // 记住顺序偏好（题库直开也生效）
    };
    prefShuffle().then(v => {   // 打开页面先还原上次选的顺序（默认随机）
      document.getElementById('rv-order').querySelectorAll('button').forEach(x => x.classList.toggle('on', (x.dataset.v === 'shuffle') === v));
      shuffle = v;
    });
    startBtn.onclick = () => {
      const qs = pool.filter(q => sel.has(q.bankId) && matchType(q) && matchSec(q));
      if (!qs.length) return toast('该范围没有可练的题');
      guardUnfinishedSession().then(go => {
        if (!go) return;
        session = new QuizSession(qs, { shuffle, exam, minutes: curMinutes(qs.length), mode: isWrong ? 'wrong' : 'star' });
        navigate('#/quiz');
      });
    };
    renderPick(); refresh();
    rvSheet.style.display = '';   // 默认拉起：进入页面直接弹选择题库
  }
  async function pageQuiz() {
    if (!session) return navigate('#/quiz-setup');
    // 考试中：超时自动交卷；已交卷：直接看成绩单
    if (session.inExam && session.deadline && Date.now() >= session.deadline) return submitExam(true);
    if (session.inExam && session.graded) return navigate('#/quiz-result');
    if (!session.inExam && session.finished) return navigate('#/quiz-result');
    if (!session.inExam && session._submitted) return navigate('#/quiz-result'); // 答题卡页已提交本次题库

    const q = session.current;
    topbar(`${session.pos} / ${session.total}`, session.inExam ? null : '#/quiz-setup');
    const multi = q.type === 'multi';
    const optKeys = q.options ? Object.keys(q.options) : [];
    const starSet = new Set(await DB.starIds());
    const inExam = session.inExam;
    const recite = !inExam && !!session.recite;   // 背题模式：直接看答案、不用作答（学习类会话）
    const examPicked = inExam ? (session.examAnswers.get(q.id) || '') : '';
    const donePct = recite
      ? (session.total ? Math.round(session.pos / session.total * 100) : 0)
      : (session.total ? Math.round(session.progress.done / session.total * 100) : 0);
    const optIsRight = k => !!q.answer && q.answer.toUpperCase().includes(k);

    $view().innerHTML = `
      <div class="quiz-head">
        <span class="q-type ${q.type}">${typeLabel[q.type]}</span>
        ${inExam ? `<span class="exam-timer" id="exam-timer">--:--</span>`
          : recite ? `<span class="quiz-prog">${session.pos} / ${session.total}</span>`
          : `<span class="quiz-prog">${session.progress.done} 已答</span>`}
        ${!inExam ? `<button class="star-btn${recite ? ' on' : ''}" id="recite-btn" title="背题模式：直接看答案，不用作答">${recite ? '✎' : '📖'}</button>` : ''}
        <button class="star-btn" id="sheet-btn" title="答题卡" style="font-size:19px">▦</button>
        <button class="star-btn" id="star-btn" title="收藏本题">☆</button>
        <button class="star-btn" id="edit-btn" title="修改答案与解析" style="font-size:19px">✎</button>
      </div>
      <div class="quiz-bar"><div class="quiz-bar-fill" style="width:${donePct}%"></div></div>
      ${inExam ? `<div class="exam-banner">📝 考试中 · 已答 ${session.progress.done}/${session.total} · 作答时不显示对错，交卷后统一评分</div>` : ''}
      <div class="card" id="edit-card" style="display:none"></div>
      ${!recite && !q.answer ? `<div class="card" style="border-left:4px solid var(--bad)">
        <div class="small" style="color:var(--bad)">本题暂无标准答案 —— 点右上角 ✎ 填入答案与解析后即可作答判分（不填也能直接翻下一题）</div>
      </div>` : ''}
      ${recite ? `
      <div class="card recite-card">
        <div class="muted small" style="margin-bottom:10px">📖 背题模式：直接看答案与解析，不用作答；左右滑动或点下方按钮翻题</div>
        <div class="stem">${renderStem(q)}</div>
        ${q.type === 'fill' ? `
          <div class="rev-ans">
            <div class="rev-ans-row"><span class="rev-ans-k">答案</span><span class="${q.answer ? 'rev-ua-ok' : 'rev-ua-none'}">${q.answer ? escapeHtml(String(q.answer).replace(/\|\|\|/g, ' ／ ')) : '（本题缺答案）'}</span></div>
          </div>` : `
          <div class="options">
            ${optKeys.map(k => `
              <button class="option disabled${optIsRight(k) ? ' right' : ''}">
                <span class="opt-key">${k}</span>
                <span class="opt-text">${escapeHtml(q.options[k])}</span>
                ${optIsRight(k) ? '<span class="opt-mark ok">答案</span>' : ''}
              </button>`).join('')}
          </div>
          <div class="wrong-ans">答案：${q.answer ? escapeHtml(q.answer) : '（本题缺答案）'}</div>`}
        ${q.explanation ? `<div class="judge-exp">解析：${escapeHtml(q.explanation)}</div>` : '<div class="muted small" style="margin-top:8px">（本题无解析）</div>'}
      </div>` : `
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
      </div>`}
      <div class="quiz-nav">
        <button class="btn ghost" id="skip-btn" ${session.index === 0 ? 'disabled' : ''}>上一题</button>
        ${recite
          ? `<button class="btn ghost" id="next-btn" ${session.index >= session.total - 1 ? 'disabled' : ''}>下一题</button>`
          : inExam
            ? `${session.index < session.total - 1 ? '<button class="btn ghost" id="next-btn">下一题</button>' : ''}
               <button class="btn primary" id="submit-exam-btn">交卷</button>`
            : `<button class="btn ghost" id="next-btn">${session.answered.has(q.id) ? '下一题' : (session.index < session.total - 1 ? '跳过 ›' : '结束练习')}</button>`}
      </div>`;

    const judgeArea = document.getElementById('judge-area');
    const nextBtn = document.getElementById('next-btn');
    const answered = session.answered.get(q.id);
    const sheetBtn = document.getElementById('sheet-btn');

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
      updateBar();
    }

    if (!recite && answered) showResult(answered);
    // 缺标准答案的题：不判分，直接允许翻下一题
    if (!recite && !q.answer && nextBtn) nextBtn.style.display = '';

    /* ---- 考试模式：只存答案不判分（自动保存，可随时改） ---- */
    const saveExam = (val) => {
      if (!String(val).replace(/\|\|\|/g, '').trim()) session.examAnswers.delete(q.id);
      else session.answer(val);
      saveProgress();
      const banner = document.querySelector('.exam-banner');
      if (banner) banner.textContent = `📝 考试中 · 已答 ${session.progress.done}/${session.total} · 作答时不显示对错，交卷后统一评分`;
      updateBar();
    };

    if (!recite && q.type === 'fill') {
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
    } else if (!recite) {
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
      if (recite) {   // 背题：自由翻题，不作答、不出成绩
        if (session.index < session.total - 1) { session.index++; saveProgress(); render(); }
        return;
      }
      session.next();
      saveProgress();
      if (session.finished) navigate('#/quiz-result'); // hash 变化自动触发 render
      else render(); // hash 未变，手动渲染
    };
    // 考试：手动交卷
    const examSubmitBtn = document.getElementById('submit-exam-btn');
    if (examSubmitBtn) examSubmitBtn.onclick = () => submitExam(false);
    if (inExam && session.deadline) startExamTimer();

    // 答题卡：跳转到独立答题卡页（总览 + 提交题库）
    if (sheetBtn) sheetBtn.onclick = () => navigate('#/quiz-sheet');

    // 背题模式开关：直接看答案、不用作答（仅学习类会话）
    const reciteBtn = document.getElementById('recite-btn');
    if (reciteBtn) reciteBtn.onclick = () => {
      session.recite = !session.recite;
      saveProgress();
      render();
      toast(session.recite ? '已进入背题模式：直接看答案' : '已退出背题模式');
    };

    // 收藏本题：状态已在渲染时读好，点击切换
    const starBtn = document.getElementById('star-btn');
    if (starBtn && starSet.has(q.id)) { starBtn.textContent = '★'; starBtn.classList.add('on'); }
    if (starBtn) starBtn.onclick = async () => {
      const added = await DB.starToggle(q.id);
      starBtn.textContent = added ? '★' : '☆';
      starBtn.classList.toggle('on', added);
      if (added) starSet.add(q.id); else starSet.delete(q.id);
      toast(added ? '已收藏' : '已取消收藏');
    };

    /* ---- 编辑答案与解析（当场纠错） ---- */
    const editCard = document.getElementById('edit-card');
    const editBtn = document.getElementById('edit-btn');
    let editOpen = false;
    function renderEditPanel() {
      /* v1.8.17：修改本题 —— 支持改题型（单选/多选/判断/填空）、选项、答案、解析 */
      const TYPES = [['single', '单选'], ['multi', '多选'], ['judge', '判断'], ['fill', '填空']];
      // 面板状态（切换题型时保留已输入内容）
      const st = {
        type: q.type || 'single',
        sel: new Set((q.answer || '').toUpperCase().match(/[A-H]/g) || []),
        ansText: String(q.answer ?? '').replace(/\|\|\|/g, '/'),
        optsText: q.options && q.type !== 'judge' ? Object.entries(q.options).map(([k, v]) => `${k}. ${v}`).join('\n') : '',
        exp: q.explanation || ''
      };
      const parseOpts = text => {
        const opts = {};
        let auto = 0;
        for (const line of String(text || '').split('\n')) {
          const t = line.trim(); if (!t) continue;
          const m = t.match(/^([A-Ha-h])\s*[.、．:：)）]?\s*(.*)$/);
          if (m) opts[m[1].toUpperCase()] = m[2].trim();
          else opts[String.fromCharCode(65 + (auto++))] = t;   // 无字母前缀 → 自动编号
        }
        return opts;
      };
      const renderPanel = () => {
        const isFill = st.type === 'fill';
        const isJudge = st.type === 'judge';
        const oKeys = isJudge ? ['A', 'B'] : (isFill ? [] : Object.keys(parseOpts(st.optsText)));
        editCard.innerHTML = `
        <div class="card-title">修改本题（第 ${q.no ?? '?'} 题）</div>
        <div class="field"><span>题型</span>
          <div class="seg" id="edit-types" style="flex-wrap:wrap">
            ${TYPES.map(([v, n]) => `<button data-t="${v}" class="${st.type === v ? 'on' : ''}" style="flex:0 0 auto;min-width:64px;padding:8px 14px">${n}</button>`).join('')}
          </div>
        </div>
        <div class="field"><span>答案${isFill ? '（多空用 / 分隔）' : ''}</span>
          ${isFill
            ? `<input type="text" id="edit-ans" value="${escapeHtml(st.ansText)}" placeholder="标准答案">`
            : `<div class="seg" id="edit-letters" style="flex-wrap:wrap">
                ${oKeys.length ? oKeys.map(k => `<button data-k="${k}" class="${st.sel.has(k) ? 'on' : ''}" style="flex:0 0 auto;min-width:52px;padding:8px 14px">${isJudge ? (k === 'A' ? '正确' : '错误') : k}</button>`).join('') : '<span class="muted small">请先在下方填写选项</span>'}
              </div>`}
        </div>
        ${!isFill && !isJudge ? `
        <div class="field"><span>选项（每行一个，A. 文本）</span>
          <textarea id="edit-opts" rows="4" style="border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;background:var(--card);color:var(--text);width:100%">${escapeHtml(st.optsText)}</textarea>
        </div>` : isJudge ? '<div class="muted small">判断题：选项固定为「正确 / 错误」</div>' : ''}
        <div class="field"><span>解析</span>
          <textarea id="edit-exp" rows="3" style="border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;background:var(--card);color:var(--text);width:100%">${escapeHtml(st.exp)}</textarea>
        </div>
        <div class="btn-row">
          <button class="btn ghost" id="edit-cancel">取消</button>
          <button class="btn primary" id="edit-save">保存修改</button>
        </div>`;
        // 题型切换：先收起当前输入再重渲染
        editCard.querySelector('#edit-types').onclick = e => {
          const b = e.target.closest('button[data-t]'); if (!b || b.dataset.t === st.type) return;
          const newType = b.dataset.t;
          const ansEl = editCard.querySelector('#edit-ans');
          const optsEl = editCard.querySelector('#edit-opts');
          const expEl = editCard.querySelector('#edit-exp');
          if (ansEl) st.ansText = ansEl.value;
          if (optsEl) st.optsText = optsEl.value;
          if (expEl) st.exp = expEl.value;
          if (newType === 'fill') { st.type = 'fill'; }                    // 字母选择丢弃，用文字答案
          else if (newType === 'judge') {
            st.type = 'judge';
            st.sel = new Set([...st.sel].filter(k => k === 'A' || k === 'B'));   // 判断题只留 A/B
          } else {
            st.type = newType;
            if (!st.optsText.trim()) st.optsText = 'A. \nB. \nC. \nD. ';
            // 选项集合可能变了，超出的字母自动去掉
            const ok = new Set(Object.keys(parseOpts(st.optsText)));
            st.sel = new Set([...st.sel].filter(k => ok.has(k)));
          }
          renderPanel();
        };
        // 字母选择
        const letters = editCard.querySelector('#edit-letters');
        if (letters) {
          letters.onclick = e => {
            const b = e.target.closest('button[data-k]'); if (!b) return;
            if (st.type === 'multi') b.classList.toggle('on'), b.classList.contains('on') ? st.sel.add(b.dataset.k) : st.sel.delete(b.dataset.k);
            else { letters.querySelectorAll('button').forEach(x => { x.classList.remove('on'); }); b.classList.add('on'); st.sel.clear(); st.sel.add(b.dataset.k); }
          };
        }
        editCard.querySelector('#edit-cancel').onclick = () => { editOpen = false; editCard.style.display = 'none'; };
        editCard.querySelector('#edit-save').onclick = async () => {
          const expEl = editCard.querySelector('#edit-exp');
          const newExp = expEl ? expEl.value.trim() : '';
          if (st.type === 'fill') {
            const ansEl = editCard.querySelector('#edit-ans');
            const newAns = (ansEl ? ansEl.value : '').trim().split('/').map(s => s.trim()).filter(Boolean).join('|||');
            if (!newAns) return toast('答案不能为空');
            q.type = 'fill'; q.options = null; q.answer = newAns;
          } else {
            const optsEl = editCard.querySelector('#edit-opts');
            const opts = st.type === 'judge' ? { 'A': '正确', 'B': '错误' } : parseOpts(optsEl ? optsEl.value : st.optsText);
            const keys = Object.keys(opts);
            if (st.type !== 'judge' && keys.length < 2) return toast('选项至少需要 2 个（每行一个：A. 文本）');
            const sel = [...st.sel].filter(k => opts[k]).sort().join('');
            if (!sel) return toast('请选择答案字母');
            if ((st.type === 'single' || st.type === 'judge') && sel.length !== 1) return toast(st.type === 'single' ? '单选题只能选一个答案' : '判断题只能选一个答案');
            q.type = st.type; q.options = opts; q.answer = sel;
          }
          q.explanation = newExp || null;
          await DB.questionPut(q);
          // 本题若已答过，清除作答状态让用户按新答案重做
          session.answered.delete(q.id);
          editOpen = false;
          toast('已修改');
          render();
        };
      };
      renderPanel();
    }
    if (editBtn) editBtn.onclick = () => {
      editOpen = !editOpen;
      if (editOpen) { renderEditPanel(); editCard.style.display = ''; editCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else editCard.style.display = 'none';
    };

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
        if (dx < 0) { // 左滑 → 下一题（学习/考试均可自由翻题，未答视为跳过）
          if (nextBtn) nextBtn.click();
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

  /* ================= 页面：答题卡（独立页：总览 + 跳题 + 提交题库） ================= */
  async function pageQuizSheet() {
    if (!session) return navigate('#/quiz-setup');
    const inExam = session.inExam;
    const recite = !inExam && !!session.recite;
    const p = session.progress;
    const starSet = new Set(await DB.starIds());
    topbar('答题卡', '#/quiz');

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

    const statLine = `已答 ${p.done} / ${p.total} 题` + (!inExam && p.done ? ` · 对 ${p.correct} · 错 ${p.wrong}` : '');
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">答题卡 · ${statLine}</div>
        <div class="sheet-grid" style="margin-top:0">${cells}</div>
        <div class="sheet-legend">
          <span><i></i>未答</span>
          ${inExam ? '<span><i class="filled"></i>已答</span>' : '<span><i class="done"></i>答对</span><span><i class="wrong"></i>答错</span>'}
          <span><i class="cur"></i>当前题</span>
          <span>★ 收藏</span>
        </div>
        <div class="muted small" style="margin-top:8px">${inExam ? '格子下方小字是你已选答案；点题号回到该题，答案可随时修改' : '格子下方小字是你选的答案；点题号回到该题，已答过的题可随时回看答案与解析'}</div>
      </div>
      <button class="btn ghost big" onclick="App.navigate('#/quiz')">‹ 返回继续${recite ? '背题' : '答题'}</button>
      <button class="btn primary big" id="sheet-submit-btn">✓ 提交题库（结束本次${inExam ? '考试并交卷' : '练习'}）</button>
      <div class="muted small" style="text-align:center;margin-top:8px">提交后立即出成绩单与逐题解析；未答的题${inExam ? '按错计' : '不计入统计'}</div>`;

    document.querySelectorAll('#view .sheet-cell').forEach(b => {
      b.onclick = () => {
        session.jump(+b.dataset.i);
        saveProgress();
        navigate('#/quiz');
      };
    });
    document.getElementById('sheet-submit-btn').onclick = () => submitSession();
  }

  /* ================= 页面：结果（练习 / 考试成绩单） ================= */

  // 逐题解析面板：筛选（全部/答错/未答/答对）+ 上下一题 + 题号速览跳题。
  // 考试 / 学习模式共用；opts.showAll 控制「答对」一档是否给「答对」标签 vs 只是绿色
  function renderReviewPanel(rows, opts = {}) {
    const { defaultFilter, showAll = false } = opts;
    const nOk = rows.filter(x => x.status === 'ok').length;
    const nBad = rows.filter(x => x.status === 'bad').length;
    const nNone = rows.filter(x => x.status === 'none').length;
    let revFilter = defaultFilter || ((nBad + nNone) ? 'bad' : 'all');
    let revIdx = 0;
    const revRows = () => revFilter === 'all' ? rows
      : revFilter === 'bad' ? rows.filter(x => x.status === 'bad')
      : revFilter === 'none' ? rows.filter(x => x.status === 'none')
      : rows.filter(x => x.status === 'ok');

    function reviewCard(x) {
      const { q, ua, status, no } = x;
      const badge = status === 'ok'
        ? (showAll ? '<span class="rev-status ok">答对</span>' : '<span class="rev-status ok">✓</span>')
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

  /** 由 session 生成「逐题解析」的行数据（每题带 你的答案/对错） */
  function reviewRows(session) {
    return session.list.map((q, i) => {
      const a = session.answered.get(q.id);
      const ua = a ? a.userAnswer : (session.examAnswers.get(q.id) || null);
      const status = !a ? 'none' : (a.correct ? 'ok' : 'bad');
      return { q, a, ua, status, no: i + 1 };
    });
  }

  /** 逐题解析卡片外壳（结果页 / 记录详情页共用；renderReviewPanel 负责绑定交互） */
  function reviewCardShell(r) {
    return `
      <div class="card">
        <div class="card-title">逐题解析</div>
        <div class="chips" id="rev-filter">
          <button class="chip" data-v="all">全部 ${r.total}</button>
          <button class="chip" data-v="bad">答错 ${r.wrong}</button>
          <button class="chip" data-v="none">未答 ${r.unanswered}</button>
          <button class="chip" data-v="ok">答对 ${r.correct}</button>
        </div>
        <div class="rev-nav">
          <button class="btn ghost" id="rev-prev">‹ 上一题</button>
          <span class="rev-pos" id="rev-pos"></span>
          <button class="btn ghost" id="rev-next">下一题 ›</button>
        </div>
        <div id="rev-body"></div>
        <button class="btn ghost" id="rev-jump-btn" style="margin-top:10px">▦ 题号速览（点号码跳题）</button>
        <div id="rev-jump" style="display:none"></div>
      </div>`;
  }

  function pageQuizResult() {
    if (!session) return navigate('#/home');
    if (session.exam && !session.graded) session.grade();   // 兜底：未交卷进来先判分
    const exam = session.exam;
    const r = session.result();
    recordSession(session);   // 记入「练习记录」（内部防重复，只记一次）
    topbar(exam ? '考试成绩' : '练习结果', '#/home');

    // 两种模式共用的「逐题解析」卡片模板；renderReviewPanel() 负责绑定交互
    const reviewCardHTML = reviewCardShell(r);

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
            <div class="result-cell"><b style="color:var(--ok)">${p.correct}</b><span>答对</span></div>
            <div class="result-cell"><b style="color:var(--bad)">${p.wrong}</b><span>答错</span></div>
          </div>
        </div>
        ${reviewCardHTML}
        ${p.wrong ? `<button class="btn primary big" onclick="App.examWrongRedo()">重做错题（${p.wrong}）</button>` : ''}
        <button class="btn primary big" onclick="App.replay()">再来一轮（错题优先）</button>
        <button class="btn ghost big" onclick="App.finishQuiz()">返回题库</button>`;
      renderReviewPanel(reviewRows(session), { showAll: true });
      return;
    }

    // ---- 考试：成绩单 + 逐题解析 ----
    const wrongs = session.wrongList();
    const mm = Math.floor(r.timeUsed / 60), ss = r.timeUsed % 60;
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
      ${reviewCardHTML}
      ${wrongs.length
        ? `<button class="btn primary big" onclick="App.examWrongRedo()">重做错题（${wrongs.length}）</button>`
        : `<div class="card"><div class="card-title">全部答对 🎉</div><div class="muted small">这套题没有错题，继续保持。</div></div>`}
      <button class="btn ghost big" onclick="App.replay()">再来一轮</button>
      <button class="btn ghost big" onclick="App.finishQuiz()">返回题库</button>`;
    renderReviewPanel(reviewRows(session), { showAll: true });
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
    if (!await guardUnfinishedSession()) return;
    session = new QuizSession(list, { shuffle: true });
    navigate('#/quiz');
  }

  /* ================= 页面：错题本 / 收藏夹（同一入口页的两种视图） ================= */
  const REVIEW_NAV = `
    <div class="seg" style="margin-bottom:12px">
      <button data-nav="#/wrong">错题本</button>
      <button data-nav="#/star">★ 收藏夹</button>
    </div>`;
  function bindNavSeg(activeHash) {
    document.querySelectorAll('#view [data-nav]').forEach(b => {
      b.classList.toggle('on', b.dataset.nav === activeHash);
      b.onclick = () => navigate(b.dataset.nav);
    });
  }

  /* ---- 错题/收藏列表：按题库分组，默认折叠，点库头展开/收起（v1.8.12） ---- */
  function reviewGrouped(qs, bankName, starred) {
    const order = new Map([...bankName.keys()].map((id, i) => [id, i]));
    const arr = qs.slice().sort((a, b) => (order.has(a.bankId) ? order.get(a.bankId) : 1e9) - (order.has(b.bankId) ? order.get(b.bankId) : 1e9));
    const groups = [];
    for (const q of arr) {
      let g = groups[groups.length - 1];
      if (!g || g.id !== q.bankId) { g = { id: q.bankId, items: [] }; groups.push(g); }
      g.items.push(q);
    }
    return groups.map(g => `
      <div class="rev-group">
        <button class="rev-group-head" data-rev-fold="${g.id}" style="display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;padding:12px 4px;cursor:pointer;text-align:left">
          <span class="rev-arrow" style="color:var(--muted,#888);font-size:12px;flex:0 0 auto">▸</span>
          <span class="muted small" style="font-weight:600">📁 ${escapeHtml(bankName.get(g.id) || '未知题库')} · ${g.items.length} 题</span>
        </button>
        <div id="rev-body-${g.id}" style="display:none">
          ${g.items.map(q => `
            <div class="card wrong-card">
              <div class="wrong-head" style="display:flex;align-items:center;gap:8px">
                <span class="q-type ${q.type}">${typeLabel[q.type]}</span>
                ${starred ? `<button class="star-btn on" data-unstar="${q.id}" title="取消收藏" style="margin-left:auto;font-size:18px">★</button>` : ''}
              </div>
              <div class="stem sm">${renderStem(q)}</div>
              ${q.answer
                ? `<div class="wrong-ans">答案：${escapeHtml(q.answer.replace(/\|\|\|/g, ' ／ '))}</div>`
                : `<div class="muted small" style="margin-top:8px">（本题缺答案）</div>`}
              ${q.explanation ? `<div class="judge-exp sm">解析：${escapeHtml(q.explanation)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>`).join('');
  }

  /* 分组折叠绑定：点库头切换展开/收起 */
  function bindReviewFolds() {
    $view().querySelectorAll('[data-rev-fold]').forEach(btn => {
      btn.onclick = () => {
        const body = document.getElementById('rev-body-' + btn.dataset.revFold);
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        const arrow = btn.querySelector('.rev-arrow');
        if (arrow) arrow.textContent = open ? '▸' : '▾';
      };
    });
  }

  async function pageWrong() {
    topbar('错题本');
    const qs = await DB.wrongQuestions();
    const bankName = new Map((await DB.bankList()).map(b => [b.id, b.name]));
    $view().innerHTML = REVIEW_NAV + (qs.length ? `
      <button class="btn primary big" onclick="App.navigate('#/wrong-setup')">重做错题（${qs.length} · 按题库选）</button>
      <div class="wrong-list">
        ${reviewGrouped(qs, bankName, false)}
      </div>`
      : `<div class="empty" style="padding-top:40px">没有错题<br>继续保持！</div>`);
    bindNavSeg('#/wrong');
    bindReviewFolds();
  }

  /* ---- 收藏夹：跨题库集中看收藏题、取消收藏、一键收藏练习 ---- */
  async function pageStar() {
    topbar('收藏夹');
    const qs = await DB.starQuestions();
    const bankName = new Map((await DB.bankList()).map(b => [b.id, b.name]));
    const ready = qs.filter(q => q.answer).length;
    $view().innerHTML = REVIEW_NAV + (qs.length ? `
      ${ready
        ? `<button class="btn primary big" onclick="App.navigate('#/star-setup')">收藏练习（${ready} · 按题库选）</button>`
        : `<div class="muted small" style="margin-bottom:12px">收藏的题都缺答案，先在题库里补答案才能练习</div>`}
      <div class="wrong-list">
        ${reviewGrouped(qs, bankName, true)}
      </div>`
      : `<div class="empty" style="padding-top:40px">还没有收藏的题<br><span class="muted small">刷题时点右上角 ☆ 收藏</span></div>`);
    bindNavSeg('#/star');
    bindReviewFolds();
    $view().querySelectorAll('[data-unstar]').forEach(btn => {
      btn.onclick = async () => {
        await DB.starToggle(btn.dataset.unstar);
        toast('已取消收藏');
        render();   // 重渲染：题目从列表移除
      };
    });
  }

  /* ================= 页面：全局搜题 ================= */
  let searchPool = [];   // 当前搜索结果里「有答案、可练习」的题

  async function pageSearch() {
    topbar('搜题', '#/home');
    const banks = await DB.bankList();
    const bankName = new Map(banks.map(b => [b.id, b.name]));
    const secTitle = new Map();
    for (const b of banks) for (const s of (b.sections || [])) secTitle.set(b.id + ':' + String(s.secIdx), s.title);
    const all = [];
    for (const b of banks) for (const q of await DB.questionsByBank(b.id)) all.push(q);
    const starIds = new Set(await DB.starIds());
    if (!all.length) {
      $view().innerHTML = `<div class="empty" style="padding-top:40px">题库是空的<br><span class="muted small">先导入题库再来搜题</span></div>`;
      return;
    }
    const LIMIT = 60;
    let kw = '', onlyAns = false;

    $view().innerHTML = `
      <div class="card">
        <div class="list-tools">
          <input id="qs-search" class="search-input" placeholder="搜题干 / 选项 / 答案…" value="">
          <div class="chips" id="qs-filter">
            <button class="chip on" data-v="all">全部</button>
            <button class="chip" data-v="answered">只看有答案</button>
          </div>
        </div>
        <div class="muted small" id="qs-sum"></div>
      </div>
      <div id="qs-actions"></div>
      <div id="qs-results"></div>`;

    const match = () => {
      const k = kw.trim().toLowerCase();
      let arr = onlyAns ? all.filter(q => q.answer) : all;
      if (k) arr = arr.filter(q =>
        String(q.stem || '').toLowerCase().includes(k)
        || (q.options && Object.values(q.options).some(v => String(v).toLowerCase().includes(k)))
        || (q.answer && String(q.answer).toLowerCase().includes(k)));
      return arr;
    };

    function renderResults() {
      const arr = match();
      searchPool = arr.filter(q => q.answer);
      document.getElementById('qs-sum').textContent = kw.trim()
        ? `找到 ${arr.length} 题${arr.length > LIMIT ? `（显示前 ${LIMIT} 题）` : ''}`
        : `全部题库共 ${all.length} 题 · 输入关键词缩小范围`;
      document.getElementById('qs-actions').innerHTML = searchPool.length
        ? `<button class="btn primary big" onclick="App.startSearchPractice()">练习这些题（${searchPool.length}）</button>` : '';
      const resEl = document.getElementById('qs-results');
      if (!arr.length) { resEl.innerHTML = kw.trim() ? '<div class="empty" style="padding:24px 0">没有匹配的题目</div>' : ''; return; }
      resEl.innerHTML = arr.slice(0, LIMIT).map(q => {
        const sec = secTitle.get(q.bankId + ':' + String(q.secIdx ?? ''));
        return `<div class="card wrong-card">
          <div class="wrong-head" style="display:flex;align-items:center;gap:8px">
            <span class="q-type ${q.type}">${typeLabel[q.type]}</span>
            <span class="muted small" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(bankName.get(q.bankId) || '')}${sec ? ' · ' + escapeHtml(sec) : ''}</span>
            <button class="star-btn ${starIds.has(q.id) ? 'on' : ''}" data-star="${q.id}" title="收藏" style="margin-left:auto;font-size:18px">${starIds.has(q.id) ? '★' : '☆'}</button>
          </div>
          <div class="stem sm">${renderStem(q)}</div>
          ${q.answer ? `<div class="wrong-ans">答案：${escapeHtml(q.answer.replace(/\|\|\|/g, ' ／ '))}</div>` : '<div class="muted small" style="margin-top:8px">（本题缺答案）</div>'}
          ${q.explanation ? `<div class="judge-exp sm">解析：${escapeHtml(q.explanation)}</div>` : ''}
        </div>`;
      }).join('');
      resEl.querySelectorAll('[data-star]').forEach(btn => {
        btn.onclick = async () => {
          const added = await DB.starToggle(btn.dataset.star);
          if (added) starIds.add(btn.dataset.star); else starIds.delete(btn.dataset.star);
          btn.textContent = added ? '★' : '☆';
          btn.classList.toggle('on', added);
          toast(added ? '已收藏' : '已取消收藏');
        };
      });
    }

    let t = null;
    document.getElementById('qs-search').oninput = (e) => {
      kw = e.target.value;
      clearTimeout(t);
      t = setTimeout(renderResults, 150);
    };
    document.getElementById('qs-filter').onclick = (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      document.getElementById('qs-filter').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onlyAns = b.dataset.v === 'answered';
      renderResults();
    };
    renderResults();
  }

  async function startSearchPractice() {
    if (!searchPool.length) return toast('没有可练的题');
    if (!await guardUnfinishedSession()) return;
    session = new QuizSession([...searchPool], { shuffle: true, mode: 'search' });
    navigate('#/quiz');
  }

  /* ================= 页面：练习记录（每次练习/考试存档 + 回看逐题解析） ================= */
  async function historyList() { return (await DB.metaGet('quizHistory')) || []; }
  async function historyPush(rec) {
    const arr = await historyList();
    arr.unshift(rec);
    if (arr.length > 200) arr.length = 200;
    await DB.metaSet('quizHistory', arr);
  }
  async function historyClear() {
    if (!confirmDialog('清空全部练习记录？（不影响题库、错题本与收藏）')) return;
    await DB.metaSet('quizHistory', []);
    toast('已清空练习记录');
    render();
  }
  function fmtTime(at) {
    const d = new Date(at), p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 一轮练习/考试结束 → 存一条记录（session._recorded 防重复；背题模式不落记录） */
  async function recordSession(s) {
    if (!s || s._recorded || s.recite) return;
    // v1.8.7: 学习模式从答题卡页“提交题库”结束练习(_submitted)也要落记录
    const done = s.exam ? s.graded : (s.finished || s._submitted);
    if (!done) return;
    const r = s.result();
    if (!r.answered && !s.exam) return;   // 学习模式一题没答就不记
    const acc = s.exam ? r.acc : (r.answered ? Math.round(r.correct / r.answered * 100) : 0);
    const rows = reviewRows(s).map(x => ({ qid: x.q.id, ua: x.ua, status: x.status }));
    s._recorded = true;
    await historyPush({
      id: DB.uid(), at: Date.now(), exam: !!s.exam,
      label: s.exam ? '模拟考试' : (s.opts && s.opts.mode === 'wrong' ? '错题重做'
        : s.opts && s.opts.mode === 'star' ? '收藏练习'
        : s.opts && s.opts.mode === 'search' ? '搜索练习'
        : s.opts && s.opts.mode === 'daily' ? '每日一练'
        : s.opts && s.opts.mode === 'ability' ? '能力预测卷' : '练习'),
      total: r.total, answered: r.answered, correct: r.correct, wrong: r.wrong,
      unanswered: r.unanswered, acc, timeUsed: r.timeUsed, rows
    });
    // 每日一练：把今天的这一组标记为已完成（连续天数从练习记录推导，不再单独存）
    if (s._daily) {
      try {
        const map = (await DB.metaGet('dailyBanks')) || {};
        const cur = map[s._daily.bankId] || {};
        map[s._daily.bankId] = {
          ...cur,
          date: s._daily.date,
          done: true,
          correct: r.correct,
          total: s._daily.total || r.total,
          answered: r.answered,
          acc,
          at: Date.now()
        };
        await DB.metaSet('dailyBanks', map);
      } catch (e) {
        console.error('[daily] 标记完成失败', e);
      }
    }
  }

  async function pageHistory(params) {
    if (params && params[0]) return pageHistoryDetail(params[0]);
    topbar('练习记录');
    const list = await historyList();
    $view().innerHTML = list.length ? `
      <div class="muted small" style="margin-bottom:10px">共 ${list.length} 次练习 / 考试，点任意一条回看当次的逐题解析</div>
      <div class="hist-list">
        ${list.map(rec => {
          const mm = Math.floor(rec.timeUsed / 60), ss = rec.timeUsed % 60;
          return `<div class="card hist-item" data-hid="${rec.id}">
            <div class="hist-top">
              <span class="hist-mode ${rec.exam ? 'exam' : 'learn'}">${rec.label}</span>
              <span class="hist-acc" style="color:${rec.acc >= 60 ? 'var(--ok)' : 'var(--bad)'}">${rec.acc}${rec.exam ? '分' : '%'}</span>
            </div>
            <div class="muted small hist-meta">${fmtTime(rec.at)} · 答对 ${rec.correct}/${rec.total} 题 · 用时 ${mm}分${ss}秒</div>
          </div>`;
        }).join('')}
      </div>
      <button class="btn ghost" style="margin-top:12px" onclick="App.historyClear()">清空记录</button>`
      : `<div class="empty" style="padding-top:40px">还没有练习记录<br><span class="muted small">刷完一轮或交卷后会自动记下来</span></div>`;
    $view().querySelectorAll('[data-hid]').forEach(el => {
      el.onclick = () => navigate('#/history/' + el.dataset.hid);
    });
  }

  async function pageHistoryDetail(id) {
    const list = await historyList();
    const rec = list.find(x => x.id === id);
    if (!rec) return navigate('#/history');
    topbar('记录详情', '#/history');
    const rows = [];
    for (const row of (rec.rows || [])) {
      const q = await DB.questionGet(row.qid);
      if (q) rows.push({ q, ua: row.ua, status: row.status, no: rows.length + 1 });
    }
    const missing = rec.total - rows.length;
    $view().innerHTML = `
      <div class="result-hero">
        <div class="result-ring" style="--p:${rec.acc}">
          <div class="result-acc">${rec.acc}<small>${rec.exam ? '分' : '%'}</small></div>
        </div>
        <div class="result-row">
          <div class="result-cell"><b>${rec.total}</b><span>总题数</span></div>
          <div class="result-cell"><b style="color:var(--ok)">${rec.correct}</b><span>答对</span></div>
          <div class="result-cell"><b style="color:var(--bad)">${rec.wrong}</b><span>答错</span></div>
          <div class="result-cell"><b>${rec.unanswered}</b><span>未答</span></div>
        </div>
        <div class="muted small" style="margin-top:10px">${rec.label} · ${fmtTime(rec.at)} · 用时 ${Math.floor(rec.timeUsed / 60)} 分 ${rec.timeUsed % 60} 秒</div>
        ${missing > 0 ? `<div class="muted small" style="margin-top:4px">有 ${missing} 题的题目已被删除，未列入下方解析</div>` : ''}
      </div>
      ${rows.length ? reviewCardShell(rec) : '<div class="card"><div class="muted small">没有可回看的题目</div></div>'}`;
    if (rows.length) renderReviewPanel(rows, { showAll: true });
  }

  /* ================= 页面：统计 ================= */
  /* 能力估分卡片（统计页用）：有结果直接画，没结果先画「计算中」占位 */
  function abilityCardHtml(est, total) {
    const pred = (est && est.predicted) || {};
    const score = Number.isFinite(pred.score) ? Math.round(pred.score) : null;
    const weak = est
      ? (est.sections || []).filter(x => (x.n || 0) >= 2).sort((a, b) => (a.score || 0) - (b.score || 0))[0]
      : null;
    if (score == null) {
      if (!total) return `<button class="btn ghost big" onclick="App.navigate('#/ability')">📈 能力估分（先答几题）</button>`;
      return `<div class="card" onclick="App.navigate('#/ability')" style="cursor:pointer">
        <div class="card-title">能力估分 <span class="muted small" style="font-weight:400">正在计算…</span></div>
        <div class="audit-sum" style="margin:0">
          <div class="audit-stat"><b>…</b><span>预计卷面分</span></div>
          <div class="audit-stat"><b>…</b><span>及格概率</span></div>
          <div class="audit-stat"><b>…</b><span>最弱章节</span></div>
        </div>
      </div>`;
    }
    return `<div class="card" onclick="App.navigate('#/ability')" style="cursor:pointer">
      <div class="card-title">能力估分 <span class="muted small" style="font-weight:400">按题目难度推算 · 点开详情</span></div>
      <div class="audit-sum" style="margin:0">
        <div class="audit-stat"><b>${score}</b><span>预计卷面分</span></div>
        <div class="audit-stat"><b>${Math.round((pred.passRate || 0) * 100)}%</b><span>及格概率</span></div>
        <div class="audit-stat"><b>${weak ? Math.round(weak.score) : '—'}</b><span>${weak ? '最弱章节' : '暂无一章'}</span></div>
      </div>
    </div>`;
  }

  async function pageStats() {
    topbar('学习统计');
    /* 一次全表扫描拿到统计所需全部数据：原来 stats + wrongQuestions + latestByQuestion 扫了三遍 */
    const summary = await recordsSummary();
    const s = { total: summary.total, correct: summary.correct, byDay: summary.byDay };
    const days = Object.entries(s.byDay).sort().slice(-14);
    const max = Math.max(1, ...days.map(([, v]) => v.total));
    const acc = s.total ? Math.round(s.correct / s.total * 100) : 0;
    const wrongCount = summary.wrongCount;
    const hist = await historyList();
    const histCount = hist.length;

    /* ---- 章节正确率：题目 → 章节 → 最近一次作答（薄弱章节置顶） ---- */
    const banks = await DB.bankList();
    const qById = new Map();
    const allQ = [];
    for (const b of banks) {
      for (const q of await DB.questionsByBank(b.id)) { qById.set(q.id, q); allQ.push(q); }
    }
    const latest = summary.latest;
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

    /* 能力估分：命中缓存就立刻出卡；没缓存先画「计算中」，让页面先出来再算 */
    const cachedEst = (abilityCache && abilityCache.key === abilityKey(allQ, hist)) ? abilityCache.est : null;

    $view().innerHTML = `
      <div class="stats-row">
        <div class="stat-cell"><b>${s.total}</b><span>累计答题</span></div>
        <div class="stat-cell"><b>${acc}%</b><span>正确率</span></div>
        <div class="stat-cell"><b>${wrongCount}</b><span>当前错题</span></div>
      </div>
      <div id="ability-card">${abilityCardHtml(cachedEst, s.total)}</div>
      <button class="btn ghost big" onclick="App.navigate('#/history')">📋 练习记录${histCount ? `（${histCount}）` : ''}</button>
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
      </div>
      <div class="card">
        <div class="card-title">近 ${days.length} 日正确率</div>
        ${days.length ? `<div class="chart">
          ${days.map(([d, v]) => {
            const a = v.total ? Math.round(v.correct / v.total * 100) : 0;
            return `<div class="col" title="${d}：${a}%（${v.correct}/${v.total}）">
              <div class="col-track"><div class="col-bar" style="height:${v.total ? Math.max(a, 3) : 3}%;background:${v.total && a >= 60 ? 'var(--ok,#3ba776)' : 'var(--bad,#e05656)'}"></div></div>
              <span class="col-label"><span class="lb-full">${a}%</span><span class="lb-mini">${a}%</span></span></div>`;
          }).join('')}
        </div>
        <div class="muted small" style="margin-top:8px">绿 = 当日 ≥60%；红 = 低于 60%；没有答题的日期不显示柱</div>`
        : '<div class="muted">暂无答题记录</div>'}
      </div>`;

    /* 首帧之后再算估分（80~200ms 的大题库计算不挡页面渲染） */
    if (!cachedEst && s.total > 0) {
      setTimeout(async () => {
        const el = document.getElementById('ability-card');
        if (!el || !el.isConnected) return;
        try {
          const est = (await abilityCompute(allQ, hist)).est;
          const live = document.getElementById('ability-card');
          if (live) live.innerHTML = abilityCardHtml(est, s.total);
        } catch (e) {
          console.error('[ability] 统计页估分失败', e);
        }
      }, 0);
    }

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
    if (!await guardUnfinishedSession()) return;
    session = await QuizBuilder.fromBanks([bankId], { filterType: 'answered', secKeys: new Set([key]), shuffle: await prefShuffle() });
    if (!session.total) return toast('该章节没有带答案的题可练');
    navigate('#/quiz');
  }

  /* ================= 页面：设置 ================= */
  /* ---- 「我的」页（v1.7.2）：主流 App 的最后一栏——个人中心承载低频入口，
     设置从底部导航收进来，底部五栏回归纯功能页 ---- */
  async function pageMe() {
    topbar('我的');
    const banks = await DB.bankList();
    const qTotal = banks.reduce((n, b) => n + (b.count || 0), 0);
    $view().innerHTML = `
      <div class="card me-hero">
        <div class="me-avatar">刷</div>
        <div class="me-name">刷题宝</div>
        <div class="muted small">v${VERSION} · ${banks.length} 个题库 · ${qTotal} 道题</div>
      </div>
      <div class="card me-list">
        <button class="me-entry" onclick="App.navigate('#/settings')">
          <span class="me-ico" style="background:var(--primary)">⚙</span>
          <span class="me-label">设置</span>
          <span class="muted small">模型 / Key / 外观 / 计费</span>
          <span class="me-chev">›</span>
        </button>
        <button class="me-entry" onclick="App.navigate('#/recycle')">
          <span class="me-ico" style="background:#8a93a8">🗑</span>
          <span class="me-label">回收站</span>
          <span class="muted small">删掉的题库先放这里</span>
          <span class="me-chev">›</span>
        </button>
        <button class="me-entry" id="check-update">
          <span class="me-ico" style="background:#3d8f5f">⟳</span>
          <span class="me-label">检查更新</span>
          <span class="muted small">对比 GitHub 最新版</span>
          <span class="me-chev">›</span>
        </button>
      </div>
      <div class="muted small" style="text-align:center;margin-top:16px">本地题库 · 数据不出设备 · 定期「导出备份」更安心</div>`;

    /* 检查更新：拉 GitHub 最新 Release 对比版本号，有新版直接打开 APK 下载直链 */
    document.getElementById('check-update').onclick = async () => {
      toast('正在检查更新…');
      try {
        const r = await fetch('https://api.github.com/repos/Chad3486/shuati-bao/releases/latest');
        const d = await r.json();
        const latest = String(d.tag_name || '').replace(/^v/, '');
        if (!latest) throw new Error('no tag');
        if (latest === VERSION) return toast(`已是最新版本 v${VERSION}`);
        if (latest > VERSION) {
          const apk = (d.assets || []).find(a => /apk$/i.test(a.name));
          toast(`发现新版本 v${latest}，正在打开下载…`);
          window.open(apk ? apk.browser_download_url : d.html_url, '_blank');
        } else {
          toast(`当前 v${VERSION} 比线上 v${latest} 还新`);
        }
      } catch (e) {
        toast('检查失败（无网络？），去浏览器打开 GitHub Releases');
        window.open('https://github.com/Chad3486/shuati-bao/releases', '_blank');
      }
    };
  }

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
        <div class="card-title">AI 接口（「文件 → AI 转范式」/「AI 智能对位」使用）</div>
        <label class="field"><span>Base URL</span>
          <input id="set-url" value="${escapeHtml(cfg.baseUrl)}" placeholder="https://api.deepseek.com/v1">
        </label>
        <label class="field"><span>API Key</span>
          <input id="set-key" type="password" value="${escapeHtml(cfg.apiKey)}" placeholder="sk-...">
        </label>
        <div class="muted small">⚠ Key 明文保存在本机浏览器（IndexedDB），不上传服务器；请勿在共用设备上保存，泄露需到服务商处作废重换</div>
        <label class="field"><span>模型（填好上方接口地址和 Key 后，点「获取列表」自动拉取，不用手填）</span>
          <div style="display:flex;gap:8px">
            <select id="set-model-sel" style="flex:1">
              <option value="${escapeHtml(cfg.model)}" selected>${escapeHtml(cfg.model || '（未设置）')}</option>
              <option value="__custom">自定义（手填模型名）</option>
            </select>
            <button class="btn ghost" id="fetch-models" type="button" style="flex:0 0 auto;white-space:nowrap">↻ 获取列表</button>
          </div>
        </label>
        <label class="field" id="set-model-custom-wrap" style="display:none"><span>自定义模型名</span>
          <input id="set-model" placeholder="任意 OpenAI 兼容模型名">
        </label>
        <label class="field"><span>视觉模型（图片识别用，留空 = 跟随主模型）</span>
          <input id="set-vmodel" value="${escapeHtml(cfg.visionModel || '')}" placeholder="如 glm-4v / qwen-vl-plus / gpt-4o-mini，需支持图片输入">
        </label>
        <div class="muted small">图片识别（导入图片 / 图片型 Word）走「视觉模型」：默认跟随主模型；若主模型不支持图片（如 deepseek-chat），请单独填写支持图片的模型名</div>
        <label class="field"><span>解析并发数（1-8，越大越快，过高可能被限流）</span>
          <input id="set-conc" type="number" min="1" max="8" value="${cfg.concurrency || 4}">
        </label>
        <label class="field"><span>单次输出上限（tok，答长题/长解析可调大，受模型上限约束）</span>
          <input id="set-mtok" type="number" min="256" step="256" value="${cfg.maxTokens != null ? cfg.maxTokens : 8192}">
        </label>
        <label class="field"><span>单次费用上限（¥，0 = 不限，实耗达到即自动暂停）</span>
          <input id="set-cap" type="number" min="0" step="0.1" value="${cfg.capYuan != null ? cfg.capYuan : 0}">
        </label>
        <div class="muted small">费用预估沿用已保存的单价（参考价）；上方列表来自接口 /models，选不到的模型选「自定义」手填</div>
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


    /* 模型下拉：点「获取列表」按接口地址 + Key 拉取 /models，真实模型自动填充；拉不到可手填 */
    const curPrice = { priceIn: cfg.priceIn != null ? cfg.priceIn : 2, priceOut: cfg.priceOut != null ? cfg.priceOut : 8 };
    const selModel = document.getElementById('set-model-sel');
    selModel.onchange = () => {
      document.getElementById('set-model-custom-wrap').style.display = selModel.value === '__custom' ? '' : 'none';
    };
    document.getElementById('fetch-models').onclick = async () => {
      const base = document.getElementById('set-url').value.trim().replace(/\/+$/, '');
      const key = document.getElementById('set-key').value.trim();
      if (!base) return toast('先填接口地址再拉取');
      const btn = document.getElementById('fetch-models');
      btn.textContent = '拉取中…'; btn.disabled = true;
      try {
        const headers = key ? { Authorization: 'Bearer ' + key } : {};
        let resp = await fetch(base + '/models', { headers });
        if (resp.status === 404) resp = await fetch(base + '/v1/models', { headers }); // 地址没带 /v1 时兜底
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const ids = (data.data || data.models || []).map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean).sort();
        if (!ids.length) throw new Error('接口返回空列表');
        const cur = selModel.value === '__custom' ? (document.getElementById('set-model').value.trim() || cfg.model) : selModel.value;
        selModel.innerHTML = ids.map(id => `<option value="${escapeHtml(id)}" ${id === cur ? 'selected' : ''}>${escapeHtml(id)}</option>`).join('')
          + `<option value="__custom" ${ids.includes(cur) ? '' : 'selected'}>自定义（手填模型名）</option>`;
        document.getElementById('set-model-custom-wrap').style.display = ids.includes(cur) ? 'none' : '';
        if (!ids.includes(cur)) document.getElementById('set-model').value = cur || '';
        toast(`✓ 拉到 ${ids.length} 个模型，直接选一个保存即可`);
      } catch (e) {
        toast('拉取失败：' + e.message + '（检查地址/Key，或选「自定义」手填）', 4000);
      } finally {
        btn.textContent = '↻ 获取列表'; btn.disabled = false;
      }
    };

    const readCfgForm = () => ({
      baseUrl: document.getElementById('set-url').value.trim(),
      apiKey: document.getElementById('set-key').value.trim(),
      model: selModel.value === '__custom'
        ? (document.getElementById('set-model').value.trim() || 'deepseek-chat')
        : selModel.value,
      visionModel: (document.getElementById('set-vmodel')?.value || '').trim(),
      concurrency: Math.max(1, Math.min(8, parseInt(document.getElementById('set-conc').value, 10) || 4)),
      maxTokens: Math.max(256, parseInt(document.getElementById('set-mtok').value, 10) || 8192),
      priceIn: curPrice.priceIn,
      priceOut: curPrice.priceOut,
      capYuan: Math.max(0, parseFloat(document.getElementById('set-cap').value) || 0)
    });
    document.getElementById('save-btn').onclick = async () => {
      await LLM.saveConfig(readCfgForm());
      toast('已保存');
    };
    document.getElementById('test-btn').onclick = async () => {
      const r = document.getElementById('test-result');
      r.textContent = '测试中…';
      // 先临时保存再测试
      await LLM.saveConfig(readCfgForm());
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
    await DB.metaSet('quizHistory', []);
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

  /* ================= 题库体检（Audit）/ 能力估分（Ability）/ 每日一练（Daily） ================= */
  const QTYPE_NAME = { single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题' };
  const AUDIT_LEVEL_NAME = { error: '错误', warn: '警告', info: '提示' };
  const AUDIT_GROUP_TITLE = {
    'ans-out-of-range': '答案不在选项里',
    'dup-option-text': '选项文本重复',
    'missing-option-key': '选项字母跳号',
    'single-multi-mismatch': '题型与答案数量不符',
    'answer-explanation-conflict': '解析与答案矛盾',
    'judge-shape': '判断题格式异常',
    'stem-truncated': '题干疑似被截断',
    'empty-explanation': '缺解析',
    'duplicate-question': '疑似重复题'
  };

  async function allBanksQuestions() {
    const banks = await DB.bankList();
    const questions = [];
    for (const b of banks) questions.push(...await DB.questionsByBank(b.id));
    return { banks, questions };
  }

  function todayKey() {
    return (typeof Daily !== 'undefined' && Daily.dateKey)
      ? Daily.dateKey(Date.now())
      : new Date().toISOString().slice(0, 10);
  }

  /* ---------- 页面：题库体检 ---------- */
  async function pageAudit(params) {
    const bankId = params && params[0];
    const bank = bankId ? await DB.bankGet(bankId) : null;
    if (bankId && !bank) return navigate('#/home');
    topbar(bank ? '体检 · ' + String(bank.name).slice(0, 8) : '题库体检', bankId ? '#/bank/' + bankId : '#/home');

    const qs = bankId ? await DB.questionsByBank(bankId) : (await allBanksQuestions()).questions;
    if (!qs.length) {
      $view().innerHTML = '<div class="empty" style="padding:40px 0">这里还没有题目，先导入题库再体检</div>';
      return;
    }
    const res = Audit.bank(qs) || { summary: {}, issues: [] };
    const byId = new Map(qs.map(q => [q.id, q]));
    const sum = res.summary || {};
    const nErr = Number(sum.error) || 0, nWarn = Number(sum.warn) || 0, nInfo = Number(sum.info) || 0;
    const issues = Array.isArray(res.issues) ? res.issues : [];
    let filter = nErr ? 'error' : 'all';

    $view().innerHTML = `
      <div class="audit-sum">
        <div class="audit-stat error"><b>${nErr}</b><span>必须修</span></div>
        <div class="audit-stat warn"><b>${nWarn}</b><span>建议看</span></div>
        <div class="audit-stat info"><b>${nInfo}</b><span>可忽略</span></div>
      </div>
      <div class="muted small" style="margin:2px 0 4px">
        体检只判断机器能确定的问题：答案与选项/题型对不上、选项重复、题干重复、解析与答案矛盾。
        「解析写得对不对」这类语义问题不判。点任意一条可直接改题。
      </div>
      <div class="chips" id="audit-filter">
        <button class="chip" data-v="all">全部 ${issues.length}</button>
        <button class="chip" data-v="error">错误 ${nErr}</button>
        <button class="chip" data-v="warn">警告 ${nWarn}</button>
        <button class="chip" data-v="info">提示 ${nInfo}</button>
      </div>
      <div id="audit-list"></div>
      <button class="btn ghost big" id="audit-export" style="margin-top:14px">导出体检报告（.md）</button>`;

    const listEl = document.getElementById('audit-list');
    const filterEl = document.getElementById('audit-filter');
    const chips = [...filterEl.querySelectorAll('button[data-v]')];
    const syncChips = () => chips.forEach(b => b.classList.toggle('on', b.dataset.v === filter));

    const draw = () => {
      syncChips();
      const cur = issues.filter(it => filter === 'all' || it.level === filter);
      if (!cur.length) {
        listEl.innerHTML = `<div class="empty" style="padding:30px 0">${filter === 'all' ? '✓ 没查出问题' : '这一档没有条目'}</div>`;
        return;
      }
      const stemOf = qid => {
        const q = byId.get(qid);
        const t = q ? String(q.stem || '').replace(/\s+/g, ' ') : '';
        return t.length > 42 ? t.slice(0, 42) + '…' : t;
      };
      const groups = new Map();
      for (const it of cur) {
        if (!groups.has(it.code)) groups.set(it.code, []);
        groups.get(it.code).push(it);
      }
      listEl.innerHTML = [...groups].map(([code, list]) => `
        <div class="audit-group">
          <div class="audit-group-title">${escapeHtml(AUDIT_GROUP_TITLE[code] || code)}<span class="muted small">${list.length} 条</span></div>
          ${list.slice(0, 60).map(it => `
            <div class="audit-item" data-qid="${escapeHtml(String(it.qid || ''))}">
              <span class="audit-badge ${it.level}">${AUDIT_LEVEL_NAME[it.level] || it.level}</span>
              <div class="audit-body">
                ${stemOf(it.qid) ? `<div class="audit-stem">${escapeHtml(stemOf(it.qid))}</div>` : ''}
                <div class="audit-msg">${escapeHtml(String(it.message || ''))}</div>
                ${it.hint ? `<div class="audit-hint">${escapeHtml(String(it.hint))}</div>` : ''}
              </div>
              <span class="audit-no">${it.no != null ? '第 ' + escapeHtml(String(it.no)) + ' 题' : ''}</span>
            </div>`).join('')}
          ${list.length > 60 ? `<div class="muted small" style="padding:8px 0">还有 ${list.length - 60} 条（导出报告看全部）</div>` : ''}
        </div>`).join('');
      listEl.querySelectorAll('[data-qid]').forEach(el => {
        el.onclick = () => {
          if (!el.dataset.qid) return;
          openQuestionEditor(el.dataset.qid, () => render());
        };
      });
    };

    filterEl.onclick = e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      filter = b.dataset.v;
      draw();
    };
    document.getElementById('audit-export').onclick = async () => {
      try {
        const md = Audit.report(issues, {
          bankName: bank ? bank.name : '全部题库',
          date: new Date().toLocaleString(),
          total: qs.length
        });
        const safe = String(bank ? bank.name : '全部题库').replace(/[\\/:*?"<>|]/g, '_').slice(0, 20);
        const r = await saveTextFile(`体检报告-${safe}-${todayKey()}.md`, md, 'text/markdown');
        toast('已导出：' + r.path);
      } catch (e) {
        toast('导出失败：' + String(e.message || e).slice(0, 60));
      }
    };
    draw();
  }

  /* 入口：从题库页点「体检」进来 */
  function openAudit(bankId) {
    navigate(bankId ? '#/audit/' + bankId : '#/audit');
  }

  /* 入口：从题库页点「今日一练」直接开这个库的一组 */
  function dailyBank(bankId) {
    startDaily(bankId, false);
  }

  /* ---------- 能力估分 ---------- */
  /* 一次读全部作答记录，同时算出统计页要的所有东西（总数/正确/按日/每题最近一次/错题数）。
     原来是 DB.stats + DB.wrongQuestions + DB.latestByQuestion 三次全表扫描，记录一多就是三倍开销。 */
  async function recordsSummary() {
    const recs = await DB.recordsAll();
    const byDay = {};
    const latest = {};
    let correct = 0;
    for (const r of recs) {
      const t = r.time || 0;
      const day = new Date(t).toISOString().slice(0, 10);
      const cell = byDay[day] || (byDay[day] = { total: 0, correct: 0 });
      cell.total++;
      if (r.correct) { correct++; cell.correct++; }
      const p = latest[r.questionId];
      if (!p || t > p.time) latest[r.questionId] = { correct: !!r.correct, time: t };
    }
    let wrongCount = 0;
    for (const qid in latest) if (!latest[qid].correct) wrongCount++;
    return { total: recs.length, correct, wrong: recs.length - correct, byDay, latest, wrongCount };
  }

  /* 估分缓存：同样的题目/作答不变就复用，避免每次进统计页都重算（3000 题约 80~200ms） */
  let abilityCache = null;
  function abilityKey(questions, hist) {
    let nRows = 0;
    for (const h of hist) nRows += (h.rows || []).length;
    return [questions.length, nRows, hist.length, hist[0] ? hist[0].at : 0].join('|');
  }

  async function abilityCompute(questionsArg, histArg) {
    const banks = questionsArg ? null : (await DB.bankList());
    const questions = questionsArg || (await allBanksQuestions()).questions;
    const hist = histArg || await historyList();
    const key = abilityKey(questions, hist);
    if (abilityCache && abilityCache.key === key) return { est: abilityCache.est, questions, banks };
    const rows = [];
    for (let i = hist.length - 1; i >= 0; i--) {
      for (const row of (hist[i].rows || [])) {
        if (row && row.qid) rows.push({ qid: row.qid, status: row.status });
      }
    }
    const byId = new Map(questions.map(q => [q.id, q]));
    let examShape = null;
    const lastExam = hist.find(r => r.exam && (r.rows || []).length);
    if (lastExam) {
      examShape = {};
      for (const row of lastExam.rows) {
        const q = byId.get(row.qid);
        if (q) examShape[q.type] = (examShape[q.type] || 0) + 1;
      }
    }
    const sectionTitle = new Map();
    const banksForSections = banks || (await DB.bankList());
    for (const b of banksForSections) {
      for (const s of (b.sections || [])) sectionTitle.set(b.id + ':' + String(s.secIdx), s.title);
    }
    let est;
    try {
      est = Ability.estimate({ questions, rows, examShape, opts: { sectionTitle } });
    } catch (e) {
      console.error('[ability]', e);
      est = { insufficient: true, n: rows.length, predicted: {}, sections: [], items: {} };
    }
    abilityCache = { key, est: est || {} };
    return { est: est || {}, questions, banks, rows, sectionTitle };
  }

  async function pageAbility() {
    topbar('能力估分', '#/stats');
    const { est, questions } = await abilityCompute();
    const pred = est.predicted || {};
    const score = Number.isFinite(pred.score) ? Math.round(pred.score) : null;
    const low = Number.isFinite(pred.low) ? Math.round(pred.low) : null;
    const high = Number.isFinite(pred.high) ? Math.round(pred.high) : null;
    const passRate = Number.isFinite(pred.passRate) ? Math.round(pred.passRate * 100) : null;
    const n = Number(est.n) || 0;
    const sections = (est.sections || []).filter(s => (s.n || 0) >= 2).slice().sort((a, b) => (a.score || 0) - (b.score || 0)).slice(0, 5);
    const canDrill = questions.length > 0;

    $view().innerHTML = `
      <div class="card">
        ${score != null ? `
        <div class="ability-hero">
          <div class="ability-score">${score}<small> / 100</small></div>
          <div class="ability-range">预计区间 ${low}–${high} · 基于 ${n} 次作答</div>
          ${passRate != null ? `<div class="ability-pass">及格（60 分）概率 <b style="color:${passRate >= 60 ? 'var(--ok)' : 'var(--bad)'}">${passRate}%</b></div>` : ''}
          <div class="ability-line"><i style="width:${Math.max(2, Math.min(100, score))}%"></i></div>
        </div>` : `
        <div class="empty" style="padding:20px 0">还在攒数据</div>`}
        <div class="muted small" style="margin-top:10px">
          ${n < 30
            ? `已作答 ${n} 题，再多练 ${30 - n} 题估分会更准（现在的结果波动较大）。`
            : '这个分数是根据你做过的题、按题目难度推算的「这套题库的卷面分」，不等于官方考试分。'}
        </div>
      </div>
      ${sections.length ? `
      <div class="card">
        <div class="card-title">最该补的章节</div>
        ${sections.map(s => `
          <div class="audit-item" style="cursor:default">
            <span class="audit-badge ${s.score >= 60 ? 'info' : 'error'}">${Math.round(s.score)}</span>
            <div class="audit-body"><div class="audit-msg">${escapeHtml(String(s.title || '未分节'))}</div>
            <div class="audit-hint">预计正确率 · 该章作答 ${s.n || 0} 次</div></div>
          </div>`).join('')}
      </div>` : ''}
      ${canDrill ? `<button class="btn primary big" id="ability-drill">按当前水平练 10 题</button>` : ''}`;

    const drill = document.getElementById('ability-drill');
    if (drill) drill.onclick = () => startAbilityDrill(questions);
  }

  async function startAbilityDrill(questions) {
    const ok = await guardUnfinishedSession();
    if (!ok) return;
    const shape = (typeof Ability !== 'undefined' && Ability.DEFAULT_SHAPE) || { single: 6, multi: 2, judge: 1, fill: 1 };
    const pool = questions.filter(q => q.answer);
    const picked = [];
    const used = new Set();
    for (const [type, want] of Object.entries(shape)) {
      let got = 0;
      for (const q of pool) {
        if (got >= want) break;
        if (q.type !== type || used.has(q.id)) continue;
        used.add(q.id); picked.push(q); got++;
      }
    }
    for (const q of pool) {
      if (picked.length >= 10) break;
      if (used.has(q.id)) continue;
      used.add(q.id); picked.push(q);
    }
    if (!picked.length) return toast('题库里还没有带答案的题');
    session = new QuizSession(picked, { shuffle: false, mode: 'ability' });
    navigate('#/quiz');
  }

  /* ---------- 每日一练（按题库：每个题库每天一组） ---------- */
  async function dailyBanksMap() {
    return (await DB.metaGet('dailyBanks')) || {};
  }

  function bdText(bd) {
    bd = bd || {};
    return [bd.wrong ? '错题 ' + bd.wrong : '', bd.fresh ? '新题 ' + bd.fresh : '', bd.review ? '复习 ' + bd.review : '']
      .filter(Boolean).join(' · ');
  }

  /** 单题库连续天数：练习记录里挑「每日一练」且含该库题目，按本地日期去重后往回数 */
  function bankStreak(history, qid2bank, bankId, todayKeyStr) {
    const days = new Set();
    for (const h of (history || [])) {
      if (!h || h.label !== '每日一练' || !h.at) continue;
      const hit = (h.rows || []).some(r => r && qid2bank.get(r.qid) === bankId);
      if (hit) days.add(Daily.dateKey(h.at));
    }
    const today = new Date(todayKeyStr + 'T00:00:00');
    const start = days.has(todayKeyStr) ? 0 : 1;   // 今天还没做：从昨天起算，不归零
    let count = 0;
    for (let i = start; i < 400; i++) {
      const k = Daily.dateKey(today.getTime() - i * 86400000);
      if (days.has(k)) count++; else break;
    }
    return { days: count, todayDone: days.has(todayKeyStr) };
  }

  /** 这个库今天的那一组：首次访问生成并落库，同一天不变，跨天重建 */
  async function planForBank(bankId, bankQuestions, latest, map) {
    const dateKey = todayKey();
    const saved = map[bankId];
    if (saved && saved.date === dateKey && Array.isArray(saved.qids) && saved.qids.length) {
      const ids = new Set(bankQuestions.map(q => q.id));
      if (saved.qids.every(id => ids.has(id))) return saved;
    }
    const mode = (await DB.metaGet('dailyMode')) || 'standard';
    let plan = null;
    try {
      plan = Daily.plan({ questions: bankQuestions, latest, dateKey, size: 8, mode, bankId });
    } catch (e) {
      console.error('[daily]', e);
      plan = { qids: [], breakdown: { wrong: 0, weak: 0, fresh: 0, review: 0 } };
    }
    const meta = {
      date: dateKey,
      qids: plan.qids || [],
      breakdown: plan.breakdown || { wrong: 0, weak: 0, fresh: 0, review: 0 },
      done: false,
      total: (plan.qids || []).length,
      at: Date.now()
    };
    map[bankId] = meta;
    await DB.metaSet('dailyBanks', map);
    return meta;
  }

  /** 每个题库今天的这一组 + 连续天数（未完成在前） */
  async function dailyOverview(banks, allQ, hist) {
    const map = await dailyBanksMap();
    const latest = await DB.latestByQuestion();
    const qid2bank = new Map(allQ.map(q => [q.id, q.bankId]));
    const out = [];
    for (const b of banks) {
      const qs = allQ.filter(q => q.bankId === b.id && q.answer);
      if (!qs.length) continue;
      const meta = await planForBank(b.id, qs, latest, map);
      let streak = { days: 0, todayDone: false };
      try { streak = bankStreak(hist || [], qid2bank, b.id, todayKey()); } catch (e) { console.error('[daily] streak', e); }
      out.push({ bank: b, meta, streak });
    }
    out.sort((a, b) => (a.meta.done ? 1 : 0) - (b.meta.done ? 1 : 0) || (b.bank.count || 0) - (a.bank.count || 0));
    return out;
  }

  async function pageDaily() {
    topbar('每日一练', '#/home');
    const { banks, questions } = await allBanksQuestions();
    if (!questions.length) {
      $view().innerHTML = `<div class="empty" style="padding:40px 0">还没有题库<br><span class="muted small">先导入一份题库，明天就有题可练</span></div>
        <button class="btn primary big" onclick="App.navigate('#/import')">去导入</button>`;
      return;
    }
    const hist = await historyList();
    const rows = await dailyOverview(banks, questions, hist);
    if (!rows.length) {
      $view().innerHTML = `<div class="empty" style="padding:40px 0">题库里还没有带答案的题<br><span class="muted small">补上答案就能生成每日一练</span></div>`;
      return;
    }
    const doneCount = rows.filter(r => r.meta.done).length;
    $view().innerHTML = `
      <div class="card" style="padding:12px 14px">
        <div style="display:flex;align-items:center;gap:8px">
          <b style="flex:1">今天已完成 ${doneCount} / ${rows.length} 个题库</b>
          <span class="muted small">每个库每天一组</span>
        </div>
        <div class="muted small" style="margin-top:4px">每组 8 题：错题 3 + 新题 4 + 复习 1（某类不够自动回填）。同一天题集固定，做一半退出再进还是这一组。</div>
      </div>
      ${rows.map(({ bank, meta, streak }) => `
      <div class="card">
        <div style="display:flex;align-items:center;gap:8px">
          <b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(bank.name)}</b>
          <span class="muted small">🔥 连续 ${streak.days || 0} 天</span>
        </div>
        <div class="muted small" style="margin-top:4px">${meta.done
          ? `今天已完成 · 答对 ${meta.correct ?? 0} / ${meta.total || 0} 题`
          : `今天 ${meta.total || 0} 题${bdText(meta.breakdown) ? ' · ' + bdText(meta.breakdown) : ''}`}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <div class="daily-bar" style="background:var(--surface-2)"><i style="width:${meta.done ? 100 : 0}%;background:var(--primary)"></i></div>
          <button class="btn primary" data-go="${bank.id}" data-again="${meta.done ? 1 : 0}">${meta.done ? '再来一组' : '开始'}</button>
        </div>
      </div>`).join('')}`;
    $view().querySelectorAll('button[data-go]').forEach(btn => {
      btn.onclick = () => startDaily(btn.dataset.go, btn.dataset.again === '1');
    });
  }

  async function startDaily(bankId, again) {
    const bank = await DB.bankGet(bankId);
    if (!bank) return toast('题库不存在');
    const { questions } = await allBanksQuestions();
    const qs = questions.filter(q => q.bankId === bankId && q.answer);
    if (!qs.length) return toast('这个题库还没有带答案的题');
    const latest = await DB.latestByQuestion();
    let meta;
    if (again) {
      let plan = null;
      try {
        plan = Daily.plan({ questions: qs, latest, dateKey: todayKey() + '-again-' + Date.now(), size: 8 });
      } catch (e) {
        console.error('[daily again]', e);
      }
      meta = { date: todayKey(), qids: (plan && plan.qids) || [], total: ((plan && plan.qids) || []).length, done: false, again: true };
    } else {
      const map = await dailyBanksMap();
      meta = await planForBank(bankId, qs, latest, map);
    }
    const byId = new Map(qs.map(q => [q.id, q]));
    const list = (meta.qids || []).map(id => byId.get(id)).filter(Boolean);
    if (!list.length) return toast('这一组题可能已被删除，重试一次');
    const ok = await guardUnfinishedSession();
    if (!ok) return;
    session = new QuizSession(list, { shuffle: false, mode: 'daily' });
    if (!again) session._daily = { bankId, date: meta.date, total: list.length };
    navigate('#/quiz');
  }

  /* ---------- 通用：题目编辑弹层（体检/估分页复用） ---------- */
  async function openQuestionEditor(qid, onSaved) {
    const q = await DB.questionGet(qid);
    if (!q) return toast('题目已经不存在了');
    const mask = document.createElement('div');
    mask.className = 'sheet-mask';
    const st = {
      type: q.type || 'single',
      stem: q.stem || '',
      sel: new Set(String(q.answer || '').toUpperCase().match(/[A-H]/g) || []),
      ansText: String(q.answer || '').replace(/\|\|\|/g, '/'),
      optsText: q.options && q.type !== 'judge'
        ? Object.entries(q.options).map(([k, v]) => k + '. ' + v).join('\n')
        : '',
      exp: q.explanation || ''
    };
    const parseOpts = text => {
      const out = {};
      let auto = 0;
      for (const line of String(text || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(/^([A-Ha-h])\s*[.、．:：)）]?\s*(.*)$/);
        if (m) out[m[1].toUpperCase()] = m[2].trim();
        else out[String.fromCharCode(65 + (auto++))] = t;
      }
      return out;
    };

    const readInputs = () => {
      const stemEl = mask.querySelector('#qe-stem');
      const a = mask.querySelector('#qe-ans');
      const o = mask.querySelector('#qe-opts');
      const e = mask.querySelector('#qe-exp');
      if (stemEl) st.stem = stemEl.value;
      if (a) st.ansText = a.value;
      if (o) st.optsText = o.value;
      if (e) st.exp = e.value;
    };

    const draw = () => {
      const isFill = st.type === 'fill';
      const isJudge = st.type === 'judge';
      const isChoice = st.type === 'single' || st.type === 'multi';
      const keys = isJudge ? ['A', 'B'] : (isChoice ? Object.keys(parseOpts(st.optsText)) : []);
      const types = [['single', '单选'], ['multi', '多选'], ['judge', '判断'], ['fill', '填空']];
      mask.innerHTML = `
        <div class="sheet-panel">
          <div class="sheet-head">
            <b>修改第 ${escapeHtml(String(q.no ?? '?'))} 题</b>
            <button class="sheet-close" id="qe-close">×</button>
          </div>
          <div class="field"><span>题干</span>
            <textarea id="qe-stem" rows="3" style="border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px;line-height:1.5;font-family:inherit;background:var(--card);color:var(--text);width:100%">${escapeHtml(st.stem)}</textarea>
          </div>
          <div class="field"><span>题型</span>
            <div class="seg" style="flex-wrap:wrap">
              ${types.map(([v, n]) => `<button data-t="${v}" class="${st.type === v ? 'on' : ''}" style="flex:0 0 auto;min-width:62px;padding:8px 12px">${n}</button>`).join('')}
            </div>
          </div>
          <div class="field"><span>答案${isFill ? '（多空用 / 分隔）' : ''}</span>
            ${isFill
              ? `<input type="text" id="qe-ans" value="${escapeHtml(st.ansText)}" placeholder="标准答案">`
              : `<div class="seg" id="qe-letters" style="flex-wrap:wrap">
                  ${keys.length
                    ? keys.map(k => `<button data-k="${k}" class="${st.sel.has(k) ? 'on' : ''}" style="flex:0 0 auto;min-width:50px;padding:8px 12px">${isJudge ? (k === 'A' ? '正确' : '错误') : k}</button>`).join('')
                    : '<span class="muted small">先填写选项</span>'}
                </div>`}
          </div>
          ${isChoice ? `
          <div class="field"><span>选项（每行一个，A. 文本）</span>
            <textarea id="qe-opts" rows="4" style="border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;background:var(--card);color:var(--text);width:100%">${escapeHtml(st.optsText)}</textarea>
          </div>` : ''}
          <div class="field"><span>解析（可空）</span>
            <textarea id="qe-exp" rows="3" style="border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;background:var(--card);color:var(--text);width:100%">${escapeHtml(st.exp)}</textarea>
          </div>
          <div class="btn-row">
            <button class="btn ghost" id="qe-cancel">取消</button>
            <button class="btn primary" id="qe-save">保存</button>
          </div>
        </div>`;

      mask.querySelector('#qe-close').onclick = () => mask.remove();
      mask.querySelector('#qe-cancel').onclick = () => mask.remove();
      mask.onclick = e => { if (e.target === mask) mask.remove(); };
      mask.querySelectorAll('button[data-t]').forEach(b => {
        b.onclick = () => {
          readInputs();
          const nt = b.dataset.t;
          if (nt === st.type) return;
          st.type = nt;
          if (nt === 'judge') st.sel = new Set([...st.sel].filter(k => k === 'A' || k === 'B'));
          if (nt === 'fill' && !st.ansText) st.ansText = '';
          draw();
        };
      });
      mask.querySelectorAll('button[data-k]').forEach(b => {
        b.onclick = () => {
          readInputs();          // 先收回已输入的题干/选项/解析，避免重绘把它们冲掉
          const k = b.dataset.k;
          if (st.type === 'single' || st.type === 'judge') st.sel = new Set([k]);
          else st.sel.has(k) ? st.sel.delete(k) : st.sel.add(k);
          draw();
        };
      });
      mask.querySelector('#qe-save').onclick = async () => {
        readInputs();
        const opts = st.type === 'judge' ? { A: '正确', B: '错误' }
          : (st.type === 'fill' ? null : parseOpts(st.optsText));
        let answer;
        if (st.type === 'fill') {
          answer = st.ansText.split('/').map(s => s.trim()).filter(Boolean).join('|||');
        } else {
          answer = [...st.sel].sort().join('');
        }
        if (st.type !== 'fill') {
          const ks = Object.keys(opts || {});
          if (!ks.length) return toast('请先填写选项');
          const bad = answer.split('').filter(k => !ks.includes(k));
          if (bad.length) return toast('答案 ' + bad.join('') + ' 不在选项里，请检查');
          if (st.type === 'single' && answer.length > 1) return toast('单选题只能有一个答案');
          if (st.type === 'multi' && !answer) return toast('多选题至少要选一个答案');
        }
        const stem = st.stem.trim();
        if (!stem) return toast('题干不能为空');
        await DB.questionPut({ ...q, stem, type: st.type, answer: answer || null, options: opts, explanation: st.exp.trim() || null });
        mask.remove();
        toast('已保存');
        if (onSaved) onSaved();
      };
    };

    draw();
    document.body.appendChild(mask);
  }

  return { init, navigate, startBank, delBank, renameBank, wrongRedo, starRedo, replay, finishQuiz, clearProgress, resumeLast, clearRecords, examWrongRedo, startSearchPractice, historyClear, openAudit, dailyBank, toast };
})();

document.addEventListener('DOMContentLoaded', App.init);

