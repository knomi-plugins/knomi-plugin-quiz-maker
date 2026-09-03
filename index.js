'use strict'

/**
 * quiz-maker 内化阶段插件（v0.2）
 *
 * 核心：generate_cloze_quiz —— 从文档确定性生成"选择填空"题（零 LLM 依赖）：
 *   句子切分 → 关键术语识别 → 挖空 → 干扰项取自全文术语 → insertQuestion 入库
 *   → 返回 start_practice 意图，内容区立即进入做题模式。
 * 每题强制 sourceSnippet（原文句子），入库经 ADR-102 校验（answer/去重），
 * 失败计入 rejected 并如实汇报——绝不产生占位题。
 */

const fsp = require('fs/promises')

const PLUGIN_ID = 'quiz-maker'

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

/** 从句子中挑一个可挖空的关键术语（优先在全文多次出现的真实概念词） */
function pickTerm(sentence, globalTerms) {
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

module.exports = {
  id: PLUGIN_ID,
  name: '做题生成器',
  version: '0.2.0',
  description: '内化阶段：从知识库文档确定性生成填空选择题（无需 LLM）并入题库，立即开始做题',

  activate(context) {
    context.registerAgentTool(
      {
        name: 'generate_cloze_quiz',
        description: '从知识库文档确定性生成"选择填空"题（不依赖 LLM，规则挖空）：切句 → 识别关键术语 → 挖空 → 干扰项取自全文术语。题目直接入题库（自动去重、强制原文引用），并立即在内容区开启做题会话。用户想"快速出题/零成本刷题/不用 AI 出题"时使用。',
        parameters: {
          type: 'object',
          properties: {
            documentPath: { type: 'string', description: '目标文档路径；缺省则取最近更新的文档' },
            count: { type: 'number', description: '期望题数，默认 5，上限 15' }
          }
        }
      },
      async (args) => {
        const count = Math.min(Math.max(Number(args.count) || 5, 1), 15)
        let docs = context.getDocuments() || []
        if (!docs.length) return { output: '', error: '知识库为空，请先采集/添加文档' }
        let doc = null
        if (args.documentPath) {
          const norm = String(args.documentPath).replace(/\\/g, '/').toLowerCase()
          doc = docs.find((d) => String(d.filePath || '').replace(/\\/g, '/').toLowerCase() === norm) || null
          if (!doc) return { output: '', error: `未找到文档: ${args.documentPath}` }
        } else {
          doc = [...docs].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
        }

        let content = ''
        try { content = await fsp.readFile(doc.filePath, 'utf-8') } catch { content = '' }
        if (!content) return { output: '', error: `文档内容不可读: ${doc.filePath}` }

        // 全文术语池（干扰项来源）
        const globalTerms = [...new Set(extractTerms(content.replace(/---[\s\S]*?---/, '')))]
        const sentences = content
          .replace(/---[\s\S]*?---/, '')
          .replace(/```[\s\S]*?```/g, '')
          .split(/[。！？\n]+/)
          .map((s) => s.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim())
          .filter(usableSentence)

        const questions = []
        const rejected = []
        let seed = 7
        for (const sentence of sentences) {
          if (questions.length >= count) break
          const pick = pickTerm(sentence, globalTerms)
          if (!pick) { rejected.push('无可挖空的关键术语'); continue }
          const options = shuffled([pick.term, ...pick.distractors.slice(0, 3)], seed += 13)
          const question = `选择填空（出自《${doc.title}》）：${sentence.replace(pick.term, '______')}`
          const result = await context.insertQuestion({
            documentId: doc.id,
            type: 'single_choice',
            question,
            options,
            answer: pick.term,
            explanation: `原文：${sentence}`,
            sourceSnippet: sentence,
            pluginId: PLUGIN_ID
          })
          if (result.created || result.duplicate) {
            questions.push({
              id: result.id, documentId: doc.id, documentPath: doc.filePath,
              knowledgePointTitle: doc.title || null,
              type: 'single_choice', question, options, answer: pick.term,
              explanation: `原文：${sentence}`, sourceSnippet: sentence, pluginId: PLUGIN_ID,
              duplicate: result.duplicate
            })
          } else {
            rejected.push(result.reason || '入库被拒')
          }
        }

        if (questions.length === 0) {
          return { output: '', error: `未能从《${doc.title}》生成题目（扫描 ${sentences.length} 句，全部被拒: ${[...new Set(rejected)].join('；')}）` }
        }

        const summary = [
          `✅ 已生成 ${questions.length} 道选择填空题（来自《${doc.title}》）并开启做题：`,
          rejected.length > 0 ? `⚠️ ${rejected.length} 题被契约拒绝（${[...new Set(rejected)].slice(0, 3).join('；')}）` : '',
          '作答后自动判分并进入 SM-2 复习调度。'
        ].filter(Boolean).join('\n')

        return {
          output: summary,
          ui: {
            intent: 'start_practice',
            questions: questions.map(({ duplicate, ...q }) => q),
            title: `《${doc.title}》填空练习（${questions.length} 题）`
          }
        }
      }
    )

    // 保留 v1 的 generate_quiz（LLM 深度出题入口：读取文档结构化返回，由 Agent 生成题目后走 generate_questions 落库）
    context.registerAgentTool(
      {
        name: 'generate_quiz',
        description: '读取知识库文档并把内容结构化返回给 Agent（LLM），由 Agent 基于真实内容深度出题（需要更好的题目质量时使用；简单快速出题请用 generate_cloze_quiz）。题目随后经 generate_questions 落库。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '主题关键词，用于筛选文档' },
            count: { type: 'number', description: '期望题数，默认 5' }
          }
        }
      },
      async (args) => {
        const docs = context.getDocuments() || []
        const keyword = String(args.topic || '').toLowerCase()
        const matched = docs
          .filter((d) => !keyword || String(d.title || '').toLowerCase().includes(keyword) || String(d.filePath || '').toLowerCase().includes(keyword))
          .slice(0, 3)
        if (matched.length === 0) return { output: '', error: `没有找到与「${args.topic || '任何主题'}」相关的文档` }
        const documents = []
        for (const d of matched) {
          documents.push({ documentId: d.id, documentPath: d.filePath, title: d.title, content: (await context.readFile(d.filePath)).slice(0, 3000) })
        }
        return {
          output: `已读取 ${documents.length} 篇文档。请基于内容生成题目，每题必须带 sourceSnippet（原文引用），然后调用 generate_questions 落库并开启做题。`,
          result: { instructions: `生成 ${args.count || 5} 道题`, documents }
        }
      }
    )
  },

  deactivate() {}
}


// eco-verify: v0.2.2 hot-update marker
