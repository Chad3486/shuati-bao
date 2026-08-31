/* ========== 答题会话逻辑 ========== */
class QuizSession {
  /**
   * @param questions 题目数组
   * @param opts {shuffle:false, mode:'normal'|'wrong'}
   */
  constructor(questions, opts = {}) {
    this.all = questions;
    this.opts = opts;
    this.list = opts.shuffle ? this._shuffle([...questions]) : [...questions];
    this.index = 0;
    this.answered = new Map(); // qid -> {userAnswer, correct}
    this.startTime = Date.now();
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  get current() { return this.list[this.index]; }
  get total() { return this.list.length; }
  get pos() { return this.index + 1; }
  get finished() { return this.index >= this.list.length; }

  get progress() {
    const answered = [...this.answered.values()];
    return {
      total: this.list.length,
      done: answered.length,
      correct: answered.filter(a => a.correct).length,
      wrong: answered.filter(a => !a.correct).length
    };
  }

  /* ---- 填空题判分：宽松比对（去空白/标点） ---- */
  static normalizeFill(s) {
    if (s == null) return '';
    return String(s).replace(/[\s，。、；：""''？！,.;:'"?!（）()【】\[\]]/g, '').toLowerCase();
  }

  static checkFill(userAns, stdAns) {
    const uParts = String(userAns).split('|||').map(QuizSession.normalizeFill);
    const sParts = String(stdAns).split('|||').map(QuizSession.normalizeFill);
    if (uParts.length !== sParts.length) {
      // 用户没按格式分空，尝试整体比对
      return QuizSession.normalizeFill(userAns) === QuizSession.normalizeFill(stdAns);
    }
    return uParts.every((u, i) => u === sParts[i]);
  }

  /* ---- 提交答案 ---- */
  submit(userAnswer) {
    const q = this.current;
    if (!q || this.answered.has(q.id)) return null;

    let correct = false;
    if (q.type === 'fill') {
      correct = QuizSession.checkFill(userAnswer, q.answer);
    } else {
      const norm = s => String(s).toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
      correct = norm(userAnswer) === norm(q.answer);
    }

    this.answered.set(q.id, { userAnswer, correct, q });
    DB.recordAdd({
      questionId: q.id,
      bankId: q.bankId,
      userAnswer: String(userAnswer),
      correct
    });
    return { correct, answer: q.answer, explanation: q.explanation };
  }

  next() { this.index++; return !this.finished; }
  jump(i) { if (i >= 0 && i < this.list.length) this.index = i; }

  /* ---- 断点续做：序列化（只存 id 序列 + 进度，题目本身在库里） ---- */
  serialize() {
    return {
      ids: this.list.map(q => q.id),
      index: this.index,
      // 已答的题只存 id->结果，恢复时从库里取题
      answered: [...this.answered.entries()].map(([qid, v]) => qid)
    };
  }
  /* ---- 反序列化：查库重建 ---- */
  static async restore(data) {
    const qs = [];
    for (const id of data.ids) {
      const q = await DB.questionGet(id);
      if (q) qs.push(q);
    }
    const s = new QuizSession(qs, { shuffle: false });
    s.index = Math.min(data.index || 0, Math.max(0, qs.length - 1));
    return s;
  }
}

/* ---- 构建会话的辅助 ---- */
const QuizBuilder = {
  /** 从多个题库构建：filterType 筛题型 */
  async fromBanks(bankIds, { shuffle = false, filterType = 'all' } = {}) {
    let qs = [];
    for (const id of bankIds) {
      const list = await DB.questionsByBank(id);
      qs.push(...list);
    }
    if (filterType !== 'all') {
      // 支持组合："choice|answered" / "fill|answered" / "answered"
      const parts = String(filterType).split('|');
      if (parts.includes('answered')) qs = qs.filter(q => q.answer);
      if (parts.includes('choice')) qs = qs.filter(q => q.type === 'single' || q.type === 'multi' || q.type === 'judge');
      else if (parts.includes('fill')) qs = qs.filter(q => q.type === 'fill');
    }
    return new QuizSession(qs, { shuffle });
  },

  /** 错题重做 */
  async wrongRedo() {
    const qs = await DB.wrongQuestions();
    return new QuizSession(qs, { shuffle: true, mode: 'wrong' });
  }
};
