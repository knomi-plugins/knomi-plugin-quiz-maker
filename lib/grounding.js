// ============================================================
// 接地校验纯函数（quiz-maker 本地副本）
// 权威实现：electron/plugins/knomi-agent/tools/quiz-grounding.js
// 插件沙箱只允许 require 插件目录内文件，故同步副本；改动需两侧一致。
// 策略：归一化精确包含直过；否则 bigram 重叠率 ≥0.9（容忍单字偏差，拦截编造）；
// 短片段（<8 字符）必须精确。
// ============================================================

function normalizeForGrounding(text) {
  const m = String(text || '').toLowerCase().match(/[\p{L}\p{N}]/gu)
  return m ? m.join('') : ''
}

function bigramSet(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

function isGroundedIn(snippet, content, opts) {
  const minRatio = opts && typeof opts.minRatio === 'number' ? opts.minRatio : 0.9
  const s = normalizeForGrounding(snippet)
  if (!s) return false
  const c = normalizeForGrounding(content)
  if (!c) return false
  if (c.includes(s)) return true
  if (s.length < 8) return false
  const sb = [...bigramSet(s)]
  if (sb.length === 0) return false
  const cb = bigramSet(c)
  let found = 0
  for (const g of sb) if (cb.has(g)) found++
  return found / sb.length >= minRatio
}

module.exports = { normalizeForGrounding, isGroundedIn }
