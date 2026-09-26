// ============================================================
// 题目质量闸纯函数（quiz-maker 本地副本）
// 权威实现：electron/plugins/knomi-agent/tools/question-qc.js
// 插件沙箱只允许 require 插件目录内文件，故同步副本；改动需两侧一致。
// 规则：R1 占位符黑名单 / R2 题干长度 / R3 选项数 / R4 答案∈选项 /
//       R5 答案泄漏 / R6 选项同质（bigram ≥0.85）/ R7 引用非空。
// ============================================================
function normalizeForQc(text) {
  const m = String(text || '').toLowerCase().match(/[\p{L}\p{N}]/gu)
  return m ? m.join('') : ''
}

function bigramSetQc(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

function bigramOverlapQc(a, b) {
  const sa = bigramSetQc(a)
  const sb = bigramSetQc(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let hit = 0
  for (const g of sa) if (sb.has(g)) hit++
  return hit / Math.min(sa.size, sb.size)
}

const PLACEHOLDER_RE = /基础知识\s*\d|基础技术\s*\d|选项\s*[a-d1-4]|示例文本|示例选项|示例答案|待填|待补充|占位|x{3,}|ＸＸＸ|这里填|此处填/i
const TF_ANSWERS = ['正确', '错误', '对', '错', 'true', 'false', '是', '否']

function tryParseJson(v) {
  if (Array.isArray(v)) return v
  const s = String(v == null ? '' : v).trim()
  if (!s.startsWith('[')) return null
  try {
    const arr = JSON.parse(s)
    return Array.isArray(arr) ? arr : null
  } catch { return null }
}

function qcQuestion(q) {
  const reasons = []
  const type = String(q.type || '')
  const question = String(q.question || '')
  const answerRaw = q.answer
  const options = Array.isArray(q.options)
    ? q.options.map((o) => String(o))
    : (() => { const arr = tryParseJson(q.options); return arr ? arr.map((o) => String(o)) : [] })()

  const qNorm = normalizeForQc(question)
  if (PLACEHOLDER_RE.test(question)) reasons.push('题干含占位符')
  for (const o of options) {
    if (PLACEHOLDER_RE.test(o)) { reasons.push(`选项含占位符:「${String(o).slice(0, 20)}」`); break }
  }
  const answerStr = Array.isArray(answerRaw) ? answerRaw.join('') : String(answerRaw || '')
  if (PLACEHOLDER_RE.test(answerStr)) reasons.push('答案含占位符')

  if (qNorm.length < 10) reasons.push(`题干过短（归一化后 ${qNorm.length} 字符）`)

  const OBJ_MCHOICE = type === 'single_choice' || type === 'multi_choice'
  const OBJ_TF = type === 'true_false'

  if (OBJ_MCHOICE) {
    const uniq = [...new Set(options.map((o) => normalizeForQc(o)).filter(Boolean))]
    if (uniq.length < 3) reasons.push(`有效选项不足（去重后 ${uniq.length} 个）`)
  }

  if (OBJ_MCHOICE && options.length > 0) {
    const optSet = new Set(options.map((o) => normalizeForQc(o)))
    const ansArr = Array.isArray(answerRaw) ? answerRaw.map((a) => String(a)) : [answerStr]
    const missing = ansArr.filter((a) => !optSet.has(normalizeForQc(a)))
    if (missing.length > 0) reasons.push('答案不在选项集合内')
  }
  if (OBJ_TF && !TF_ANSWERS.includes(String(answerRaw).trim().toLowerCase()) && !TF_ANSWERS.includes(String(answerRaw).trim())) {
    reasons.push('判断题答案非法（应为 正确/错误 及变体）')
  }

  if ((OBJ_MCHOICE || OBJ_TF) && answerStr && qNorm) {
    const aNorm = normalizeForQc(answerStr)
    if (aNorm.length >= 2 && qNorm.includes(aNorm)) reasons.push('答案泄漏在题干中')
  }

  if (OBJ_MCHOICE && options.length >= 2) {
    const norms = options.map((o) => normalizeForQc(o))
    outer: for (let i = 0; i < norms.length; i++) {
      for (let j = i + 1; j < norms.length; j++) {
        if (!norms[i] || !norms[j]) continue
        if (norms[i].includes(norms[j]) || norms[j].includes(norms[i]) || bigramOverlapQc(norms[i], norms[j]) >= 0.85) {
          reasons.push(`选项同质:「${String(options[i]).slice(0, 14)}」≈「${String(options[j]).slice(0, 14)}」`)
          break outer
        }
      }
    }
  }

  if (!String(q.sourceSnippet || '').trim()) reasons.push('缺少原文引用（sourceSnippet）')

  return { ok: reasons.length === 0, reasons }
}

function qcQuestionBatch(list) {
  const passed = []
  const rejected = []
  const seenQ = new Set()
  for (const q of list || []) {
    const key = normalizeForQc(q.question)
    if (key && seenQ.has(key)) {
      rejected.push({ question: String(q.question || '').slice(0, 40), reasons: ['同批重复题干'] })
      continue
    }
    if (key) seenQ.add(key)
    const r = qcQuestion(q)
    if (r.ok) passed.push(q)
    else rejected.push({ question: String(q.question || '').slice(0, 40), reasons: r.reasons })
  }
  return { passed, rejected, total: (list || []).length }
}

module.exports = { qcQuestion, qcQuestionBatch, normalizeForQc, PLACEHOLDER_RE }
