// ============================================================
// quiz-maker - 库存题匹配纯函数（v0.21.0，v9-T4 画像消费面）
// 管什么：给定目标文档画像与候选库存题（含各自来源文档画像），按确定性公式打分排序——
//   score = 同文档 1.2 + 概念包含度重叠×1.0 + 难度相同 0.25 + 盲答验证通过 0.15
//   （任一画像缺失时退化用关键词 tags/tech 重叠 ×0.5 兜底）
//   复用门槛 REUSE_MIN_SCORE=0.6：同文档旧题必过（1.2）；跨文档需实质概念重合。
// 不管什么：SQL 取数（index.js 经 ctx.query）；会话组装与入库（index.js）。
// 被谁调用：index.js practiceInstant 收割段（生成挖空前的库存优先路径）。
// 纪律：纯函数——同输入必同输出（排序分高→id 字典序）；权重常量冻结，改动=插件发版
//   （对标 taxonomy-matcher 权重纪律）；画像解析失败当空画像降级，绝不抛错阻断出题。
// ============================================================

/** 复用门槛（冻结；改动=发版） */
const REUSE_MIN_SCORE = 0.6
const SAME_DOC_SCORE = 1.2
const CONCEPT_COVER_WEIGHT = 1.0
const DIFFICULTY_MATCH_SCORE = 0.25
const VERIFIED_SCORE = 0.15
const KEYWORD_FALLBACK_WEIGHT = 0.5

function parseProfile(json) {
  try {
    const p = JSON.parse(json || '{}')
    return {
      concepts: Array.isArray(p.concepts) ? p.concepts.map((c) => String(c || '').toLowerCase().trim()).filter(Boolean) : [],
      difficulty: typeof p.difficulty === 'string' ? p.difficulty : '',
      docType: typeof p.docType === 'string' ? p.docType : '',
    }
  } catch {
    return { concepts: [], difficulty: '', docType: '' }
  }
}

function parseKeywords(json) {
  try {
    const k = JSON.parse(json || '{}')
    return [k.domain, k.topic, k.tech, ...(Array.isArray(k.tags) ? k.tags : [])]
      .map((w) => String(w || '').toLowerCase().trim()).filter((w) => w.length >= 2)
  } catch {
    return []
  }
}

function containmentOverlap(setA, listB) {
  if (setA.size === 0 || listB.length === 0) return 0
  let inter = 0
  for (const w of new Set(listB)) if (setA.has(w)) inter++
  return inter / Math.min(setA.size, new Set(listB).size)
}

/**
 * 库存题打分排序（纯函数）。
 * @param target {docId, profileJson, keywordsJson} 目标文档画像
 * @param rows   ctx.query 行：{id, documentId, profileJson, keywordsJson, verified, ...题目字段}
 * @returns 命中数组 [{ row, score, sameDoc }]，score 降序 → id 升序；低于门槛不返回
 */
function matchInventoryQuestions(target, rows) {
  const tp = parseProfile(target.profileJson)
  const tk = parseKeywords(target.keywordsJson)
  const tpSet = new Set(tp.concepts)
  const tkSet = new Set(tk)
  const scored = []
  for (const row of rows || []) {
    let score = 0
    const sameDoc = row.documentId && row.documentId === target.docId
    if (sameDoc) score += SAME_DOC_SCORE
    const rp = parseProfile(row.profileJson)
    if (tpSet.size > 0 && rp.concepts.length > 0) {
      score += containmentOverlap(tpSet, rp.concepts) * CONCEPT_COVER_WEIGHT
    } else {
      // 画像缺失降级：来源文档关键词与目标关键词重叠（图谱共享本体数据）
      const rk = parseKeywords(row.keywordsJson)
      score += containmentOverlap(tkSet.size > 0 ? tkSet : tpSet, rk) * KEYWORD_FALLBACK_WEIGHT
    }
    if (tp.difficulty && rp.difficulty && tp.difficulty === rp.difficulty) score += DIFFICULTY_MATCH_SCORE
    if (Number(row.verified) === 1) score += VERIFIED_SCORE
    if (score >= REUSE_MIN_SCORE) scored.push({ row, score: Math.round(score * 1000) / 1000, sameDoc: Boolean(sameDoc) })
  }
  scored.sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)))
  return scored
}

module.exports = { matchInventoryQuestions, parseProfile, parseKeywords, REUSE_MIN_SCORE }
