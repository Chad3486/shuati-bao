/* ========== 学习统计视图模型：纯计算，不访问 IndexedDB ========== */
const StatsModel = (() => {
  function dayKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /* 最近 N 个自然日，包含没有答题的日期，避免趋势图把断练日期悄悄略过。 */
  function recentDays(byDay, count = 7, today = new Date()) {
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(end.getDate() - i);
      const key = dayKey(d);
      const value = byDay[key] || { total: 0, correct: 0 };
      out.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        weekday: '日一二三四五六'[d.getDay()],
        total: value.total || 0,
        correct: value.correct || 0,
        acc: value.total ? Math.round(value.correct / value.total * 100) : 0
      });
    }
    return out;
  }

  function periodSummary(days) {
    const total = days.reduce((n, d) => n + d.total, 0);
    const correct = days.reduce((n, d) => n + d.correct, 0);
    return { total, correct, acc: total ? Math.round(correct / total * 100) : 0 };
  }

  /*
   * 每题只取最近一次作答，按“题库 + 章节序号”聚合。
   * 推荐分 = 掌握不足 × 样本置信度 + 答错题数，并给久未练习少量加权。
   * 用总体正确率作 4 题先验，避免 0/1、0/2 这种小样本被武断判成最薄弱。
   */
  function chapterRows(latest, banks, questions, { globalAcc = 60, now = Date.now() } = {}) {
    const qById = new Map(questions.map(q => [q.id, q]));
    const secTitle = new Map();
    const bankName = new Map(banks.map(b => [b.id, b.name]));
    for (const b of banks) {
      for (const sec of (b.sections || [])) secTitle.set(b.id + ':' + String(sec.secIdx), sec.title);
    }
    const agg = new Map();
    for (const [qid, rec] of Object.entries(latest || {})) {
      const q = qById.get(qid);
      if (!q) continue;
      const secIdx = String(q.secIdx ?? '');
      const key = q.bankId + ':' + secIdx;
      const cur = agg.get(key) || { key, bankId: q.bankId, secIdx, total: 0, correct: 0, lastTime: 0 };
      cur.total++;
      if (rec.correct) cur.correct++;
      cur.lastTime = Math.max(cur.lastTime, rec.time || 0);
      agg.set(key, cur);
    }
    const prior = 4;
    const priorRate = Math.max(0, Math.min(100, globalAcc)) / 100;
    return [...agg.values()].map(x => {
      const acc = Math.round(x.correct / x.total * 100);
      const wrong = x.total - x.correct;
      const estimatedRaw = (x.correct + priorRate * prior) / (x.total + prior) * 100;
      const confidence = Math.min(1, x.total / 6);
      const ageDays = x.lastTime ? Math.max(0, (now - x.lastTime) / 86400000) : 0;
      const recencyBoost = 1 + Math.min(.15, ageDays / 30 * .15);
      const priority = ((100 - estimatedRaw) * (.5 + .5 * confidence) + Math.min(wrong, 5) * 2) * recencyBoost;
      return {
        ...x,
        acc,
        estimated: Math.round(estimatedRaw),
        sampleLow: x.total < 3,
        priority,
        title: secTitle.get(x.key) || (x.secIdx === '' ? '未分节' : `第 ${x.secIdx} 节`),
        bank: bankName.get(x.bankId) || ''
      };
    }).sort((a, b) => b.priority - a.priority || a.acc - b.acc || b.total - a.total || a.key.localeCompare(b.key));
  }

  function mastery(acc, total = 3) {
    if (total < 3) return { label: '样本少', tone: 'mid' };
    if (acc >= 80) return { label: '已掌握', tone: 'good' };
    if (acc >= 60) return { label: '待巩固', tone: 'mid' };
    return { label: '薄弱', tone: 'weak' };
  }

  return { dayKey, recentDays, periodSummary, chapterRows, mastery };
})();
