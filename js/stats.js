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

  /* 每题只取最近一次作答，按“题库 + 章节序号”聚合；同名章节不会串数据。 */
  function chapterRows(latest, banks, questions) {
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
      const cur = agg.get(key) || { key, bankId: q.bankId, secIdx, total: 0, correct: 0 };
      cur.total++;
      if (rec.correct) cur.correct++;
      agg.set(key, cur);
    }
    return [...agg.values()].map(x => ({
      ...x,
      acc: Math.round(x.correct / x.total * 100),
      title: secTitle.get(x.key) || (x.secIdx === '' ? '未分节' : `第 ${x.secIdx} 节`),
      bank: bankName.get(x.bankId) || ''
    })).sort((a, b) => a.acc - b.acc || b.total - a.total || a.key.localeCompare(b.key));
  }

  function mastery(acc) {
    if (acc >= 80) return { label: '已掌握', tone: 'good' };
    if (acc >= 60) return { label: '待巩固', tone: 'mid' };
    return { label: '薄弱', tone: 'weak' };
  }

  return { dayKey, recentDays, periodSummary, chapterRows, mastery };
})();
