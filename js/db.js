/* ========== IndexedDB 存储层 ========== */
const DB = (() => {
  const DB_NAME = 'QuizAppDB';
  const DB_VERSION = 1;
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('banks')) {
          const s = d.createObjectStore('banks', { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt');
        }
        if (!d.objectStoreNames.contains('questions')) {
          const s = d.createObjectStore('questions', { keyPath: 'id' });
          s.createIndex('bankId', 'bankId');
        }
        if (!d.objectStoreNames.contains('records')) {
          const s = d.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
          s.createIndex('questionId', 'questionId');
          s.createIndex('bankId', 'bankId');
          s.createIndex('time', 'time');
        }
        if (!d.objectStoreNames.contains('meta')) {
          d.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode = 'readonly') {
    return db.transaction(store, mode).objectStore(store);
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* ---- meta ---- */
  async function metaGet(key) {
    const r = await promisify(tx('meta').get(key));
    return r ? r.value : null;
  }
  async function metaSet(key, value) {
    await promisify(tx('meta', 'readwrite').put({ key, value }));
  }

  /* ---- banks ---- */
  async function bankAdd(bank) {
    await promisify(tx('banks', 'readwrite').put(bank));
    return bank;
  }
  async function bankList() {
    return promisify(tx('banks').getAll());
  }
  async function bankGet(id) {
    return promisify(tx('banks').get(id));
  }
  async function bankDelete(id) {
    await promisify(tx('banks', 'readwrite').delete(id));
    // 级联删题
    const store = tx('questions', 'readwrite');
    const idx = store.index('bankId');
    const req = idx.openCursor(IDBKeyRange.only(id));
    await new Promise((resolve) => {
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
        else resolve();
      };
    });
    // 级联清该库回收站条目（题库已删，恢复无处可去）
    await recycleClear(id);
  }
  async function bankRename(id, name) {
    const bank = await bankGet(id);
    if (!bank) return null;
    bank.name = name;
    await bankAdd(bank);
    return bank;
  }
  async function bankUpdateCount(id) {
    const count = await promisify(tx('questions').index('bankId').count(IDBKeyRange.only(id)));
    const bank = await bankGet(id);
    if (bank) { bank.count = count; await bankAdd(bank); }
    return count;
  }

  /* ---- questions ---- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  async function questionAddMany(questions) {
    // upsert：主键冲突时 put 覆盖而不是 add 报错（重复导入/中断重试不再炸）
    return new Promise((resolve, reject) => {
      const store = tx('questions', 'readwrite');
      let done = 0;
      const finish = () => { if (++done === questions.length) resolve(done); };
      questions.forEach(q => {
        if (!q.id) q.id = uid();
        const r = store.put(q);
        r.onsuccess = finish;
        r.onerror = () => reject(r.error);
      });
      if (!questions.length) resolve(0);
    });
  }
  async function questionsByBank(bankId) {
    return promisify(tx('questions').index('bankId').getAll(IDBKeyRange.only(bankId)));
  }
  async function questionPut(q) {
    await promisify(tx('questions', 'readwrite').put(q));
  }
  async function questionGet(id) {
    return promisify(tx('questions').get(id));
  }
  async function questionDelete(id) {
    await promisify(tx('questions', 'readwrite').delete(id));
  }

  /* ---- records ---- */
  async function recordAdd(rec) {
    rec.time = Date.now();
    await promisify(tx('records', 'readwrite').add(rec));
  }
  async function recordsAll() {
    return promisify(tx('records').getAll());
  }

  /* ---- 回收站（存 meta，简单可靠；删除的题目可恢复/彻底删除） ---- */
  async function recycleList() {
    return (await metaGet('recycleBin')) || [];
  }
  async function recycleAdd(bank, questions) {
    if (!questions || !questions.length) return;
    const bin = await recycleList();
    const now = Date.now();
    for (const q of questions) {
      bin.push({ qid: q.id, bankId: bank.id, bankName: bank.name, question: q, deletedAt: now });
    }
    await metaSet('recycleBin', bin);
  }
  async function recycleRemove(qid) {
    const bin = await recycleList();
    await metaSet('recycleBin', bin.filter(x => x.qid !== qid));
  }
  async function recycleRestore(qid) {
    const bin = await recycleList();
    const item = bin.find(x => x.qid === qid);
    if (!item) return null;
    // 目标题库已不存在 → 恢复失败（前端提示）
    const bank = await bankGet(item.bankId);
    if (!bank) return { ok: false, reason: 'bankGone' };
    const q = { ...item.question };
    // 原 id 已被新题占用（重复导入等）→ 换新 id 防覆盖
    const clash = await promisify(tx('questions').get(q.id));
    if (clash) q.id = uid();
    await questionPut(q);
    await bankUpdateCount(item.bankId);
    await metaSet('recycleBin', bin.filter(x => x.qid !== qid));
    return { ok: true };
  }
  async function recycleClear(bankId) {
    const bin = await recycleList();
    await metaSet('recycleBin', bankId ? bin.filter(x => x.bankId !== bankId) : []);
  }

  /* ---- 收藏（存 meta，简单可靠） ---- */
  async function starIds() {
    return (await metaGet('starIds')) || [];
  }
  async function starToggle(id) {
    const ids = await starIds();
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1); else ids.push(id);
    await metaSet('starIds', ids);
    return i < 0; // 返回是否新增收藏
  }
  async function starQuestions() {
    const ids = await starIds();
    if (!ids.length) return [];
    const out = [];
    for (const id of ids) {
      const q = await promisify(tx('questions').get(id));
      if (q) out.push(q);
    }
    return out;
  }

  /* ---- 每题最近一次作答：{qid: {correct, time}}（错题筛选 / 章节正确率共用，避免重复遍历） ---- */
  async function latestByQuestion() {
    const recs = await recordsAll();
    const latest = {};
    for (const r of recs) {
      const p = latest[r.questionId];
      if (!p || r.time > p.time) latest[r.questionId] = { correct: !!r.correct, time: r.time };
    }
    return latest;
  }

  /* ---- 错题：按题目聚合（最近一次答错且未在后续答对） ---- */
  async function wrongQuestions() {
    const recs = await recordsAll();
    // 按 questionId 分组取最新
    const latest = {};
    for (const r of recs) {
      if (!latest[r.questionId] || r.time > latest[r.questionId].time) latest[r.questionId] = r;
    }
    const wrongIds = Object.values(latest).filter(r => !r.correct).map(r => r.questionId);
    if (!wrongIds.length) return [];
    const store = tx('questions');
    const out = [];
    for (const id of wrongIds) {
      const q = await promisify(store.get(id));
      if (q) out.push(q);
    }
    return out;
  }

  async function clearRecords() {
    await promisify(tx('records', 'readwrite').clear());
  }

  async function stats() {
    const recs = await recordsAll();
    const byDay = {};
    let correct = 0;
    for (const r of recs) {
      const day = new Date(r.time).toISOString().slice(0, 10);
      byDay[day] = byDay[day] || { total: 0, correct: 0 };
      byDay[day].total++;
      if (r.correct) { correct++; byDay[day].correct++; }
    }
    return { total: recs.length, correct, wrong: recs.length - correct, byDay };
  }

  const idbApi = { open, metaGet, metaSet, bankAdd, bankList, bankGet, bankDelete, bankRename, bankUpdateCount, questionAddMany, questionsByBank, questionPut, questionGet, questionDelete, recordAdd, recordsAll, latestByQuestion, wrongQuestions, stats, clearRecords, uid, starIds, starToggle, starQuestions, recycleList, recycleAdd, recycleRemove, recycleRestore, recycleClear };

  /* ========== 降级存储：IndexedDB 被禁用（预览沙箱 / 内嵌页 / 部分 WebView）时自动接管
     优先用 localStorage 持久化；连 localStorage 也不可用（不透明源）时退化为纯内存，保证页面能打开可用 ========== */
  function makeMem() {
    const KEY = 'quizapp_mem_v1';
    let data = { banks: [], questions: [], records: [], meta: {}, seq: 1 };
    let persist = true;
    try { const raw = localStorage.getItem(KEY); if (raw) data = JSON.parse(raw); }
    catch (e) { persist = false; }
    let timer = null;
    const save = () => { if (!persist) return; try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { persist = false; } };
    const saveSoon = () => { clearTimeout(timer); timer = setTimeout(save, 150); };
    // 页面隐藏/关闭时立刻落盘，避免防抖窗口内丢数据
    if (typeof window !== 'undefined' && window.addEventListener) {
      const flush = () => { if (timer) { clearTimeout(timer); timer = null; } save(); };
      window.addEventListener('pagehide', flush);
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
      }
    }
    const byId = (arr, id) => arr.find(x => x.id === id);
    const countOf = bankId => data.questions.filter(q => q.bankId === bankId).length;

    return {
      async open() { },
      uid,
      persist: () => persist,
      async metaGet(key) { return key in data.meta ? data.meta[key] : null; },
      async metaSet(key, value) { data.meta[key] = value; saveSoon(); },
      async bankAdd(bank) { const i = data.banks.findIndex(b => b.id === bank.id); if (i >= 0) data.banks[i] = bank; else data.banks.push(bank); saveSoon(); return bank; },
      async bankList() { return data.banks.slice(); },
      async bankGet(id) { return byId(data.banks, id) || undefined; },
      async bankDelete(id) {
        data.banks = data.banks.filter(b => b.id !== id);
        data.questions = data.questions.filter(q => q.bankId !== id);
        data.meta.recycleBin = (data.meta.recycleBin || []).filter(x => x.bankId !== id);
        saveSoon();
      },
      async bankRename(id, name) { const b = byId(data.banks, id); if (!b) return null; b.name = name; saveSoon(); return b; },
      async bankUpdateCount(id) { const c = countOf(id); const b = byId(data.banks, id); if (b) { b.count = c; saveSoon(); } return c; },
      async questionAddMany(qs) {
        for (const q of qs) { if (!q.id) q.id = uid(); const i = data.questions.findIndex(x => x.id === q.id); if (i >= 0) data.questions[i] = q; else data.questions.push(q); }
        saveSoon(); return qs.length;
      },
      async questionsByBank(bankId) { return data.questions.filter(q => q.bankId === bankId); },
      async questionPut(q) { const i = data.questions.findIndex(x => x.id === q.id); if (i >= 0) data.questions[i] = q; else data.questions.push(q); saveSoon(); },
      async questionGet(id) { return byId(data.questions, id) || undefined; },
      async questionDelete(id) { data.questions = data.questions.filter(q => q.id !== id); saveSoon(); },
      async recordAdd(rec) { rec.id = data.seq++; rec.time = Date.now(); data.records.push(rec); saveSoon(); },
      async recordsAll() { return data.records.slice(); },
      async latestByQuestion() {
        const latest = {};
        for (const r of data.records) { const p = latest[r.questionId]; if (!p || r.time > p.time) latest[r.questionId] = { correct: !!r.correct, time: r.time }; }
        return latest;
      },
      async wrongQuestions() {
        const latest = {};
        for (const r of data.records) if (!latest[r.questionId] || r.time > latest[r.questionId].time) latest[r.questionId] = r;
        const ids = Object.values(latest).filter(r => !r.correct).map(r => r.questionId);
        return data.questions.filter(q => ids.includes(q.id));
      },
      async stats() {
        const byDay = {}; let correct = 0;
        for (const r of data.records) {
          const day = new Date(r.time).toISOString().slice(0, 10);
          byDay[day] = byDay[day] || { total: 0, correct: 0 };
          byDay[day].total++;
          if (r.correct) { correct++; byDay[day].correct++; }
        }
        return { total: data.records.length, correct, wrong: data.records.length - correct, byDay };
      },
      async clearRecords() { data.records = []; saveSoon(); },
      async starIds() { return (data.meta.starIds || []).slice(); },
      async starToggle(id) { const ids = data.meta.starIds || (data.meta.starIds = []); const i = ids.indexOf(id); if (i >= 0) ids.splice(i, 1); else ids.push(id); saveSoon(); return i < 0; },
      async starQuestions() { const ids = data.meta.starIds || []; return data.questions.filter(q => ids.includes(q.id)); },
      async recycleList() { return (data.meta.recycleBin || []).slice(); },
      async recycleAdd(bank, questions) {
        if (!questions || !questions.length) return;
        const bin = data.meta.recycleBin || (data.meta.recycleBin = []);
        const now = Date.now();
        for (const q of questions) bin.push({ qid: q.id, bankId: bank.id, bankName: bank.name, question: q, deletedAt: now });
        saveSoon();
      },
      async recycleRemove(qid) { data.meta.recycleBin = (data.meta.recycleBin || []).filter(x => x.qid !== qid); saveSoon(); },
      async recycleRestore(qid) {
        const bin = data.meta.recycleBin || [];
        const item = bin.find(x => x.qid === qid);
        if (!item) return null;
        if (!byId(data.banks, item.bankId)) return { ok: false, reason: 'bankGone' };
        const q = { ...item.question };
        if (byId(data.questions, q.id)) q.id = uid();
        const i = data.questions.findIndex(x => x.id === q.id); if (i >= 0) data.questions[i] = q; else data.questions.push(q);
        const b = byId(data.banks, item.bankId); if (b) b.count = countOf(item.bankId);
        data.meta.recycleBin = bin.filter(x => x.qid !== qid);
        saveSoon();
        return { ok: true };
      },
      async recycleClear(bankId) { data.meta.recycleBin = bankId ? (data.meta.recycleBin || []).filter(x => x.bankId !== bankId) : []; saveSoon(); }
    };
  }

  const memApi = makeMem();
  const state = { fallback: false };

  /* IndexedDB 初始化失败 → 自动降级，绝不因存储不可用而白屏 */
  async function openSmart() {
    try {
      await open();
      state.fallback = false;
    } catch (e) {
      console.warn('[DB] IndexedDB 不可用（' + (e && e.name) + '：' + (e && e.message) + '），已切换本地降级存储');
      state.fallback = true;
    }
  }

  const api = {};
  for (const k of Object.keys(idbApi)) {
    if (k === 'open') continue;
    api[k] = (...args) => (state.fallback ? memApi : idbApi)[k](...args);
  }
  api.open = openSmart;
  api.isFallback = () => state.fallback;
  api.fallbackPersistent = () => state.fallback && memApi.persist();
  return api;
})();
