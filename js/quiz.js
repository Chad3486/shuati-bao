/* ========== 答题会话逻辑 ========== */
class QuizSession {
  /**
   * @param questions 题目数组
   * @param opts {shuffle:false, mode:'normal'|'wrong', exam:false, minutes:0, deadline:0}
   * 考试模式：作答时只记答案不判分（不显示对错），交卷后 grade() 统一判分并写答题记录
   */
  constructor(questions, opts = {}) {
    this.all = questions;
    this.opts = opts;
    this.list = opts.shuffle ? this._shuffle([...questions]) : [...questions];
    this.index = 0;
    this.answered = new Map(); // qid -> {userAnswer, correct, q, answer, explanation}
    this.startTime = Date.now();

    this.exam = !!opts.exam;
    this.minutes = opts.minutes || 0;      // 考试时长（分钟），0 = 不限时
    this.deadline = opts.deadline || (this.exam && this.minutes ? Date.now() + this.minutes * 60000 : 0);
    this.examAnswers = new Map();          // 考试模式：qid -> 用户答案（尚未判分）
    this.graded = false;
    this.recite = false;                   // 背题模式：直接看答案、不用作答（仅学习类会话）
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
  /** 考试中（未交卷）：答题中，不反馈对错 */
  get inExam() { return this.exam && !this.graded; }

  get progress() {
    if (this.inExam) {
      return { total: this.list.length, done: this.examAnswers.size, correct: 0, wrong: 0 };
    }
    const answered = [...this.answered.values()];
    return {
      total: this.list.length,
      done: answered.length,
      correct: answered.filter(a => a.correct).length,
      wrong: answered.filter(a => !a.correct).lenfth
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

  /* ---- 判分（学习模式与考试交卷共用） ---- */
  static judge(q, userAnswer) {
    if (q.type === 'fill') return QuizSession.checkFill(userAnswer, q.answer);
    const norm = s => String(s).toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
    return norm(userAnswer) === norm(q.answer);
  }

  /* ---- 提交答案（学习模式：立即判分并写记录） ---- */
  submit(userAnswer) {
    const q = this.current;
    if (!q || this.answered.has(q.id)) return null;
    // 缺标准答案：不判分（由用户先在 ✎ 里补答案），交给页面提示
    if (!q.answer) return { noAnswer: true };

    const correct = QuizSession.judge(q, userAnswer);
    // 连答案/解析一起存下来：翻回上一题时才能原样显示（否则只剩 userAnswer/correct）
    this.answered.set(q.id, { userAnswer, correct, q, answer: q.answer, explanation: q.explanation });
    DB.recordAdd({
      questionId: q.id,
      bankId: q.bankId,
      userAnswer: String(userAnswer),
      correct
    });
    return { correct, answer: q.answer, explanation: q.explanation };
  }

  /* ---- 考试模式：只记答案，不判分、不写记录 ---- */
  answer(userAnswer) {
    const q = this.current;
    if (!q) return null;
    this.examAnswers.set(q.id, String(userAnswer));
    return { saved: true };
  }

  /* ---- 交卷：统一判分 + 写答题记录（只记已作答的题，未答不计入答题量） ---- */
  grade() {
    if (this.graded) return this.result();
    for (const q of this.list) {
      const ua = this.examAnswers.get(q.id);
      if (ua == null || ua === '') continue;
      const correct = q.answer ? QuizSession.judge(q, ua) : false;
      this.answered.set(q.id, { userAnswer: ua, correct, q, answer: q.answer, explanation: q.explanation });
      DB.recordAdd({ questionId: q.id, bankId: q.bankId, userAnswer: String(ua), correct });
    }
    this.graded = true;
    return this.result();
  }

  /* ---- 成绩单 ---- */
  result() {
    const vals = [...this.answered.values()];
    const correct = vals.filter(v => v.correct).length;
    return {
      total: this.list.length,
      answered: vals.length,
      correct,
      wrong: vals.length - correct,
      unanswered: this.list.length - vals.length,
      acc: this.list.length ? Math.round(correct / this.list.length * 100) : 0,
      timeUsed: Math.max(0, Math.round((Date.now() - this.startTime) / 1000))
    };
  }

  /* ---- 未答或答错的题（交卷后速览 / 重做用） ---- */
  wrongList() {
    return this.list
      .map(q => ({ q, a: this.answered.get(q.id) }))
      .filter(x => !x.a || !x.a.correct)
      .map(x => ({ ...x, userAnswer: x.a ? x.a.userAnswer : (this.examAnswers.get(x.q.id) || null) }));
  }

  next() { this.index++; return !this.finished; }
  jump(i) { if (i >= 0 && i < this.list.length) this.index = i; }

  /* ---- 断点续做：序列化（只存 id 序列 + 进度，题目本身在库里） ---- */
  serialize() {
    return {
      ids: this.list.map(q => q.id),
      index: this.index,
      // 已答的题存 id->结果，恢复时从库里取题重建（否则续做后对错/成绩会丢）
      answered: [...this.answered.entries()].map(([qid, v]) => [qid, { userAnswer: v.userAnswer, correct: v.correct }]),
      exam: this.exam,
      minutes: this.minutes,
      deadline: this.deadline || 0,
      graded: this.graded,
      recite: !!this.recite,
      examAnswers: [...this.examAnswers.entries()]
    };
  }
  /* ---- 反序列化：查库重建 ---- */
  static async restore(data) {
    const qs = [];
    for (const id of data.ids) {
      const q = await DB.questionGet(id);
      if (q) qs.push(q);
    }
    const s = new QuizSession(qs, { shuffle: false, exam: data.exam, minutes: data.minutes, deadline: data.deadline });
    s.index = Math.min(data.index || 0, Math.max(0, qs.length - 1));
    s.graded = !!data.graded;
    s.recite = !!data.recite;
    for (const [qid, ua] of (data.examAnswers || [])) s.examAnswers.set(qid, ua);
    for (const [qid, v] of (data.answered || [])) {
      const q = qs.find(x => x.id === qid);
      if (q) s.answered.set(qid, { userAnswer: v.userAnswer, correct: v.correct, q, answer: q.answer, explanation: q.explanation });
    }
    return s;
  }
}

/* ---- 构建会话的辅助 ---- */
const QuizBuilder = {
  /** 从多个题库构建：filterType 筛题型；secKeys 筛章节（"bankId:secIdx"，空 = 全部章节） */
  async fromBanks(bankIds, { shuffle = false, filterType = 'all', secKeys = null, exam = false, minutes = 0 } = {}) {
    let qs = [];
    for (const id of bankIds) {
      const list = await DB.questionsByBank(id);
      qs.push(...list);
    }
    if (secKeys && secKeys.size) {
      qs = qs.filter(q => secKeys.has(q.bankId + ':' + (q.secIdx ?? '')));
    }
    if (filterType !== 'all') {
      // 支持组合："choice|answered" / "fill|answered" / "answered"
      const parts = String(filterType).split('|');
      if (parts.includes('answered')) qs = qs.filter(q => q.answer);
      if (parts.includes('choice')) qs = qs.filter(q => q.type === 'single' || q.type === 'multi' || q.type === 'judge');
      else if (parts.includes('fill')) qs = qs.filter(q => q.type === 'fill');
    }
    return new QuizSession(qs, { shuffle, exam, minutes });
  },

  /** 错题重做 */
  async wrongRedo() {
    const qs = await DB.wrongQuestions();
    return new QuizSession(qs, { shuffle: true, mode: 'wrong' });
  },

  /** 从指定题单重练（考试交卷后的错题重做等） */
  fromQuestions(questions, opts = {}) {
    return new QuizSession(questions, opts);
  }
};