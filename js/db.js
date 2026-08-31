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

  return { open, metaGet, metaSet, bankAdd, bankList, bankGet, bankDelete, bankRename, bankUpdateCount, questionAddMany, questionsByBank, questionPut, questionGet, questionDelete, recordAdd, recordsAll, wrongQuestions, stats, clearRecords, uid, starIds, starToggle, starQuestions, recycleList, recycleAdd, recycleRemove, recycleRestore, recycleClear };
})();
