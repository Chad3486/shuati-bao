/* ========== 主应用：hash 路由 + 页面渲染 ========== */
const App = (() => {
  let session = null; // 当前答题会话

  const $view = () => document.getElementById('view');
  const $topbar = () => document.getElementById('topbar');
  const $tabbar = () => document.getElementById('tabbar');

  /* ================= 路由 ================= */
  const routes = {
    '': pageHome, 'home': pageHome,
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

  /* ================= 页面：题库首页 ================= */
  async function pageHome() {
    topbar('我的题库');
    const banks = await DB.bankList();
    banks.sort((a, b) => b.createdAt - a.createdAt);
    const total = banks.reduce((s, b) => s + (b.count || 0), 0);
    const last = await DB.metaGet('lastSession');
    const recycle = await DB.recycleList();

    // 统计各库缺答案数
    const noAnsMap = {};
    await Promise.all(banks.map(async b => {
      const qs = await DB.questionsByBank(b.id);
      noAnsMap[b.id] = qs.filter(q => !q.answer).length;
    }));

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
      <button class="btn primary big" onclick="App.navigate('#/import')">＋ 导入文件（PDF / Word）</button>
      ${recycle.length ? `<button class="btn ghost big" onclick="App.navigate('#/recycle')">🗑 回收站（${recycle.length}）</button>` : ''}
      <div class="bank-list">
        ${banks.length === 0 ? `<div class="empty">还没有题库<br>点击上方按钮导入 PDF / Word 文件开始</div>` :
        banks.map(b => {
          const na = noAnsMap[b.id] || 0;
          return `
          <div class="bank-card">
            <div class="bank-main" onclick="App.startBank('${b.id}')">
              <div class="bank-name">${escapeHtml(b.name)}</div>
              <div class="bank-meta">${b.count || 0} 题 · ${new Date(b.createdAt).toLocaleDateString()}${na ? ` · <b style="color:var(--bad)">${na} 题缺答案</b>` : ''}</div>
            </div>
            ${b.count ? `<button class="bank-del" style="color:var(--primary)" onclick="App.navigate('#/bank/${b.id}')">选题</button>` : ''}
            ${b.count ? `<button class="bank-del" style="color:${na ? 'var(--bad)' : 'var(--primary)'}" onclick="App.navigate('#/answers/${b.id}')">${na ? '补答案' : '答案校验'}</button>` : ''}
            <button class="bank-del" onclick="App.renameBank('${b.id}')">改名</button>
            <button class="bank-del" onclick="App.delBank('${b.id}')">删除</button>
          </div>`;
        }).join('')}
      </div>`;
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

  /* ================= 页面：导入 ================= */
  function pageImport() {
    topbar('导入文件', '#/home');
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">第 1 步 · 选择文件</div>
        <p class="muted">支持多选 PDF、DOCX。文件中的题目和答案将被解析为结构化题库（选择题/填空题/判断题）。</p>
        <div class="card-title" style="margin-top:12px">录入模式</div>
        <div class="seg" id="seg-mode">
          <button data-v="smart" class="on">⚡ 智能（快·免费为主）</button>
          <button data-v="ai">🤖 纯AI（慢·最全）</button>
        </div>
        <p class="muted small" id="mode-desc">智能：本地秒级解析为主，疑难格式才用 AI。纯AI：AI 逐块扫描全文找题并与本地结果合并去重，漏题最少，但耗时和费用较高，数量仍不准时用。</p>
        <button class="btn primary big" style="margin-top:10px" id="pick-btn">选择文件</button>
        <input type="file" id="file-input" multiple accept=".pdf,.docx,.doc" style="display:none">
        <div id="file-list" class="file-list"></div>
      </div>
      <div class="card" id="parse-card" style="display:none">
        <div class="card-title">第 2 步 · 解析</div>
        <div class="muted" id="parse-status"></div>
        <div class="progress"><div class="progress-bar" id="parse-bar"></div></div>
        <div id="parse-result"></div>
      </div>`;

    const input = document.getElementById('file-input');
    let importMode = 'smart';
    const segMode = document.getElementById('seg-mode');
    segMode.onclick = (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      segMode.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      importMode = b.dataset.v;
    };
    document.getElementById('pick-btn').onclick = () => input.click();
    input.onchange = () => handleFiles([...input.files], importMode);

    // 断点续扫：有未完成的纯AI任务时提示继续（同一文件）
    DB.metaGet('aiScanTask').then(task => {
      if (!task || !task.bankId) return;
      const hint = document.createElement('div');
      hint.className = 'card';
      hint.style.borderLeft = '4px solid var(--primary)';
      hint.innerHTML = `
        <b>有未完成的 AI 扫描</b>
        <div class="muted small">${escapeHtml(task.file || '')} 已扫 ${task.doneChunks?.length || 0} 块（题库已实时保存 ${task.totalHint || 0} 题）</div>
        <div class="btn-row">
          <button class="btn primary" id="resume-scan">重新选此文件继续</button>
          <button class="btn ghost" id="drop-scan">放弃</button>
        </div>
        <div class="muted small" style="margin-top:6px">继续=重新选择同一文件，已扫过的块自动跳过（不重复计费）；放弃=清除任务（已扫的题保留在该题库）</div>`;
      const list = $view().querySelector('.file-list');
      list.parentNode.insertBefore(hint, list);
      hint.querySelector('#resume-scan').onclick = () => {
        toast('请选择同一个文件，将跳过已扫块');
        input.dataset.resumeTask = JSON.stringify(task);
        input.click();
      };
      hint.querySelector('#drop-scan').onclick = async () => {
        await DB.metaSet('aiScanTask', null);
        hint.remove();
        toast('已清除任务');
      };
    });

    // 恢复模式：选择的文件若与任务同名，则带上已扫块集合
    input.onchange = () => {
      let resumeTask = null;
      try { resumeTask = JSON.parse(input.dataset.resumeTask || 'null'); } catch (e) { /* 忽略 */ }
      if (resumeTask) {
        delete input.dataset.resumeTask;
        handleFiles([...input.files], 'ai', resumeTask);
      } else {
        handleFiles([...input.files], importMode);
      }
    };
  }

  async function handleFiles(files, importMode = 'smart', resumeTask = null) {
    if (!files.length) return;
    const cfg = await LLM.getConfig();
    if (!cfg.apiKey) {
      toast('请先到「设置」配置 API Key');
      return navigate('#/settings');
    }

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

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const row = rows.get(i);
      const stateEl = row.querySelector('.file-state');
      const setState = (s) => { stateEl.textContent = s; stateEl.dataset.state = s; };
      setState('提取文本…');
      try {
        const raw = await Extractor.extract(f, (p, t) => setState(`提取 ${p}/${t} 页`));
        const text = Extractor.cleanText(raw);
        if (text.replace(/\s/g, '').length < 50) {
          setState('失败');
          row.querySelector('.file-state').innerHTML = '⚠ 无文本';
          continue;
        }
        setState(importMode === 'ai' ? '纯AI 扫描中…' : 'AI 解析…');
        bar.style.width = '5%';
        const t0 = Date.now();

        // 纯AI：断点续扫任务（中途退出可继续，已扫块零重发）
        let bank = null;
        let persist = null;
        if (importMode === 'ai') {
          const resuming = resumeTask && resumeTask.file === f.name;
          if (resuming) {
            // 续扫：沿用原题库（已扫的题已在库里，put 覆盖同 id / 追加新题）
            bank = await DB.bankGet(resumeTask.bankId);
            toast(`续扫模式：跳过已扫 ${resumeTask.doneChunks?.length || 0} 块`);
          }
          if (!bank) bank = { id: DB.uid(), name: f.name.replace(/\.(pdf|docx|doc)$/i, ''), createdAt: Date.now(), count: 0, source: f.name };
          await DB.bankAdd(bank);
          const doneSet = new Set(resuming ? (resumeTask.doneChunks || []) : []);
          persist = {
            doneSet,
            savedQs: [],
            loadHistory: async () => (resuming ? await DB.questionsByBank(bank.id) : []),
            save: async (chunkIdx, qs) => {
              persist.doneSet.add(chunkIdx);
              persist.savedQs.push(...qs);
              await DB.questionAddMany(qs.map(q => ({ ...q, bankId: bank.id })));
              bank.count = (bank.count || 0) + qs.length;
              await DB.bankAdd(bank);
              await DB.metaSet('aiScanTask', { bankId: bank.id, file: f.name, doneChunks: [...persist.doneSet], totalHint: bank.count, time: Date.now() });
            }
          };
        }

        const res = await LLM.parseDocument(text, (done, total, got) => {
          const elapsed = Math.round((Date.now() - t0) / 1000);
          const eta = done ? Math.round(elapsed / done * (total - done)) : 0;
          statusEl.textContent = `AI 扫描中：${done}/${total} 块 · 已提取 ${got} 题 · 已用 ${elapsed}s · 预计还需 ${eta}s${importMode === 'ai' ? ' · 进度实时保存' : ''}`;
          bar.style.width = Math.round(done / total * 95) + '%';
        }, (chunkIdx, attempt, coolSec) => {
          statusEl.textContent = coolSec > 0
            ? `⏳ API 限流，冷却 ${coolSec}s 后重试（第 ${attempt} 次，第 ${chunkIdx + 1} 块）— 已扫进度已保存`
            : `网络波动，重试中（第 ${attempt} 次）… 已扫进度已保存`;
        }, { mode: importMode, persist });
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
        if (importMode === 'ai') {
          // 扫描完成：清任务；把扫描期间的原始题全部替换为最终合并去重结果
          await DB.metaSet('aiScanTask', null);
          await DB.bankDelete(bank.id);
          bank = {
            id: DB.uid(),
            name: f.name.replace(/\.(pdf|docx|doc)$/i, ''),
            createdAt: Date.now(),
            count: res.questions.length,
            source: f.name,
            sections: res.sections || null
          };
        } else {
          bank = {
            id: DB.uid(),
            name: f.name.replace(/\.(pdf|docx|doc)$/i, ''),
            createdAt: Date.now(),
            count: res.questions.length,
            source: f.name,
            sections: res.sections || null
          };
        }
        res.questions.forEach(q => q.bankId = bank.id);
        await DB.questionAddMany(res.questions);
        await DB.bankAdd(bank);
        if (res.noAnswer > 0) {
          setState(`✓ ${res.questions.length} 题（${res.noAnswer} 题缺答案）`);
          toast(`提取 ${res.questions.length} 题，其中 ${res.noAnswer} 题缺答案，可稍后补`);
        } else {
          setState(`✓ ${res.questions.length} 题`);
        }
        // 模式报告
        const problemsText = res.problems?.length
          ? '；⚠ ' + res.problems.slice(0, 5).map(p => `第${p.sec}节${p.dupNos.length ? '重号' + p.dupNos.join('、') : ''}${p.missingNos.length ? (p.dupNos.length ? '·' : '') + '缺号' + p.missingNos.slice(0, 10).join('、') : ''}`).join('；')
          : '';
        if (res.mode === 'ai') {
          const note = `🤖 纯AI录入完成：代码切割 ${res.splitTotal} 题 · 本地解析 ${res.localCount} · AI 扫到 ${res.aiCount} · 合并去重后 ${res.questions.length} 题${degradedCount ? ` · 跳过 ${degradedCount} 道残缺` : ''}`;
          statusEl.textContent = note + problemsText;
          if (res.aiCount > res.questions.length) toast(`注意：AI 扫描结果与切割数有出入，建议核对题量`);
        } else if (res.mode === 'split') {
          const speedNote = res.aiCount > 0
            ? `⚡ 本地解析 ${res.localCount} 题 + AI 兜底 ${res.aiCount} 题`
            : `⚡ 全部 ${res.localCount} 题本地秒级解析（0 次 API 调用）`;
          const warn = [];
          if (degradedCount > 0) warn.push(`自动跳过 ${degradedCount} 道残缺题`);
          statusEl.textContent = speedNote + (warn.length ? '；' + warn.join('；') : '') + problemsText;
        }
      } catch (e) {
        console.error(e);
        setState('失败');
        row.querySelector('.file-state').innerHTML = '⚠ 失败';
        toast(f.name + '：' + e.message.slice(0, 80));
      }
    }
    bar.style.width = '100%';
    statusEl.textContent = '全部完成';
    resultEl.innerHTML = `<button class="btn primary big" onclick="App.navigate('#/home')">完成，返回题库</button>
      <div class="muted small">缺答案的题可在题库列表点「补答案」（上传答案文件或 AI 解答）；扫描版 PDF 会自动 OCR（较慢）；.doc 需另存为 .docx</div>`;
  }

  /* ================= 页面：题目列表（多选题号练习） ================= */
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

    topbar(bank.name.slice(0, 10) || '题目列表', '#/home');
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">选择要练的题（勾选题号）</div>
        <div class="btn-row">
          <button class="btn ghost" id="sel-all">全选</button>
          <button class="btn ghost" id="sel-none">全不选</button>
          <button class="btn ghost" id="sel-noans">只选有答案</button>
          <button class="btn ghost" id="del-sel" style="color:var(--bad)">删除选中</button>
        </div>
        <div class="muted small" id="pick-info" style="margin-top:8px">共 ${qs.length} 题</div>
        <div id="no-grid">
          ${groups.map((g, gi) => `
          <div class="sec-group">
            <div class="sec-head">
              <b>${escapeHtml(g.title)}${g.type ? ` · ${TYPE_NAME[g.type] || ''}` : ''}</b>
              <span class="muted small">${g.idxs.length} 题</span>
              <button class="btn ghost" style="padding:2px 10px;font-size:12px" data-sec="${gi}">本节全选</button>
            </div>
            <div class="no-grid">
              ${g.idxs.map(i => `
              <label class="no-cell ${qs[i].answer ? '' : 'no-ans'}">
                <input type="checkbox" value="${i}" ${qs[i].answer ? 'checked' : ''}>
                <span>${qs[i].no ?? i + 1}</span>
              </label>`).join('')}
            </div>
          </div>`).join('')}
        </div>
        <button class="btn primary big" id="go-quiz" style="margin-top:12px">练习选中题（0）</button>
      </div>
      <style>
        .sec-group { margin-top:12px; }
        .sec-head { display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px dashed var(--line, #e3e8f0); }
        .sec-head b { flex:1; font-size:14px; }
        .no-grid { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
        .no-cell { display:flex; align-items:center; gap:4px; background:#f7f9fc; border-radius:8px; padding:4px 8px; font-size:13px; cursor:pointer; }
        .no-cell.no-ans { opacity:.45; }
        .no-cell input { margin:0; }
      </style>`;

    const grid = document.getElementById('no-grid');
    const info = document.getElementById('pick-info');
    const goBtn = document.getElementById('go-quiz');
    const boxes = () => [...grid.querySelectorAll('input')];
    const checkedIdx = () => boxes().filter(b => b.checked).map(b => +b.value);

    const update = () => {
      const sel = checkedIdx();
      goBtn.textContent = `练习选中题（${sel.length}）`;
      info.textContent = `共 ${qs.length} 题 · 已选 ${sel.length} 题`;
    };
    grid.addEventListener('change', update);
    document.getElementById('sel-all').onclick = () => { boxes().forEach(b => b.checked = true); update(); };
    document.getElementById('sel-none').onclick = () => { boxes().forEach(b => b.checked = false); update(); };
    document.getElementById('sel-noans').onclick = () => {
      boxes().forEach((b, i) => b.checked = !!qs[i].answer);
      update();
    };
    // 本节全选
    grid.querySelectorAll('button[data-sec]').forEach(btn => {
      btn.onclick = () => {
        const g = groups[+btn.dataset.sec];
        const gBoxes = g.idxs.map(i => grid.querySelector(`input[value="${i}"]`));
        const allOn = gBoxes.every(b => b.checked);
        gBoxes.forEach(b => b.checked = !allOn);
        update();
      };
    });
    update();

    goBtn.onclick = async () => {
      const sel = checkedIdx();
      if (!sel.length) return toast('请先勾选题号');
      const list = sel.map(i => qs[i]).filter(q => q.answer);
      if (!list.length) return toast('选中的题都没有答案，请先「补答案」');
      if (list.length < sel.length) toast(`已跳过 ${sel.length - list.length} 道缺答案的题`);
      session = new QuizSession(list, { shuffle: false });
      navigate('#/quiz');
    };

    // 删除选中 → 移入回收站（可恢复；彻底删除需在回收站二次确认）
    document.getElementById('del-sel').onclick = async () => {
      const sel = checkedIdx();
      if (!sel.length) return toast('请先勾选要删除的题');
      if (!confirmDialog(`删除选中 ${sel.length} 题？\n删除后进入回收站，可在回收站恢复或彻底删除。`)) return;
      const del = sel.map(i => qs[i]);
      await DB.recycleAdd(bank, del);
      for (const q of del) await DB.questionDelete(q.id);
      await DB.bankUpdateCount(bankId);
      toast(`已删除 ${del.length} 题，可在回收站恢复`);
      render();
    };
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
        <p class="muted small">支持答案表 PDF/Word/图片，格式如「1.C 2.A 3.B」或「题号：1 答案：C」，也支持纯序列「A B C D」。</p>
        <button class="btn primary big" id="ans-file-btn">选择答案文件</button>
        <input type="file" id="ans-file-input" accept=".pdf,.docx,.doc,.txt" style="display:none">
        <div class="muted small" id="ans-file-status"></div>
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

    // 方式一：答案文件匹配
    const input = document.getElementById('ans-file-input');
    document.getElementById('ans-file-btn').onclick = () => input.click();
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      fileStatus.textContent = '提取答案文本…';
      try {
        const raw = await Extractor.extract(f);
        const text = Extractor.cleanText(raw);
        const { map, mode } = LLM.parseAnswerMap(text);
        if (mode === 'none') {
          fileStatus.textContent = '⚠ 未识别出答案（需「题号+答案」或连续的 A-D 序列）';
          return;
        }
        fileStatus.textContent = `识别到 ${map.size} 个答案（${mode === 'numbered' ? '按题号' : '按顺序'}），匹配中…`;
        const filled = LLM.matchAnswers(noAns, map, mode);
        if (!filled) {
          fileStatus.textContent = '⚠ 未能匹配到缺答案题目（题号对不上？）';
          return;
        }
        for (const q of noAns) if (q.answer) await DB.questionPut(q);
        fileStatus.textContent = `✓ 成功填入 ${filled} 个答案`;
        toast(`已补 ${filled} 个答案`);
        render();
      } catch (e) {
        fileStatus.textContent = '⚠ ' + e.message.slice(0, 100);
      }
    };

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
    const banks = await DB.bankList();
    banks.sort((a, b) => b.createdAt - a.createdAt);
    // 统计各库有答案题数（练习只用有答案的题）
    const ansMap = {};
    await Promise.all(banks.map(async b => {
      const qs = await DB.questionsByBank(b.id);
      ansMap[b.id] = qs.filter(q => q.answer).length;
    }));
    const total = banks.reduce((s, b) => s + (ansMap[b.id] || 0), 0);
    const starCount = (await DB.starQuestions()).filter(q => q.answer).length;
    if (!total) {
      $view().innerHTML = `<div class="empty" style="padding-top:40px">暂无带答案的题目<br>请先导入文件并在题库列表「补答案」</div>`;
      return;
    }
    $view().innerHTML = `
      <div class="card">
        <div class="card-title">范围（不选 = 全部题库）</div>
        <div class="bank-pick">
          ${banks.map(b => `<label class="pick-item"><input type="checkbox" value="${b.id}" checked> ${escapeHtml(b.name)}（${ansMap[b.id] || 0}）</label>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-title">题型</div>
        <div class="seg" id="seg-type">
          <button data-v="all" class="on">全部</button>
          <button data-v="choice">选择/判断</button>
          <button data-v="fill">填空</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">顺序</div>
        <div class="seg" id="seg-order">
          <button data-v="order" class="on">顺序</button>
          <button data-v="shuffle">随机</button>
        </div>
      </div>
      <button class="btn primary big" id="start-quiz">开始（共 ${total} 题可选）</button>
      <button class="btn ghost big" onclick="App.wrongRedo()">错题重做</button>
      ${starCount ? `<button class="btn ghost big" onclick="App.starRedo()">★ 收藏重练（${starCount}）</button>` : ''}`;

    const segType = document.getElementById('seg-type');
    const segOrder = document.getElementById('seg-order');
    [[segType], [segOrder]].forEach(([seg]) => {
      seg.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      };
    });
    document.getElementById('start-quiz').onclick = async () => {
      const ids = [...document.querySelectorAll('.pick-item input:checked')].map(i => i.value);
      const all = [...document.querySelectorAll('.pick-item input')].map(i => i.value);
      const raw = segType.querySelector('.on').dataset.v; // all | choice | fill
      const filterType = raw === 'all' ? 'answered' : raw + '|answered';
      const shuffle = segOrder.querySelector('.on').dataset.v === 'shuffle';
      session = await QuizBuilder.fromBanks(ids.length ? ids : all, { shuffle, filterType });
      if (!session.total) return toast('该筛选下没有可练的题（可能都缺答案）');
      navigate('#/quiz');
    };
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
  function pageQuiz() {
    if (!session || session.finished) return navigate('#/quiz-result');
    const q = session.current;
    topbar(`${session.pos} / ${session.total}`, '#/quiz-setup');
    const multi = q.type === 'multi';
    const optKeys = q.options ? Object.keys(q.options) : [];

    $view().innerHTML = `
      <div class="quiz-head">
        <span class="q-type ${q.type}">${typeLabel[q.type]}</span>
        <span class="quiz-prog">${session.progress.done} 已答</span>
        <button class="star-btn" id="star-btn" title="收藏本题">☆</button>
        <button class="star-btn" id="edit-btn" title="修改答案与解析" style="font-size:19px">✎</button>
      </div>
      <div class="card" id="edit-card" style="display:none"></div>
      <div class="card">
        <div class="stem">${renderStem(q)}</div>
        ${q.type === 'fill' ? `
          <div class="fill-area">
            ${q.answer.split('|||').map((_, i) => `<input type="text" class="fill-input" placeholder="第 ${i + 1} 空" inputmode="text">`).join('')}
            <button class="btn primary" id="fill-submit">提交答案</button>
          </div>` : `
          <div class="options">
            ${optKeys.map(k => `
              <button class="option" data-k="${k}" ${multi ? '' : 'data-single'}>
                <span class="opt-key">${k}</span>
                <span class="opt-text">${escapeHtml(q.options[k])}</span>
              </button>`).join('')}
          </div>
          ${multi ? `<button class="btn primary big" id="multi-submit">提交答案</button>` : ''}`}
        <div class="judge-area" id="judge-area" style="display:none"></div>
      </div>
      <div class="quiz-nav">
        <button class="btn ghost" id="skip-btn" ${session.index === 0 ? 'disabled' : ''}>上一题</button>
        <button class="btn ghost" id="next-btn" style="display:none">下一题</button>
      </div>`;

    const judgeArea = document.getElementById('judge-area');
    const nextBtn = document.getElementById('next-btn');
    const answered = session.answered.get(q.id);

    function showResult(res) {
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
      nextBtn.style.display = '';
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
    }

    if (answered) showResult(answered);

    if (q.type === 'fill') {
      const submit = () => {
        const vals = [...document.querySelectorAll('.fill-input')].map(i => i.value.trim()).join('|||');
        if (!vals.replace(/\|\|\|/g, '')) return toast('请先填写答案');
        const res = session.submit(vals);
        if (res) showResult({ ...res, userAnswer: vals });
      };
      document.getElementById('fill-submit').onclick = submit;
    } else {
      let picked = new Set();
      document.querySelectorAll('.option').forEach(el => {
        el.onclick = () => {
          if (answered || el.classList.contains('disabled')) return;
          const k = el.dataset.k;
          if (multi) {
            picked.has(k) ? picked.delete(k) : picked.add(k);
            el.classList.toggle('picked');
          } else {
            picked = new Set([k]);
            document.querySelectorAll('.option').forEach(x => x.classList.remove('picked'));
            el.classList.add('picked');
            const res = session.submit(k);
            if (res) showResult({ ...res, userAnswer: k });
          }
        };
      });
      const ms = document.getElementById('multi-submit');
      if (ms) ms.onclick = () => {
        if (!picked.size) return toast('请先选择答案');
        const ans = [...picked].sort().join('');
        const res = session.submit(ans);
        if (res) showResult({ ...res, userAnswer: ans });
      };
    }

    document.getElementById('skip-btn').onclick = () => { if (session.index > 0) { session.index--; saveProgress(); render(); } };
    nextBtn.onclick = () => {
      session.next();
      saveProgress();
      if (session.finished) navigate('#/quiz-result'); // hash 变化自动触发 render
      else render(); // hash 未变，手动渲染
    };

    // 收藏本题：异步回填状态，点击切换
    const starBtn = document.getElementById('star-btn');
    DB.starIds().then(ids => {
      if (starBtn && ids.includes(q.id)) { starBtn.textContent = '★'; starBtn.classList.add('on'); }
    });
    if (starBtn) starBtn.onclick = async () => {
      const added = await DB.starToggle(q.id);
      starBtn.textContent = added ? '★' : '☆';
      starBtn.classList.toggle('on', added);
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
        const q = session.current;
        const answered = session.answered.has(q.id);
        if (dx < 0) { // 左滑 → 下一题
          if (!answered) return toast('请先作答再翻下一题');
          if (nextBtn.style.display !== 'none') nextBtn.click();
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

  /* ================= 页面：结果 ================= */
  function pageQuizResult() {
    if (!session) return navigate('#/home');
    const p = session.progress;
    const acc = p.done ? Math.round(p.correct / p.done * 100) : 0;
    topbar('练习结果', '#/home');
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

    $view().innerHTML = `
      <div class="stats-row">
        <div class="stat-cell"><b>${s.total}</b><span>累计答题</span></div>
        <div class="stat-cell"><b>${acc}%</b><span>正确率</span></div>
        <div class="stat-cell"><b>${wrongCount}</b><span>当前错题</span></div>
      </div>
      <div class="card">
        <div class="card-title">近 ${days.length} 日答题量</div>
        ${days.length ? `<div class="chart">
          ${days.map(([d, v]) => `<div class="col" title="${d}：${v.total} 题">
            <div class="col-bar" style="height:${Math.round(v.total / max * 100)}%"></div>
            <span class="col-label">${d.slice(5)}</span></div>`).join('')}
        </div>` : '<div class="muted">暂无答题记录</div>'}
      </div>`;
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
        <div class="card-title">AI 解析接口（OpenAI 兼容）</div>
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
      <div class="muted small center">刷题宝 · 本地题库存储于浏览器 IndexedDB<br>手机浏览器打开即用，可"添加到主屏幕"当 APP 使用</div>`;

    // Blob → base64（APK 中 WebView 不触发 <a download>，需走 JS 桥接原生直接写入 Download 目录）
    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
          const url = fr.result || '';
          // data:application/json;base64,xxx...  去掉 data:*/*;base64, 前缀
          const i = url.indexOf(',');
          resolve(i >= 0 ? url.slice(i + 1) : '');
        };
        fr.onerror = () => reject(fr.error || new Error('blobToBase64 失败'));
        fr.readAsDataURL(blob);
      });
    }

    // 备份：导出全部题库 JSON
    document.getElementById('backup-btn').onclick = async () => {
      const st = document.getElementById('backup-status');
      try {
        const banks = await DB.bankList();
        if (!banks.length) return toast('题库为空，无可导出');
        const all = { version: 1, exportedAt: new Date().toISOString(), banks, questions: {} };
        for (const b of banks) all.questions[b.id] = await DB.questionsByBank(b.id);
        const fileName = `刷题宝备份_${new Date().toISOString().slice(0, 10)}.json`;
        const blob = new Blob([JSON.stringify(all)], { type: 'application/json' });

        // APK 环境：走 JS 桥接原生保存到系统 Download 目录 → 文件管理器直接可见
        const bridge = (typeof window !== 'undefined') && window.AndroidBridge;
        const isApk = bridge && typeof bridge.isAvailable === 'function' && bridge.isAvailable();
        if (isApk) {
          const b64 = await blobToBase64(blob);
          if (!b64) throw new Error('文件内容为空');
          const res = ('' + (bridge.saveFile(fileName, b64) || '')).trim();
          if (res.startsWith('OK:')) {
            const path = res.slice(3);
            st.textContent = `✓ 已导出 ${banks.length} 个题库、${banks.reduce((s, b) => s + b.count, 0)} 题 → ${path}`;
          } else if (res.startsWith('NEED_PERMISSION:')) {
            st.textContent = '⚠ ' + res.slice(16) + '（授予后再点一次导出）';
          } else {
            throw new Error(res || '原生保存失败');
          }
        } else {
          // 浏览器 / PWA：走标准 <a download>
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = fileName;
          a.click();
          URL.revokeObjectURL(a.href);
          st.textContent = `✓ 已导出 ${banks.length} 个题库、${banks.reduce((s, b) => s + b.count, 0)} 题`;
        }
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
  }

  return { init, navigate, startBank, delBank, renameBank, wrongRedo, starRedo, replay, finishQuiz, clearProgress, resumeLast, clearRecords, toast };
})();

document.addEventListener('DOMContentLoaded', App.init);
