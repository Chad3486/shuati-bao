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
    let list = opts.shuffle ? this._shuffle([...questions]) : [...questions];
    // v1.8.15 选项乱序：随机模式 = 题序 + 选项序一起打乱。
    // 只改会话内副本（题库原数据不动），答案字母同步换算；异常一律回退原题
    if (opts.shuffle) list = list.map(q => this._shuffleOptions(q));
    this.list = list;
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

  /* ---- 选项乱序（v1.8.15）----
     规则：仅单选/多选、选项 ≥3 个且有答案；「以上都对 / 上述都不对」类联动选项不打乱（语义会破）；
     返回浅拷贝题（options 新对象 + 换算后的 answer + _optPerm 旧字母→新字母映射），题库原数据不动；
     任何不确定（答案字母对不上选项等）都原样返回，保证答案永不因乱序而出错 */
  _shuffleOptions(q) {
    if (q.type !== 'single' && q.type !== 'multi') return q;
    if (!q.options || !q.answer) return q;
    const keys = Object.keys(q.options).sort();
    if (keys.length < 3) return q;                       // 对/错、A/B 两个选项打乱无意义
    const texts = keys.map(k => String(q.options[k] ?? ''));
    if (texts.some(t => /以上|上述|都不?对|都不?是|都正确|都错误|全部正确|全部错误/.test(t))) return q;
    const ansLetters = String(q.answer).toUpperCase().replace(/[^A-Z]/g, '');
    if (!ansLetters || [...ansLetters].some(c => !keys.includes(c))) return q;

    const order = this._shuffle([...keys.keys()]);       // order[j] = 新位置 j 的内容来自旧下标
    const mapping = new Map();                           // 旧字母 → 新字母
    keys.forEach((oldK, i) => mapping.set(oldK, keys[order[i]]));
    const copy = QuizSession.permuteQuestion(q, mapping);
    if (!copy) return q;                                 // 换算失败兜底：原题原样
    return copy;
  }

  /* 按 旧字母→新字母 映射生成题目副本（restore 续练复用）；校验失败返回 null。
     注意：options 新对象必须按新字母 A,B,C… 顺序插入——渲染层用 Object.keys 的插入顺序显示 */
  static permuteQuestion(q, mapping) {
    const keys = Object.keys(q.options || {}).sort();
    if (!keys.length || keys.some(k => !mapping.has(k))) return null;
    const news = keys.map(k => mapping.get(k));
    if (new Set(news).size !== keys.length) return null; // 必须是双射
    const newOptions = {};
    [...news].sort().forEach(nk => {
      const oldK = keys.find(k => mapping.get(k) === nk);
      newOptions[nk] = q.options[oldK];
    });
    const ansLetters = String(q.answer || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!ansLetters || [...ansLetters].some(c => !mapping.has(c))) return null;
    const newAnswer = [...ansLetters].map(c => mapping.get(c)).sort().join('');
    return { ...q, options: newOptions, answer: newAnswer, _optPerm: Object.fromEntries(mapping) };
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

  /* ---- 判分（学习模式与考试交卷共用） ---- */
  static judge(q, userAnswer) {
    if (q.type === 'fill') return QuizSession.checkFill(userAnswer, q.answer);
    /* v1.8.17：标准答案容错归一。旧版 replace(/[^A-Z]/g,'') 会把历史导入的
       「A（A. 可接受的危险）」洗成「AA」，用户选 A 永远判错 → 正确率虚低。
       现取答案开头第一段选项字母（自动跳过「答案：」前缀、括注原文、解析尾巴） */
    const norm = s => {
      const t = String(s || '').toUpperCase();
      // 判断题存的是文字答案（对/错/T/F）时归一成 A/B
      if (q.type === 'judge' && !/[A-B]/.test(t)) {
        if (/^(对|正确|√|✓|是|T|Y)/.test(t)) return 'A';
        if (/^(错|错误|×|✗|否|F|N)/.test(t)) return 'B';
      }
      let m = t.match(/^[^A-H]*([A-H]{1,5})/);
      if (m) return m[1].split('').sort().join('');
      // 括注全包裹型（「（A）（C）」）：去掉括号块后再取
      const stripped = t.replace(/[（(][^（）()]*[）)]/g, ' ');
      m = stripped.match(/[A-H]{1,5}/);
      return m ? m[0].split('').sort().join('') : '';
    };
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
      examAnswers: [...this.examAnswers.entries()],
      // 选项乱序映射（v1.8.15）：qid -> {旧字母:新字母}，恢复时原样套回，已答字母才不会错位
      optPerm: this.list.filter(q => q._optPerm).map(q => [q.id, q._optPerm])
    };
  }
  /* ---- 反序列化：查库重建 ---- */
  static async restore(data) {
    const permMap = new Map(data.optPerm || []);
    const qs = [];
    for (const id of data.ids) {
      const q = await DB.questionGet(id);
      if (!q) continue;
      // 套回上次会话的选项乱序（保证已答字母不错位）；套不上就原题，判分仍正确
      qs.push(permMap.has(id) ? (QuizSession.permuteQuestion(q, new Map(Object.entries(permMap.get(id)))) || q) : q);
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
