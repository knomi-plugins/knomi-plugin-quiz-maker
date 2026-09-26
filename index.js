'use strict'

/**
 * quiz-maker 内化阶段插件（v0.2）
 *
 * 核心：generate_cloze_quiz —— 从文档确定性生成"选择填空"题（零 LLM 依赖）：
 *   句子切分 → 关键术语识别 → 挖空 → 干扰项取自全文术语 → 闸1 质检（不入库直接开练）
 *   → 返回 start_practice 意图，内容区立即进入做题模式。
 * 每题强制 sourceSnippet（原文句子），入库经 ADR-102 校验（answer/去重），
 * 失败计入 rejected 并如实汇报——绝不产生占位题。
 *
 * 题式规范 v2（v0.6.0 起）：题干 = 挖空后的原句本身——不带题型前缀（「选择填空」）、
 * 不带出处（「（出自《…》）」）、不带「：」分隔。题型由做题卡片/题库页「类型」列表达，
 * 出处由题库页「来源」列（documentId → 文档标题）表达；做题会话标题携带文档名。
 */

const PLUGIN_ID = 'quiz-maker'

// 接地/质量闸：平台共享纯函数库注入（B1' T1-2，唯一权威实现在 electron/shared/plugin-stdlib，
// 经沙箱 knomi.stdlib 只读命名空间下发 + sha256 对账）。偏斜守卫：缺面（旧平台+新插件窗口）
// 时预检放行不阻断出题，宿主终检兜底；注入恢复后预检自动回归。禁止再持本地副本。
const std = (typeof knomi !== 'undefined' && knomi.stdlib) || null
const isGroundedIn = (std && std.grounding && std.grounding.isGroundedIn) || (() => true)
const qcQuestionBatch = (std && std.qc && std.qc.qcQuestionBatch) || ((list) => ({ passed: list, rejected: [] }))
const normalizeForQc = (std && std.qc && std.qc.normalizeForQc)
  || ((t) => { const m = String(t || '').toLowerCase().match(/[\p{L}\p{N}]/gu); return m ? m.join('') : '' })
const { matchInventoryQuestions } = require('./lib/match')

/** 模块级上下文：nav.entry 页数据方法（plugin:invoke 直调）运行于 activate 作用域外 */
let moduleCtx = null

/** CJK 词元与英文单词提取 */
function extractTerms(text) {
  const terms = new Set()
  for (const m of String(text).matchAll(/[\u4e00-\u9fff]{2,8}/g)) terms.add(m[0])
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9_-]{3,20}/g)) terms.add(m[0])
  return [...terms]
}

/** 判断句子是否适合出题 */
function usableSentence(s) {
  const t = s.trim()
  if (t.length < 15 || t.length > 120) return false
  if (/^[#\-\|>`!\[]/.test(t)) return false
  if (/^[0-9\s]+$/.test(t)) return false
  return true
}

/** 碎片词检测：含虚词/疑问词的连续段不是合格术语（如"事务就是要保证一""为什么你改了我还"） */
function isFragment(term) {
  return /[为什么怎么如何如果就是还要还能不是而是这个那个我们他们一个以及但是然后因此所以或者并且进行通过对于关于]/.test(term)
    || /[一|的|了|是]$/.test(term)
}

/** 从句子中挑一个可挖空的关键术语（优先在全文多次出现的真实概念词）。
 *  干扰项按全文出现频次优先——最常出现的概念最易混淆，避免按词序取词产生的「送分题」。 */
function pickTerm(sentence, globalTerms, termFreq) {
  const inSentence = extractTerms(sentence)
    .filter((t) => !isFragment(t) && !/^(这个|那个|我们|他们|可以|使用|进行|通过|对于|以及|一个|如果|因此|但是|然后|这些|那些)$/.test(t))
  const candidates = inSentence.filter((t) => {
    const occurrences = sentence.split(t).length - 1
    return occurrences === 1 && t.length >= 2
  })
  if (candidates.length === 0) return null
  // 优先选择在全文其他位置也出现的词（真实概念词会重复），单次出现的碎片降权
  const freq = (t) => globalTerms.includes(t) ? 0 : 1
  candidates.sort((a, b) => freq(a) - freq(b) || b.length - a.length)
  const term = candidates[0]
  const distractors = globalTerms
    .filter((t) => t !== term && !isFragment(t) && Math.abs(t.length - term.length) <= 4)
    .sort((a, b) => ((termFreq && termFreq.get(b)) || 0) - ((termFreq && termFreq.get(a)) || 0))
    .slice(0, 12)
  if (distractors.length < 3) return null
  return { term, distractors }
}

function shuffled(arr, seed) {
  const a = [...arr]
  let s = seed
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280
    const j = Math.floor((s / 233280) * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** FNV-1a 稳定哈希 → 出题种子（文档+当日派生：同日确定以保去重，跨日换题换序） */
function hashSeed(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= String(str).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) || 7
}

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 即时挖空出题（P2 核心引擎）：文档确定性挖空 → 闸1 质检 → 入库立即开练。
 *  2026-09-25 题库回流恢复（用户决策：练习复习是学习闭环核心）：题目经 insertQuestion 并入
 *  题库累积 SM-2 调度（重复题去重复用库内 id），作答双轨记账（question_attempts 题库轨 +
 *  practice_attempts 文档轨）。被 knomi-agent practice-tools 与本插件工具链消费 */
async function practiceInstant(args = {}) {
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 15)
  const docs = (await moduleCtx.getDocuments()) || []
  if (!docs.length) return { output: '', error: '知识库为空，请先投递碎片或添加文档' }
  let doc = null
  if (args.documentId) {
    doc = docs.find((d) => d.id === args.documentId) || null
    if (!doc) return { output: '', error: `未找到文档: ${args.documentId}` }
  } else if (args.documentPath) {
    const norm = String(args.documentPath).replace(/\\/g, '/').toLowerCase()
    doc = docs.find((d) => String(d.filePath || '').replace(/\\/g, '/').toLowerCase() === norm) || null
    if (!doc) return { output: '', error: `未找到文档: ${args.documentPath}` }
  } else {
    doc = [...docs].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
  }

  // ---- 库存题优先收割（v0.21.0，v9-T4 画像消费面）：目标文档画像 × 候选题来源文档画像
  // 确定性打分（同文档/概念重合/难度/盲答验证），高匹配库存题直接复用开练（不重复入库，
  // 作答照走题库轨 SM-2）；余量才生成新挖空——权威源题目质量优先于机械新生（ADR-103 v4）
  let reused = []
  try {
    const targetRows = (await moduleCtx.query(
      'SELECT profile_json AS profileJson, keywords_json AS keywordsJson FROM taxonomy_semantics WHERE doc_id = ?',
      [doc.id]
    )) || []
    const candidates = (await moduleCtx.query(
      `SELECT q.id, q.document_id AS documentId, d.file_path AS documentPath, d.title AS docTitle,
              q.type, q.question, q.options_json AS optionsJson, q.answer, q.explanation,
              q.source_snippet AS sourceSnippet, q.plugin_id AS pluginId, q.generator, q.verified,
              s.profile_json AS profileJson, s.keywords_json AS keywordsJson
       FROM questions q
       LEFT JOIN documents d ON d.id = q.document_id
       LEFT JOIN taxonomy_semantics s ON s.doc_id = q.document_id
         AND s.annotation_version = (SELECT MAX(annotation_version) FROM taxonomy_semantics)
       WHERE q.status = 'confirmed' AND q.document_id IS NOT NULL`
    )) || []
    reused = matchInventoryQuestions(
      { docId: doc.id, profileJson: targetRows[0]?.profileJson, keywordsJson: targetRows[0]?.keywordsJson },
      candidates,
    ).slice(0, count)
  } catch { /* 画像/库存查询失败降级为纯新生（不阻断出题） */ }
  const reuseCount = reused.length
  const remain = count - reuseCount

  let content = ''
  try { content = await moduleCtx.readFile(doc.filePath) } catch { content = '' }
  if (!content && remain > 0) return { output: '', error: `文档内容不可读: ${doc.filePath}` }

  // 即时挖空的内容加固（真机实证：清单/表格/emoji/双链型 Markdown 的残句会产出病句挖空题）
  const cleanSentence = (x) => String(x || '')
    .replace(/\[\[([^\]]*)\]\]/g, (_, inner) => {
      // wikilink 取显示别名（[[路径/别名]] 或 [[路径\别名]] 的最后一段）
      const parts = String(inner).split(/[\\/]/)
      return parts[parts.length - 1] || ''
    })
    .replace(/[✅❌⚠️🔥💡📌🎯🚀✨⭐️☑️✔️]/gu, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.、)\]]\s*/, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const isTermLike = (t) => {
    const n = normalizeForQc(t)
    if (n.length < 2 || n.length > 12) return false
    if (/[的了吗呢吧与和或是]$/.test(t) || /^[的与和或是]/.test(t)) return false
    return true
  }

  const globalTerms = [...new Set(extractTerms(content.replace(/---[\s\S]*?---/, '')))]
  const termFreq = new Map()
  for (const t of extractTerms(content.replace(/---[\s\S]*?---/, ''))) {
    termFreq.set(t, (termFreq.get(t) || 0) + 1)
  }
  // 种子含当日：同日同文档出题确定（可重复巩固），跨日自然换题换序
  const seedBase = hashSeed(`${doc.filePath}#${localDateStr()}#instant`)
  const sentences = shuffled(
    content
      .replace(/---[\s\S]*?---/, '')
      .replace(/```[\s\S]*?```/g, '')
      .split(/[。！？\n]+/)
      .map(cleanSentence)
      .map((x) => x.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim())
      .filter(usableSentence)
      .filter((x) => !/[\[\]]|基础技术\/|基础知识\//.test(x)) // 双链剥不净的残句直接跳过
      .filter((x) => (x.match(/[的了是与和着在很最就都又也并因此所以但如果]?[的了是与和着在]|能|会|应|需|可|将|向|从|把|被|为/g) || []).length >= 2), // 散文性：条目/标签堆砌行（规划清单）无可挖语境，宁缺毋滥
    seedBase + 107,
  )

  // 负样本（P2-Q）：曾差评的题不再重复出——差评关联的作答快照题干前 20 字为黑名单键
  let badQKeys = new Set()
  try {
    const badRows = (await moduleCtx.query(
      `SELECT a.question_snapshot AS snap FROM question_feedback f
       JOIN practice_attempts a ON a.id = f.attempt_id
       WHERE f.document_id = ? AND f.kind != 'good_question' AND a.question_snapshot IS NOT NULL`,
      [doc.id]
    )) || []
    badQKeys = new Set(badRows.map((b) => {
      try { return normalizeForQc(String(JSON.parse(b.snap).question || '')).slice(0, 20) } catch { return '' }
    }).filter(Boolean))
  } catch { /* 反馈查询失败不阻塞出题 */ }

  // 生成候选（接地校验防切片逻辑漂移）→ 闸1 规则质检 → 通过者直接组会话题
  const candidates = []
  const rejected = []
  let avoidedBad = 0
  let seed = seedBase
  for (const sentence of sentences) {
    if (candidates.length >= remain) break
    const pick = pickTerm(sentence, globalTerms, termFreq)
    if (!pick) { rejected.push('无可挖空的关键术语'); continue }
    if (!isTermLike(pick.term)) { rejected.push(`挖空词非术语形态:「${pick.term.slice(0, 14)}」`); continue }
    const candidateQuestion = sentence.replace(pick.term, '______')
    if (badQKeys.has(normalizeForQc(candidateQuestion).slice(0, 20))) { avoidedBad++; rejected.push('历史差评句不再出'); continue }
    if (!isGroundedIn(sentence, content)) { rejected.push('原文片段与原文不符'); continue }
    const options = shuffled([pick.term, ...pick.distractors.slice(0, 3)], seed += 13)
    candidates.push({
      type: 'single_choice',
      question: candidateQuestion,
      options,
      answer: pick.term,
      explanation: `原文：${sentence}`,
      sourceSnippet: sentence,
    })
  }
  const { passed, rejected: qcRejected } = qcQuestionBatch(candidates)
  for (const r of qcRejected) rejected.push(`${r.question.slice(0, 16)}…（${r.reasons[0]}）`)

  if (remain > 0 && passed.length === 0 && reuseCount === 0) {
    return { output: '', error: `未能从《${doc.title}》即时出题（扫描 ${sentences.length} 句，全部被拒: ${[...new Set(rejected)].slice(0, 3).join('；')}）` }
  }

  // 入库（2026-09-25 题库回流恢复）：每题经 insertQuestion 落题库（ADR-102 同文档去重），
  // 重复题复用库内真实 id 继续开练（回执披露）；真实 id 使作答回流题级 SM-2 调度
  const banked = []
  let dupCount = 0
  let insertFailed = 0
  for (const q of passed) {
    let result = null
    try {
      result = await moduleCtx.insertQuestion({
        documentId: doc.id,
        type: q.type,
        question: q.question,
        options: q.options,
        answer: q.answer,
        explanation: q.explanation,
        sourceSnippet: q.sourceSnippet,
        pluginId: PLUGIN_ID,
        generator: '即时挖空',
      })
    } catch { result = null }
    if (result && (result.created || result.duplicate) && result.id) {
      if (result.duplicate) dupCount++
      banked.push({ ...q, id: result.id })
    } else {
      insertFailed++
    }
  }
  // 复用已满（reuseCount>0）时零生成是正常路径，不报错——库存题直接开练
  if (banked.length === 0 && reuseCount === 0) {
    return { output: '', error: `未能从《${doc.title}》出题入库（${sentences.length} 句扫描，入库全部失败）` }
  }

  const questions = [
    // 库存匹配复用在前（质量优先：概念重合×难度匹配的权威源题目），新生挖空补余量
    ...reused.map(({ row }) => ({
      id: row.id,
      documentId: row.documentId,
      documentPath: row.documentPath || doc.filePath,
      type: row.type,
      question: row.question,
      options: (() => { try { return JSON.parse(row.optionsJson || '[]') } catch { return [] } })(),
      answer: row.answer,
      explanation: row.explanation,
      sourceSnippet: row.sourceSnippet,
      pluginId: row.pluginId || PLUGIN_ID,
      generator: row.generator || '库存题',
      reused: true,
    })),
    ...banked.map((q) => ({
      id: q.id,
      documentId: doc.id,
      documentPath: doc.filePath,
      type: q.type,
      question: q.question,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      sourceSnippet: q.sourceSnippet,
      pluginId: PLUGIN_ID,
      generator: '即时挖空',
    })),
  ]

  const qcCut = qcRejected.length
  const sameDocReused = reused.filter((x) => x.sameDoc).length
  const summary = [
    `✅ 即时组织 ${questions.length} 道题（来自《${doc.title}》${reuseCount ? `，库存匹配 ${reuseCount} 题直出` : ''}）：`,
    reuseCount > 0 ? `♻️ 库存匹配 ${reuseCount} 题（同文档 ${sameDocReused} · 概念重合跨文档 ${reuseCount - sameDocReused}）——画像打分复用权威源，未重复入库` : '',
    reuseCount < questions.length ? `🆕 新生成 ${questions.length - reuseCount} 道挖空题，已入库` : '',
    dupCount > 0 ? `🔁 ${dupCount} 题此前已生成过（去重复用库内题）` : '',
    avoidedBad > 0 ? `🚫 已避开 ${avoidedBad} 句历史差评句` : '',
    qcCut > 0 ? `🛡️ 闸1 拦截 ${qcCut} 题不合格候选（${qcRejected.slice(0, 2).map((r) => r.reasons[0]).join('；')}）` : '',
    insertFailed > 0 ? `⚠️ ${insertFailed} 题入库失败未开练（字段校验未过）` : '',
    '作答回流题库 SM-2 调度（题库页「今日复习」可见），同时按文档记账驱动文档复习节奏。'
  ].filter(Boolean).join('\n')

  return {
    output: summary,
    ui: {
      intent: 'start_practice',
      questions,
      title: `《${doc.title}》即时练习（${questions.length} 题${reuseCount ? `·库存匹配 ${reuseCount}` : ''}）`,
    },
  }
}

// ---- 题库页（2026-09-25 恢复：P3-S3b 曾随题库退役移除，用户决策恢复入口——
//      存量题库的浏览/复习/导出/导入/下架恢复管理面；P3 即时出题主链路不受影响） ----

/** 掌握度等级（体系感进阶：未作答 → 学习中 → 已掌握 → 精通；SM-2 repetition 口径） */
function masteryLevel(q) {
  if (q.status === 'retired') return '已下架'
  if (!q.attempts) return '未作答'
  if ((q.repetition || 0) >= 5) return '精通'
  if ((q.repetition || 0) >= 2) return '已掌握'
  return '学习中'
}

/** 筛选值归一（PackPage 契约，2026-09-26）：filters 多筛选传 { repo, type, status } 对象，
 *  旧 filter 单筛选传仓库名字符串。统一取仓库作用域（'' = 全部仓库） */
function filterRepoNameOf(arg) {
  if (arg && typeof arg === 'object') return String(arg.repo || '').trim()
  return String(arg || '').trim()
}

/** nav.entry 页数据入口（ADR-202 Phase 2 第二消费者）：题库一览，出题域数据无需 LLM。
 *  跨仓口径：getQuestions/getDocuments 均为全局面（题目不按仓分库，一次 SQL 跨仓混排）；
 *  仓库筛选（payload.filter 契约，2026-09-18）：PackPage 下拉切换即以 [仓库名] 重拉本方法——
 *  '' / 缺省 = 全部仓库；命中仓库名则行与计数均按该仓作用域（来源文档属仓或 repo_id 快照属仓）。
 *  题型/状态筛选（payload.filters 契约，2026-09-26）：对象传参 { repo, type, status }，
 *  题型按原值精确匹配、状态 confirmed/retired 二值，均客户端过滤（窗口内）。
 *  payload.action（PackPage 页级动作契约）：一键开始到期练习（当前页就地进入做题） */
async function pageQuestionBank(filterArg) {
  // 守卫：moduleCtx 在 activate 时注入；冷激活重拉的首个调用若早于 activate 完成会拿到 null——
  // 返回可重试的业务错误而非崩溃（2026-09-19 插件页偶发报错防御）
  if (!moduleCtx) return { error: '做题生成器正在激活，请稍后刷新重试' }
  let repos = []
  try { repos = (await moduleCtx.listRepositories()) || [] } catch { repos = [] }
  const wantedRepo = filterRepoNameOf(filterArg)
  const wantedType = (filterArg && typeof filterArg === 'object') ? String(filterArg.type || '').trim() : ''
  const wantedStatus = (filterArg && typeof filterArg === 'object') ? String(filterArg.status || '').trim() : ''
  const scopedRepo = wantedRepo ? repos.find((r) => r.name === wantedRepo) : null
  const all = (await moduleCtx.getQuestions({ limit: 500, repoId: scopedRepo ? scopedRepo.id : undefined })) || []
  // 题型/状态筛选（客户端，窗口内）：状态 '' = 全部，confirmed 反义排除 retired（兼容历史状态值）
  const filtered = all.filter((q) =>
    (!wantedType || q.type === wantedType) &&
    (!wantedStatus || (wantedStatus === 'retired' ? q.status === 'retired' : q.status !== 'retired')))
  let docs = []
  try { docs = (await moduleCtx.getDocuments()) || [] } catch { docs = [] }
  const repoNameById = new Map(repos.map((r) => [r.id, r.name]))
  const docById = new Map(docs.map((d) => [d.id, d]))
  const now = Date.now()
  const TYPE = { single_choice: '单选', multi_choice: '多选', true_false: '判断', fill_blank: '填空', ordering: '排序', short_answer: '简答', mixed: '混合', dictation: '听写' }
  const windowDue = all.filter((q) => q.status !== 'retired' && q.nextReviewAt && new Date(q.nextReviewAt).getTime() <= now).length
  // 权威计数（筛选时同仓作用域；全库口径；query 不可用时退回 500 窗口计数）
  let total = all.length
  let dueTotal = windowDue
  try {
    const scopeWhere = scopedRepo
      ? `WHERE (document_id IN (SELECT id FROM documents WHERE repo_id = ?) OR repo_id = ?)`
      : ''
    const scopeParams = scopedRepo ? [scopedRepo.id, scopedRepo.id] : []
    const rows = (await moduleCtx.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status != 'retired' AND next_review_at IS NOT NULL AND next_review_at != '' AND next_review_at <= ? THEN 1 ELSE 0 END) AS due
       FROM questions ${scopeWhere}`,
      [new Date().toISOString(), ...scopeParams]
    )) || []
    if (rows[0]) {
      total = Number(rows[0].total) || 0
      dueTotal = Number(rows[0].due) || 0
    }
  } catch { /* 保持窗口计数 */ }
  const rows = filtered.map((q) => {
    const doc = docById.get(q.documentId)
    const repoName = doc ? repoNameById.get(doc.repoId) : null
    const raw = doc ? (repoName ? `${repoName}·${doc.title || ''}` : String(doc.title || '')) : ''
    return {
      id: q.id,
      question: String(q.question || '').slice(0, 42) + (String(q.question || '').length > 42 ? '…' : ''),
      // 热身定位（A4）：确定性挖空题（plugin_id=quiz-maker）在类型列明确标注，与 LLM 深度题区分质量预期
      type: (TYPE[q.type] || q.type) + (q.pluginId === PLUGIN_ID ? '·热身' : ''),
      source: raw.length > 20 ? raw.slice(0, 20) + '…' : raw,
      docTitle: String(doc?.title || ''),
      mastery: masteryLevel(q),
      due: q.nextReviewAt && new Date(q.nextReviewAt).getTime() <= now ? '是' : '否',
      status: q.status === 'retired' ? '已下架' : '在库',
    }
  })
  // 题库健康度（北极星，2026-09-18 出题质量迭代）：差评率/验证占比/近 7·30 天新题正确率。
  // 拉取失败不阻塞页面（summary 缺省，表格照常渲染）
  const summary = await (async () => {
    try {
      const h = await moduleCtx.getQuestionBankHealth(scopedRepo ? scopedRepo.id : undefined)
      if (!h || !h.total) return ''
      const fmtRate = (v) => (v === null || v === undefined ? '—' : `${v}%`)
      const recentTxt = (h.recent || [])
        .map((r) => `近${r.days}天 ${fmtRate(r.accuracy)}（${r.questions} 题）`)
        .join(' · ')
      const eff = h.effect || {}
      const dist = h.cognitiveDist || {}
      const repair = eff.weakRepairRate != null ? `${eff.weakRepairRate}%（弱 ${eff.weakTotal}）` : '—（无薄弱 KP）'
      const ret7 = (eff.retention || []).find((r) => r.rate != null && r.pairs > 0) // 首个非空桶（数据常集中近期）
      const distTxt = `记忆 ${dist.memory || 0}/理解 ${dist.understanding || 0}/应用 ${dist.application || 0}${dist.untagged ? `/未标 ${dist.untagged}` : ''}`
      return `题库健康度：差评率 ${fmtRate(h.feedbackRate)} · 已验证 ${fmtRate(h.verifiedRate)} · 新题正确率 ${recentTxt} · 薄弱修复信号 ${repair}${ret7 && ret7.rate != null ? ` · 间隔保持（${ret7.bucket}）${ret7.rate}%` : ''} · 层级分布 ${distTxt}`
    } catch {
      return ''
    }
  })()
  return {
    title: `题库 · 共 ${total} 题` + (total > all.length ? `（显示最新 ${all.length}）` : '') + (scopedRepo ? ` · ${scopedRepo.name}` : '') + ((wantedType || wantedStatus) ? ` · 筛选 ${rows.length} 题` : ''),
    summary,
    // 状态色标（columns[].tones 契约，2026-09-26）：状态/掌握度/到期一眼可辨
    columns: [
      { key: 'question', label: '题目' },
      { key: 'type', label: '类型', width: 90 },
      { key: 'source', label: '来源', width: 150, ellipsis: true },
      { key: 'mastery', label: '掌握度', width: 90, tones: { 精通: 'geekblue', 已掌握: 'green', 学习中: 'orange' } },
      { key: 'due', label: '到期', width: 70, tones: { 是: 'volcano' } },
      { key: 'status', label: '状态', width: 80, tones: { 在库: 'green', 已下架: 'red' } },
    ],
    rows,
    // 多筛选器（payload.filters 契约，2026-09-26）：仓库（SQL 作用域）+ 题型/状态（客户端过滤），
    // 切换任一下拉即以 { repo, type, status } 对象重拉本方法
    filters: [
      { key: 'repo', label: '仓库', options: [{ value: '', label: '全部仓库' }, ...repos.filter((r) => r && r.name).map((r) => ({ value: r.name, label: r.name }))] },
      { key: 'type', label: '题型', options: [{ value: '', label: '全部题型' }, ...Object.entries(TYPE).map(([value, label]) => ({ value, label }))] },
      { key: 'status', label: '状态', options: [{ value: '', label: '全部状态' }, { value: 'confirmed', label: '在库' }, { value: 'retired', label: '已下架' }] },
    ],
    // 冲刺窗口内动作升级为「考前冲刺」（startBankPractice 同窗口判定，点击即清库）
    action: await (async () => {
      const sprint = await readSprintInfo()
      const label = sprint.active
        ? `考前冲刺（距 ${sprint.daysLeft} 天 · 共 ${total} 题）`
        // 复习语义回归（UX 走查 #1）+ 积压感知（#4）：到期>0 用「今日复习」承载 SM-2 心智；积压超单批(20)时披露本批量
        : (dueTotal > 0
          ? (dueTotal > 20 ? `今日复习 · 到期 ${dueTotal} 题（本批 20）` : `今日复习 · 到期 ${dueTotal} 题`)
          : '开始做题')
      return { label, method: 'startBankPractice' }
    })(),
    // 行点击单题开练（rowClick 契约）：点击题为首题，后续按 SM-2 调度序连练到期题（就地做题）
    rowClick: { method: 'practiceQuestion', paramKey: 'id' },
    // 行级动作（rowActions 数组契约 v8.1-T5）：在库行「来源」跳知识导航叶 +「下架」退出复习调度；
    // 已下架行「恢复」重新入库
    rowActions: [
      { label: '来源', method: 'locateSourceDoc', paramKey: 'id', when: { key: 'status', value: '在库' } },
      { label: '下架', method: 'retireBankQuestion', paramKey: 'id', when: { key: 'status', value: '在库' } },
      { label: '恢复', method: 'restoreBankQuestion', paramKey: 'id', when: { key: 'status', value: '已下架' } },
    ],
    // 学习统计四卡（学习 Tab 退役迁移，2026-09-20 计划：口径=practice:overview 同源——
    // 单查询取行、JS 内聚计算，避免多段 scope 参数拼接不可核验）
    stats: await (async () => {
      try {
        const scopeWhere = scopedRepo ? `WHERE (q.document_id IN (SELECT id FROM documents WHERE repo_id = ?) OR q.repo_id = ?)` : ''
        const scopeParams = scopedRepo ? [scopedRepo.id, scopedRepo.id] : []
        const rows = (await moduleCtx.query(
          `SELECT q.id, q.status, q.next_review_at,
                  COUNT(a.id) AS attempts,
                  SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS correct,
                  COUNT(CASE WHEN a.correct IS NOT NULL THEN 1 END) AS graded
           FROM questions q LEFT JOIN question_attempts a ON a.question_id = q.id
           ${scopeWhere} GROUP BY q.id`,
          scopeParams
        )) || []
        const now = Date.now()
        const acc = (r) => (Number(r.graded) > 0 ? Math.round((100 * Number(r.correct)) / Number(r.graded)) : null)
        const active = rows.filter((r) => r.status !== 'retired')
        return [
          { label: '题目池', value: rows.length },
          { label: '今日到期', value: active.filter((r) => r.next_review_at && new Date(r.next_review_at.replace(' ', 'T')).getTime() <= now).length },
          { label: '薄弱题', value: rows.filter((r) => Number(r.attempts) >= 2 && (acc(r) === null || acc(r) < 60)).length },
          { label: '已作答', value: rows.filter((r) => Number(r.attempts) > 0).length },
        ]
      } catch { return undefined }
    })(),
    // 次动作区（学习 Tab 退役迁移：导出/导入/出题指令，secondaryActions 契约 2026-09-20）；
    // 清空已下架（2026-09-26 用户反馈）为破坏性动作——confirm 声明由 PackPage Popconfirm 闸门先行
    secondaryActions: [
      { label: `题型偏好：${(await (async () => { try { return Boolean((await moduleCtx.getConfig()).practice_objective_first) } catch { return false } })()) ? '先客观题' : '全部题型'}`, method: 'toggleObjectiveFirst' },
      { label: '清空已下架', method: 'pagePurgeRetired', confirm: '将永久删除全部已下架题目（作答历史保留），不可恢复。确定清空？' },
      { label: '导出 JSON', method: 'exportBankJson' },
      { label: '导出 Anki', method: 'exportBankAnki' },
      { label: '导入题库', method: 'importBank', kind: 'file', accept: '.json' },
      { label: '复制出题指令', method: 'pageGeneratePrompt' },
      { label: '一键补题', method: 'pageExpandHandoff' },
      { label: '错题归因', method: 'pageMistakeAttribution' },
    ],
  }
}

/** nav.entry 行级动作（rowActions 契约 v8.1-T5 反馈⑤）：题目来源文档 → 知识导航叶深链。
 *  ui 意图 navigate（goRoute）→ /navigator?node=<来源文档标题>——题目出自哪个文档一眼可见 */
async function locateSourceDoc(questionId) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const all = (await moduleCtx.getQuestions({})) || []
  const q = all.find((x) => x.id === questionId)
  if (!q) return { error: `未找到题目: ${questionId}` }
  if (!q.documentId) return { error: '该题无来源文档（即时题请在做题界面看原文）' }
  const docs = (await moduleCtx.getDocuments()) || []
  const doc = docs.find((d) => d.id === q.documentId)
  const title = String(doc?.title || '').trim()
  if (!title) return { error: '来源文档不存在或已删除' }
  return { ui: { intent: 'navigate', path: `/navigator?node=${encodeURIComponent(title)}` } }
}

/** 错题归因页（v8.1-T5 反馈⑥）：correct=0 作答 → 来源文档标引词/概念确定性匹配 → 按概念分组。
 *  主信号=来源文档标引词（强信号，题干 LIKE 误中率高仅作补充）；未匹配错题单列（诚实披露）。
 *  数据全部只读（practice_attempts 自包含快照 + taxonomy_semantics 标引词），零 LLM 成本 */
async function pageMistakeAttribution() {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const wrong = (await moduleCtx.query(
    `SELECT document_id AS documentId, question_snapshot AS snapshot, COUNT(*) AS n
     FROM practice_attempts WHERE correct = 0
     GROUP BY document_id, question_snapshot ORDER BY n DESC LIMIT 500`
  )) || []
  if (wrong.length === 0) return { title: '错题归因', columns: [{ key: 'concept', label: '概念' }, { key: 'n', label: '错题数' }], rows: [], message: '暂无错题记录——保持住！' }
  // 文档 → 标引词（taxonomy_semantics v6+）
  const docIds = [...new Set(wrong.map((r) => r.documentId).filter(Boolean))]
  const kwRows = (await moduleCtx.query(
    `SELECT s.doc_id AS docId, s.keywords_json FROM taxonomy_semantics s
     WHERE s.annotation_version >= 6 AND s.doc_id IN (${docIds.map(() => '?').join(',')})`,
    docIds
  )) || []
  const kwByDoc = new Map(kwRows.map((r) => [r.docId, (() => { try { return JSON.parse(r.keywords_json || '{}') } catch { return {} } })()]))
  const norm = (x) => String(x || '').trim().toLowerCase().replace(/s+/g, '')
  // 概念分组（确定性）：错题文档标引词（领域/主题/技术/标签）为分组键
  const groups = new Map()
  const unmatched = []
  for (const r of wrong) {
    const kw = kwByDoc.get(r.documentId)
    const words = kw ? [kw.domain, kw.topic, kw.tech, ...(kw.tags || [])].map(norm).filter((w) => w.length >= 2) : []
    const snapshot = (() => { try { return JSON.parse(r.snapshot || '{}').question || '' } catch { return String(r.snapshot || '') } })()
    if (words.length === 0) { unmatched.push({ snapshot, n: Number(r.n) }); continue }
    for (const w of words) {
      const cur = groups.get(w) || { concept: w, n: 0, docs: new Set(), sample: snapshot }
      cur.n += Number(r.n)
      cur.docs.add(r.documentId)
      if (!cur.sample) cur.sample = snapshot
      groups.set(w, cur)
    }
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.n - a.n)
    .map((g) => ({ concept: g.concept, n: g.n, docCount: g.docs.size, sample: String(g.sample || '').slice(0, 30) }))
  if (unmatched.length > 0) rows.push({ concept: '（未匹配错题）', n: unmatched.reduce((a, b) => a + b.n, 0), docCount: new Set(unmatched.map((u) => u.documentId)).size, sample: String(unmatched[0]?.snapshot || '').slice(0, 30) })
  return {
    title: `错题归因 · ${wrong.length} 组错答（按概念分组）`,
    columns: [
      { key: 'concept', label: '概念 / 关键词' },
      { key: 'n', label: '错题数', width: 80 },
      { key: 'docCount', label: '涉及文档', width: 80 },
      { key: 'sample', label: '错题样例' },
    ],
    rows,
    rowAction: { label: '按概念复习', method: 'startConceptPractice', paramKey: 'concept', when: { key: 'concept', op: 'neq', value: '（未匹配错题）' } },
    // 归因页返回按钮：PackPage ?detail= 深链自带返回（v1 页契约），无需额外动作
  }
}

/** 按概念复习（rowAction）：概念名 → 命中该标引词的文档（按错题数序）→ practiceInstant 即时出题开练 */
async function startConceptPractice(conceptTitle) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const norm = (x) => String(x || '').trim().toLowerCase().replace(/s+/g, '')
  const kwRows = (await moduleCtx.query(
    `SELECT s.doc_id AS docId, s.keywords_json FROM taxonomy_semantics s WHERE s.annotation_version >= 6`
  )) || []
  const docIds = []
  for (const r of kwRows) {
    let kw = {}
    try { kw = JSON.parse(r.keywords_json || '{}') } catch { kw = {} }
    const words = [kw.domain, kw.topic, kw.tech, ...(kw.tags || [])].map(norm).filter(Boolean)
    if (words.includes(norm(conceptTitle))) docIds.push(r.docId)
  }
  if (docIds.length === 0) return { error: `未找到概念「${conceptTitle}」关联的文档` }
  const docs = (await moduleCtx.getDocuments()) || []
  const target = docs.find((d) => d.id === docIds[0])
  if (!target?.file_path) return { error: '概念关联文档不可达' }
  const caller = moduleCtx.invokePluginMethod || moduleCtx.invoke
  if (!caller) return { error: '插件互调通道不可用' }
  const r = await caller('quiz-maker', 'practiceInstant', [{ documentPath: target.file_path }])
  if (r && r.error) return { error: String(r.error) }
  return { ui: r?.ui, message: `概念「${conceptTitle}」关联 ${docIds.length} 篇文档，已对《${target.title || ''}》即时出题开练` }
}

/** nav.entry 行级动作（rowAction 契约，plugin:invoke 直调）：恢复已下架题，重新进入复习调度 */
async function restoreBankQuestion(questionId) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const all = (await moduleCtx.getQuestions({})) || []
  const q = all.find((x) => x.id === questionId)
  if (!q) return { error: `未找到题目: ${questionId}` }
  if (q.status !== 'retired') return { message: '该题不在「已下架」状态，无需恢复。' }
  await moduleCtx.restoreQuestion(questionId)
  return { message: '✅ 题目已恢复，重新进入复习调度。' }
}

/** nav.entry 行级动作（rowActions 契约，2026-09-26）：下架在库题，退出复习调度（可恢复） */
async function retireBankQuestion(questionId) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const all = (await moduleCtx.getQuestions({})) || []
  const q = all.find((x) => x.id === questionId)
  if (!q) return { error: `未找到题目: ${questionId}` }
  if (q.status === 'retired') return { message: '该题已是「已下架」状态。' }
  await moduleCtx.retireQuestion(questionId)
  return { message: '该题已下架，退出复习调度（可在「已下架」筛选中恢复）。' }
}

/** 清空已下架（2026-09-26 用户反馈；破坏性动作——confirm 闸门在 PackPage Popconfirm）：
 *  物理删除全部 retired 题，返回删除数供用户回执；在库题与作答历史不受影响 */
async function pagePurgeRetired() {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  let purged = 0
  try {
    purged = Number(await moduleCtx.purgeRetiredQuestions()) || 0
  } catch (err) {
    return { error: `清空失败: ${String((err && err.message) || err).slice(0, 120)}` }
  }
  return purged > 0
    ? { message: `🧹 已清空 ${purged} 道已下架题（不可恢复）；在库题目不受影响。` }
    : { message: '没有已下架的题目，无需清空。' }
}

// ---- 题库页次动作（学习 Tab 退役迁移，2026-09-20 计划：secondaryActions 契约） ----

/** Anki TSV 构建。⚠️ 格式权威副本：渲染层权威实现 core/anki.ts toAnkiTsv（沙箱不可 import
 *  渲染层 TS），格式漂移需双侧同步（同 quiz-grounding 副本纪律），禁止单侧演化 */
function toAnkiTsvCopy(questions) {
  const field = (t) => String(t ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>').trim()
  const frontOf = (q) => {
    const head = field(q.question)
    if (Array.isArray(q.options) && q.options.length > 0) {
      return `${head}<br>${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${field(o)}`).join('<br>')}`
    }
    if (q.type === 'true_false') return `${head}<br>（判断：正确 / 错误）`
    return head
  }
  const backOf = (q) => {
    const parts = [`答案：${field(q.answer)}`]
    if (q.explanation) parts.push(`解析：${field(q.explanation)}`)
    if (q.sourceSnippet) parts.push(`原文：${field(q.sourceSnippet)}`)
    return parts.join('<br><br>')
  }
  const tagsOf = (q) => {
    const docName = q.documentPath ? String(q.documentPath).replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '') : ''
    return ['knomi', q.type || 'question', docName].filter(Boolean).map((t) => String(t).replace(/\s+/g, '_')).join(' ')
  }
  const rows = (questions || []).filter((q) => q && q.question && q.answer)
    .map((q) => [frontOf(q), backOf(q), tagsOf(q)].map(field).join('\t'))
  return ['#separator:tab', '#html:true', ...rows].join('\n') + '\n'
}

/** 作用域题目全量（导出用；带 documentPath 供 Anki 标签与导入对称）。
 *  返回 { questions, scopeLabel }——scopeLabel 供导出回执交代范围（全部仓库 / 仓库「X」）；
 *  指定仓库名但查不到（已删除/改名）时报错而非静默退化为全量导出 */
async function bankQuestionsForExport(filterArg) {
  const filterRepoName = filterRepoNameOf(filterArg)
  let repos = []
  try { repos = (await moduleCtx.listRepositories()) || [] } catch { repos = [] }
  const wanted = String(filterRepoName || '').trim()
  const scoped = wanted ? repos.find((r) => r.name === wanted) : null
  if (wanted && !scoped) return { error: `未找到仓库「${wanted}」，无法按此范围导出` }
  const all = (await moduleCtx.getQuestions({ limit: 500, repoId: scoped ? scoped.id : undefined })) || []
  let docs = []
  try { docs = (await moduleCtx.getDocuments()) || [] } catch { docs = [] }
  const docById = new Map(docs.map((d) => [d.id, d]))
  const questions = all.map((q) => {
    let options = q.options
    if (!Array.isArray(options) && typeof q.optionsJson === 'string' && q.optionsJson) {
      try { options = JSON.parse(q.optionsJson) } catch { options = undefined }
    }
    const doc = docById.get(q.documentId)
    return {
      id: q.id,
      documentId: q.documentId,
      documentPath: doc ? doc.filePath : undefined,
      type: q.type,
      question: q.question,
      options: Array.isArray(options) ? options.map(String) : undefined,
      answer: q.answer,
      explanation: q.explanation || undefined,
      sourceSnippet: q.sourceSnippet || undefined,
      status: q.status,
      pluginId: q.pluginId || PLUGIN_ID,
    }
  })
  return { questions, scopeLabel: wanted ? `仓库「${wanted}」` : '全部仓库' }
}

async function exportBankJson(filterArg) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const filterRepoName = filterRepoNameOf(filterArg)
  const { questions, scopeLabel, error } = await bankQuestionsForExport(filterRepoName)
  if (error) return { error }
  if (questions.length === 0) return { error: `当前范围（${scopeLabel}）没有可导出的题目` }
  const payload = { app: 'knomi', type: 'question-bank', exportedAt: new Date().toISOString(), questions }
  const stamp = new Date().toISOString().slice(0, 10)
  return {
    message: `已导出 ${questions.length} 道题（${scopeLabel}）`,
    download: { filename: `knomi-题库-${stamp}.json`, content: JSON.stringify(payload, null, 2), mime: 'application/json' },
  }
}

async function exportBankAnki(filterArg) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const filterRepoName = filterRepoNameOf(filterArg)
  const { questions, scopeLabel, error } = await bankQuestionsForExport(filterRepoName)
  if (error) return { error }
  if (questions.length === 0) return { error: `当前范围（${scopeLabel}）没有可导出的题目` }
  const stamp = new Date().toISOString().slice(0, 10)
  return {
    message: `已导出 ${questions.length} 道题（${scopeLabel}）`,
    download: { filename: `knomi-anki-${stamp}.txt`, content: toAnkiTsvCopy(questions), mime: 'text/plain' },
  }
}

async function importBank(content, filename) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  let parsed
  try { parsed = JSON.parse(String(content || '')) } catch { return { error: 'JSON 解析失败：不是有效的题库文件' } }
  const questions = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.questions) ? parsed.questions : [])
  if (questions.length === 0) return { error: '文件中没有题目（需要数组或 {questions:[...]}）' }
  let docs = []
  try { docs = (await moduleCtx.getDocuments()) || [] } catch { docs = [] }
  const docIds = new Set(docs.map((d) => d.id))
  let imported = 0
  let duplicates = 0
  let skipped = 0
  for (const q of questions) {
    if (!q || !q.question || !q.answer || !q.sourceSnippet || !q.documentId || !docIds.has(q.documentId)) { skipped++; continue }
    try {
      const r = await moduleCtx.insertQuestion({
        documentId: q.documentId,
        type: ['single_choice', 'multi_choice', 'true_false', 'fill_blank', 'ordering', 'short_answer', 'mixed'].includes(q.type) ? q.type : 'single_choice',
        question: String(q.question),
        options: Array.isArray(q.options) ? q.options.map(String) : undefined,
        answer: String(q.answer),
        explanation: q.explanation ? String(q.explanation) : undefined,
        sourceSnippet: String(q.sourceSnippet),
        pluginId: 'quiz-import',
      })
      if (r.created) imported++
      else if (r.duplicate) duplicates++
      else skipped++
    } catch { skipped++ }
  }
  const name = filename ? `（${filename}）` : ''
  return { message: `✅ 导入完成${name}：新增 ${imported}，重复 ${duplicates}，跳过 ${skipped}` }
}

/** 复制出题指令：未覆盖知识点（0 题挂接）→ 出题官话术入剪贴板（不直连 agent——pack 页与 agent 解耦） */
async function pageGeneratePrompt(filterArg) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const filterRepoName = filterRepoNameOf(filterArg)
  let kps = []
  try { kps = (await moduleCtx.getKnowledgePoints()) || [] } catch { kps = [] }
  const all = (await moduleCtx.getQuestions({ limit: 500 })) || []
  const kpQ = new Map()
  for (const q of all) if (q.knowledgePointId) kpQ.set(q.knowledgePointId, (kpQ.get(q.knowledgePointId) || 0) + 1)
  const uncovered = kps.filter((k) => !kpQ.get(k.id)).slice(0, 8)
  if (uncovered.length === 0) return { message: '所有知识点都有题目覆盖，无需补题。' }
  const hint = uncovered.map((k) => `「${k.title}」`).join('、')
  return {
    clipboard: `这套文档还有 ${uncovered.length} 个知识点没出过题：${hint}。请针对这些知识点生成练习题并直接开始做题`,
    message: '出题指令已复制，粘贴给小诺即可开始出题',
  }
}

/** 到期题字段映射（与 start_practice_session 同构：optionsJson 反序列化、来源/知识点补充） */
function toPracticeQuestion(q, docPathById) {
  let options = q.options
  if (!Array.isArray(options) && typeof q.optionsJson === 'string' && q.optionsJson) {
    try { options = JSON.parse(q.optionsJson) } catch { options = undefined }
  }
  return {
    id: q.id,
    documentId: q.documentId,
    documentPath: docPathById.get(q.documentId) || undefined,
    knowledgePointId: q.knowledgePointId || null,
    knowledgePointTitle: q.knowledgePointTitle || null,
    type: q.type,
    question: q.question,
    options: Array.isArray(options) ? options.map((o) => String(o)) : undefined,
    answer: q.answer,
    explanation: q.explanation || undefined,
    sourceSnippet: q.sourceSnippet || undefined,
    pluginId: q.pluginId || PLUGIN_ID,
    verified: Number(q.verified) === 1,
    generator: q.generator || undefined,
    createdAt: q.createdAt || undefined,
    cognitiveLevel: q.cognitiveLevel || undefined,
  }
}

/** 到期集 SQL 直取（startBankPractice / practiceQuestion 共用权威源）：
 *  SM-2 调度序（next_review_at 升序——最久到期优先），全库口径不受 500 行展示窗口截断 */
async function fetchDueRows(limit) {
  return (await moduleCtx.query(
    `SELECT q.id, q.document_id AS documentId, q.knowledge_point_id AS knowledgePointId, q.type, q.question,
            q.options_json AS optionsJson, q.answer, q.explanation, q.source_snippet AS sourceSnippet, q.plugin_id AS pluginId, q.verified, q.generator, q.created_at AS createdAt, q.cognitive_level AS cognitiveLevel
     FROM questions q
     WHERE q.status != 'retired' AND q.next_review_at IS NOT NULL AND q.next_review_at != '' AND q.next_review_at <= ?
     ORDER BY q.next_review_at
     LIMIT ${Math.min(Math.max(Number(limit) || 20, 1), 20)}`,
    [new Date().toISOString()]
  )) || []
}

/** 冲刺窗口判定已收敛宿主 studyRhythm() 单一权威（2026-09-23 节奏计划，readSprintInfo 经其消费）。 */
async function readSprintInfo() {
  // 冲刺窗口判定已收敛宿主 studyRhythm() 单一权威（2026-09-23 节奏计划）：原裸 SQL 跨读
  // study-reminder plugin_kv + sprintInfo 双包镜像一并删除（ rhythms 语义含 sprint_days=0=仅考试当天）
  if (!moduleCtx) return { active: false }
  try {
    return (await moduleCtx.studyRhythm()).sprint
  } catch {
    return { active: false }
  }
}

/** 单题 SQL 直取（按 id，不受展示窗口截断） */
async function fetchQuestionById(id) {
  const rows = (await moduleCtx.query(
    `SELECT q.id, q.document_id AS documentId, q.knowledge_point_id AS knowledgePointId, q.type, q.question,
            q.options_json AS optionsJson, q.answer, q.explanation, q.source_snippet AS sourceSnippet, q.plugin_id AS pluginId, q.verified, q.generator, q.created_at AS createdAt, q.cognitive_level AS cognitiveLevel
     FROM questions q WHERE q.id = ?`,
    [id]
  )) || []
  return rows[0] || null
}

/** nav.entry 页级动作（payload.action 契约，plugin:invoke 直调）：到期题一键开练；
 *  冲刺窗口内升级为「考前清库」——全部在库题（到期优先：NULL 立即到期最前 + next_review_at 升序），
 *  上限 40（考试冲刺容量），SM-2 调度本身不动（清库作答后照常回流间隔）。
 *  到期集经 ctx.query 直取（全库权威口径，不受 500 行展示窗口截断）；query 不可用退回窗口过滤。
 *  返回 { message } 或 { message, ui }——ui 交中枢意图分发器进入做题视图（与即时出题同链路） */
async function startBankPractice() {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const sprint = await readSprintInfo()
  let due = []
  try {
    if (sprint.active) {
      due = (await moduleCtx.query(
        `SELECT q.id, q.document_id AS documentId, q.knowledge_point_id AS knowledgePointId, q.type, q.question,
                q.options_json AS optionsJson, q.answer, q.explanation, q.source_snippet AS sourceSnippet, q.plugin_id AS pluginId, q.verified, q.generator, q.created_at AS createdAt, q.cognitive_level AS cognitiveLevel
         FROM questions q
         WHERE q.status != 'retired'
         ORDER BY (q.next_review_at IS NULL) DESC, q.next_review_at
         LIMIT 40`,
      )) || []
    } else {
      due = await fetchDueRows(20)
    }
  } catch {
    const all = (await moduleCtx.getQuestions({ limit: 500 })) || []
    const now = Date.now()
    due = all.filter((q) => q.status !== 'retired' && q.nextReviewAt && new Date(q.nextReviewAt).getTime() <= now).slice(0, 20)
  }
  if (due.length === 0) {
    return { message: '今日无到期题目。可对小诺说「根据文档出题」生成新练习，本题库中的在库题也会按期进入复习。' }
  }
  let docs = []
  try { docs = (await moduleCtx.getDocuments()) || [] } catch { docs = [] }
  const docPathById = new Map(docs.map((d) => [d.id, d.filePath]))
  if (sprint.active) {
    const questions = due.map((q) => toPracticeQuestion(q, docPathById))
    return {
      message: `距考试 ${sprint.daysLeft} 天，考前清库：已就绪全部在库题中的前 ${questions.length} 题（到期优先）。`,
      ui: { intent: 'start_practice', questions, title: `考前冲刺 · 距考试 ${sprint.daysLeft} 天（${questions.length} 题）` },
    }
  }
  // 题型偏好（UX 走查 #5）：objective_first 开启时客观题前置（降低简答打头挫败感；默认关闭=全题型按调度序）
  let objectiveFirst = false
  try { objectiveFirst = Boolean((await moduleCtx.getConfig()).practice_objective_first) } catch { objectiveFirst = false }
  const OBJECTIVE = new Set(['single_choice', 'multi_choice', 'true_false'])
  if (objectiveFirst) {
    due = [...due.filter((q) => OBJECTIVE.has(q.type)), ...due.filter((q) => !OBJECTIVE.has(q.type))]
  }
  const questions = due.slice(0, 20).map((q) => toPracticeQuestion(q, docPathById))
  const prefNote = objectiveFirst && questions.some((q) => !OBJECTIVE.has(String(q.type))) ? '（已按你的偏好把客观题排在前）' : ''
  return {
    message: `已就绪 ${questions.length} 道到期题，开始练习。${prefNote}`,
    ui: { intent: 'start_practice', questions, title: `到期复习（${questions.length} 题）` },
  }
}

/** 题型偏好切换（secondaryActions，UX 走查 #5）：读-翻-写 practice_objective_first 配置 */
async function toggleObjectiveFirst() {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  let cur = false
  try { cur = Boolean((await moduleCtx.getConfig()).practice_objective_first) } catch { cur = false }
  const next = !cur
  await moduleCtx.setConfig({ practice_objective_first: next })
  return { message: `题型偏好已切换为「${next ? '先客观题' : '全部题型'}」——下次开始做题生效。` }
}

// ---- 补题选取器（批次 A，2026-09-25 迭代计划 §2；Phase 2 题源雷达共用） ----

const EXPAND_COOLDOWN_MS = 7 * 86400000
const EXPAND_SECTION_MAX = 2400
const EXPAND_BUDGET = 6000

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

/** 未覆盖/薄弱知识点 TopN + 材料支撑闸 + 7 天冷却（plugin_kv expand 命名空间）。
 *  被 knomi-agent expand_question_bank 经 invokePluginMethod 调用；args.mark=false 为 dry-run（探针用，不写冷却）。
 *  H2 教训闸：KP 标题未命中宿主文档内容（正文或标题行）= 无材料支撑，跳过不产出——绝不造贴标签题 */
async function selectExpansionTargets(args = {}) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  // 清偿保险丝（批次 D-5，教育评审缺口 2）：到期积压超过近 7 天日均作答 ×2 → 先清偿再补题
  try {
    const rhythm = await moduleCtx.studyRhythm()
    const fuse = rhythm && rhythm.backlogFuse
    if (fuse && fuse.tripped) {
      return { error: `复习债超限：到期 ${fuse.dueCount} 题 > 清偿能力（日均 ${fuse.dailyAvg} 题 × 2 = ${fuse.threshold}）——请先完成「今日复习」清偿积压，再补新题` }
    }
  } catch { /* 节奏通道不可用不阻塞（向后兼容旧宿主/测试桩） */ }
  const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 3) // D4：单次 ≤3 KP
  const uncovered = (await moduleCtx.query(
    `SELECT kp.id, kp.title, kp.document_id AS documentId, kp.created_at
     FROM knowledge_points kp
     LEFT JOIN questions q ON q.knowledge_point_id = kp.id
     WHERE q.id IS NULL
     ORDER BY kp.created_at
     LIMIT 60`
  )) || []
  const weak = (await moduleCtx.query(
    `SELECT kp.id, kp.title, kp.document_id AS documentId,
            COUNT(a.id) AS attempts,
            SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS correctCount
     FROM knowledge_points kp
     JOIN questions q ON q.knowledge_point_id = kp.id
     LEFT JOIN question_attempts a ON a.question_id = q.id
     WHERE q.status != 'retired'
     GROUP BY kp.id
     HAVING COUNT(a.id) >= 2 AND SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) * 100 < COUNT(a.id) * 60
     ORDER BY kp.created_at
     LIMIT 60`
  )) || []
  // 权威总数（COUNT 全量口径，列表查询仅取前 60 供选取——超 60 时 coverage 不失真）
  let uncoveredTotal = uncovered.length
  let weakTotal = weak.length
  try {
    const c1 = (await moduleCtx.query(
      `SELECT COUNT(*) AS n FROM knowledge_points kp
       LEFT JOIN questions q ON q.knowledge_point_id = kp.id
       WHERE q.id IS NULL`
    )) || []
    if (c1[0] && c1[0].n != null) uncoveredTotal = Number(c1[0].n) || 0
  } catch { /* 保持列表口径 */ }
  try {
    const c2 = (await moduleCtx.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT kp.id
         FROM knowledge_points kp
         JOIN questions q ON q.knowledge_point_id = kp.id
         LEFT JOIN question_attempts a ON a.question_id = q.id
         WHERE q.status != 'retired'
         GROUP BY kp.id
         HAVING COUNT(a.id) >= 2 AND SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) * 100 < COUNT(a.id) * 60
       )`
    )) || []
    if (c2[0] && c2[0].n != null) weakTotal = Number(c2[0].n) || 0
  } catch { /* 保持列表口径 */ }

  let docs = []
  try { docs = (await moduleCtx.getDocuments()) || [] } catch { docs = [] }
  const docById = new Map(docs.map((d) => [d.id, d]))

  const candidates = [
    ...uncovered.map((kp) => ({ ...kp, reason: 'uncovered' })),
    ...weak.map((kp) => ({ ...kp, reason: 'weak' })),
  ]
  const now = Date.now()
  const targets = []
  const skipped = []
  let skippedCooldown = 0
  let skippedNoMaterial = 0
  for (const kp of candidates) {
    if (targets.length >= limit) break
    // 7 天冷却（防重复触发；选中式记录——生成失败也冷却，宁缓勿轰炸）
    let lastAt = ''
    try { lastAt = String((await moduleCtx.storage.get('expand', 'kp:' + kp.id)) || '') } catch { lastAt = '' }
    if (lastAt && now - new Date(lastAt).getTime() < EXPAND_COOLDOWN_MS) {
      skippedCooldown++
      skipped.push({ kpId: kp.id, kpTitle: kp.title, reason: 'cooldown' })
      continue
    }
    // 材料支撑闸（H2）：宿主文档可读 + KP 标题命中正文或标题行
    const doc = docById.get(kp.documentId)
    if (!doc) { skippedNoMaterial++; skipped.push({ kpId: kp.id, kpTitle: kp.title, reason: '宿主文档不存在' }); continue }
    let content = ''
    try { content = (await moduleCtx.readFile(doc.filePath)) || '' } catch { content = '' }
    if (!content) { skippedNoMaterial++; skipped.push({ kpId: kp.id, kpTitle: kp.title, reason: '宿主文档不可读' }); continue }
    const nTitle = normText(kp.title)
    if (nTitle.length < 2) { skippedNoMaterial++; skipped.push({ kpId: kp.id, kpTitle: kp.title, reason: 'KP 标题过短' }); continue }
    const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => normText(m[1]))
    const inBody = normText(content).includes(nTitle)
    const inHeading = headings.some((h) => h.length >= 2 && (h.includes(nTitle) || nTitle.includes(h)))
    if (!inBody && !inHeading) { skippedNoMaterial++; skipped.push({ kpId: kp.id, kpTitle: kp.title, reason: 'KP 标题未命中宿主文档（无材料支撑）' }); continue }
    // 分节取材：命中标题的 H2 节优先，否则取文首节（预算内）
    const rawSections = content.split(/^## /m).map((s) => s.trim()).filter((s) => s.length > 4)
    const hitSections = rawSections.filter((s) => normText(s).includes(nTitle))
    const picked = (hitSections.length > 0 ? hitSections : rawSections).slice(0, 4)
    const sections = []
    let budget = EXPAND_BUDGET
    for (let s of picked) {
      if (s.length > EXPAND_SECTION_MAX) s = s.slice(0, EXPAND_SECTION_MAX) + '…'
      if (budget - s.length <= 0) break
      budget -= s.length
      sections.push(s)
    }
    if (sections.length === 0) { skippedNoMaterial++; skipped.push({ kpId: kp.id, kpTitle: kp.title, reason: '可截取材料为空' }); continue }
    targets.push({
      kpId: kp.id,
      kpTitle: kp.title,
      documentId: kp.documentId,
      documentPath: doc.filePath,
      documentTitle: doc.title || '',
      sections,
      reason: kp.reason,
    })
  }
  if (args.mark !== false) {
    for (const t of targets) {
      try { await moduleCtx.storage.set('expand', 'kp:' + t.kpId, new Date().toISOString()) } catch { /* 冷却记录失败不阻塞 */ }
    }
  }
  return {
    coverage: { uncoveredTotal, weakTotal, selected: targets.length, skippedNoMaterial, skippedCooldown },
    targets,
    skipped: skipped.slice(0, 10),
  }
}

/** 清除补题冷却（批次 A 探针可重入支撑，T10：写型探针必须可清理自身副作用）。
 *  冷却键只为「未覆盖+薄弱候选」而写——按同一候选全集逐键删除即可全覆盖 */
async function clearExpansionCooldown() {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  const kpLists = (await Promise.all([
    moduleCtx.query(`SELECT kp.id FROM knowledge_points kp LEFT JOIN questions q ON q.knowledge_point_id = kp.id WHERE q.id IS NULL`),
    moduleCtx.query(`SELECT DISTINCT kp.id FROM knowledge_points kp JOIN questions q ON q.knowledge_point_id = kp.id WHERE q.status != 'retired'`),
  ]).then(([a, b]) => [...a, ...b]).catch(() => [])) || []
  let cleared = 0
  for (const kp of kpLists) {
    try { await moduleCtx.storage.delete('expand', 'kp:' + kp.id); cleared++ } catch { /* 键不存在则忽略 */ }
  }
  return { message: `已清除 ${cleared} 个候选 KP 的补题冷却记录` }
}

/** 一键补题（批次 A 1-5）：agent_handoff 意图预填补题指令（复用 FR-124 到达即开工模式；
 *  PackPage handleActionResult 统一分发 ui 意图 → 编辑器停靠 + 新会话自动发送） */
async function pageExpandHandoff() {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  return {
    message: '已交给小诺补题（新会话将自动发送补题指令）',
    ui: {
      intent: 'agent_handoff',
      message: '请根据知识库未覆盖的知识点补题：调用 expand_question_bank 选取目标，按返回的任务书逐知识点委派「出题官」出题，最后用 generate_questions 入库（每题必带 knowledgePointTitle 与 documentId，sourceSnippet 逐字摘自任务书材料）。',
    },
  }
}

/** nav.entry 行点击动作（payload.rowClick 契约，plugin:invoke 直调）：单题开练。
 *  出题序定论（与 startBankPractice 同序）：点击题为第 1 题，后续按 SM-2 调度序连练到期题
 *  （next_review_at 升序，最久到期优先；确定性出题，非随机——防背题由选项洗牌承担），
 *  排除点击题防重复、排除已下架题，连练至多 20 题。 */
async function practiceQuestion(questionId) {
  if (!moduleCtx) return { error: '做题生成器未激活' }
  let first = null
  try {
    first = await fetchQuestionById(questionId)
  } catch {
    first = null
  }
  if (!first) {
    const all = (await moduleCtx.getQuestions({ limit: 500 })) || []
    first = all.find((q) => q.id === questionId) || null
  }
  if (!first) return { error: `未找到题目: ${questionId}` }
  let rest = []
  try { rest = (await fetchDueRows(19)).filter((q) => q.id !== first.id) } catch { rest = [] }
  let docs = []
  try { docs = (await moduleCtx.getDocuments()) || [] } catch { docs = [] }
  const docPathById = new Map(docs.map((d) => [d.id, d.filePath]))
  const questions = [first, ...rest].map((q) => toPracticeQuestion(q, docPathById))
  return {
    message: questions.length > 1
      ? `单题已就绪，后续按复习调度连练到期 ${rest.length} 题。`
      : '单题已就绪，开始练习。',
    ui: {
      intent: 'start_practice',
      questions,
      title: questions.length > 1 ? `单题开始 · 到期连练（共 ${questions.length} 题）` : '单题练习',
    },
  }
}

module.exports = {
  id: PLUGIN_ID,
  name: '做题生成器',
  version: '0.20.0',
  description: '内化阶段：出题官角色（LLM 深度出题，接地校验+盲答验证双闸门）+ 确定性即时挖空题，入库立即开练（作答双轨记账）+ 题库页（题库浏览/复习/导出/恢复）',

  activate(context) {
    moduleCtx = context
    // generate_quiz（LLM 深度出题入口，2026-09-18 v2）：按 H2 分节喂料（替代原"前 3000 字符"截断），
    // 携带知识点锚点与薄弱点信号（个性化：哪里弱出哪里），并指引主 agent 委派「出题官」专家出题。
    // 出题官经 agent.preset 贡献声明（本插件 manifest），透明默认生效——用户无需选择角色。
    context.registerAgentTool(
      {
        name: 'generate_quiz',
        description: '读取知识库文档并把内容结构化返回给 Agent（LLM）：按 H2 分节提供原文材料 + 知识点锚点 + 薄弱点信号，并给出出题任务书。应优先把材料委派给「出题官」专家（launch_subagent type=preset, preset=出题官）出题，出题官不可用时你按任务书直接出题。题目生成后调用 generate_questions（generator=出题官，过接地校验+盲答验证双闸门，入库进 SM-2 复习闭环并开启做题会话）。需要高质量深度出题时使用；快速热身挖空可经 start_practice_session 指定文档（即时挖空引擎）。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '主题关键词，用于筛选文档' },
            count: { type: 'number', description: '期望题数，默认 5' }
          }
        }
      },
      async (args) => {
        const docs = (await context.getDocuments()) || []
        const keyword = String(args.topic || '').toLowerCase()
        const matched = docs
          .filter((d) => !keyword || String(d.title || '').toLowerCase().includes(keyword) || String(d.filePath || '').toLowerCase().includes(keyword))
          .slice(0, 3)
        if (matched.length === 0) return { output: '', error: `没有找到与「${args.topic || '任何主题'}」相关的文档` }
        const wantCount = Math.min(Math.max(Number(args.count) || 5, 1), 15)

        // 分节喂料：按 H2 切节，每节独立成材料块（替代 3000 字符一刀截断——尾半篇内容此前从不可考）
        const SECTION_MAX = 2400
        let materialBudget = 12000
        const documents = []
        for (const d of matched) {
          if (materialBudget <= 0) break
          let content = ''
          try { content = (await context.readFile(d.filePath)) || '' } catch { content = '' }
          if (!content) continue
          const sections = content
            .split(/^## /m)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => (s.length > SECTION_MAX ? s.slice(0, SECTION_MAX) + '…' : s))
          const kept = []
          for (const s of sections) {
            if (materialBudget - s.length <= 0) break
            materialBudget -= s.length
            kept.push(s)
          }
          // 知识点锚点（已提取的知识点优先作为考点锚）
          let knowledgePoints = []
          try { knowledgePoints = ((await context.getKnowledgePoints(d.id)) || []).map((k) => k.title).filter(Boolean).slice(0, 10) } catch { knowledgePoints = [] }
          documents.push({ documentId: d.id, documentPath: d.filePath, title: d.title, sections: kept, knowledgePoints })
        }
        if (documents.length === 0) return { output: '', error: '所选文档内容均不可读' }

        // 薄弱点信号（个性化出题：学习档案同口径——正确率<60% 且作答 ≥2 次）
        const weakPoints = []
        try {
          const rows = (await context.query(
            `SELECT q.id, q.question, q.document_id AS documentId, d.title AS documentTitle,
                    COUNT(a.id) AS attempts,
                    COALESCE(SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END), 0) AS correctCount
             FROM questions q
             LEFT JOIN documents d ON d.id = q.document_id
             LEFT JOIN question_attempts a ON a.question_id = q.id
             WHERE q.status != 'retired' AND d.id IN (${documents.map(() => '?').join(',')})
             GROUP BY q.id HAVING attempts >= 2 AND correctCount * 100 < attempts * 60
             LIMIT 5`,
            documents.map((d) => d.documentId)
          )) || []
          for (const r of rows) {
            weakPoints.push({ documentTitle: r.documentTitle || '', question: String(r.question || '').slice(0, 60) })
          }
        } catch { /* 薄弱点信号缺失不阻塞出题 */ }

        const brief = [
          `出题任务书（共 ${wantCount} 题）：`,
          '1. 答案先行：每题先从材料摘出唯一可考要点作为答案，再针对它构造题干；',
          '2. sourceSnippet 逐字摘自材料，禁止改写/拼凑（落库时有接地校验，不符即拒收）；',
          '3. 题型覆盖 记忆/理解/应用 三层；每题尽量提供 knowledgePointTitle（优先用材料中的知识点锚点）；',
          weakPoints.length > 0 ? `4. 薄弱点加权：以下薄弱题对应的知识点至少出 ${Math.ceil(wantCount * 0.4)} 题——${weakPoints.map((w) => `《${w.documentTitle}》${w.question}…`).join('；')}` : '4. 无薄弱点信号，按材料均衡出题；',
          '5. 选择题干扰项取同概念域/常见误解，长度相近，正确答案位置随机分布；',
          '6. 生成后调用 generate_questions（generator=出题官）入库进 SM-2 复习闭环并开启做题会话，拒收题目按原因修正后至多补生成一轮。',
        ].filter(Boolean).join('\n')

        return {
          output: [
            `已读取 ${documents.length} 篇文档（分节材料 + ${documents.reduce((n, d) => n + d.knowledgePoints.length, 0)} 个知识点锚点）。`,
            '请优先委派「出题官」专家出题：launch_subagent（type=preset, preset=出题官，task 含下方任务书与材料）；出题官不可用则你按任务书直接出题。最后调用 generate_questions 入库并开练。',
            brief,
          ].join('\n\n'),
          result: { instructions: brief, documents, weakPoints }
        }
      }
    )
  },

  deactivate() {},

  practiceInstant,

  pageQuestionBank,
  locateSourceDoc,
  pageMistakeAttribution,
  startConceptPractice,
  startBankPractice,
  practiceQuestion,
  restoreBankQuestion,
  retireBankQuestion,
  pagePurgeRetired,
  toggleObjectiveFirst,
  exportBankJson,
  exportBankAnki,
  importBank,
  pageGeneratePrompt,
  selectExpansionTargets,
  pageExpandHandoff,
  clearExpansionCooldown,
  masteryLevel,
}


// eco-verify: v0.2.2 hot-update marker
