const CONTROL_TAG = /\[([a-z][a-z0-9_-]{0,31})\]/giu
const HIDDEN_BLOCK = /<think\b[^>]*>[\s\S]*?<\/think>|<\|(?:think|analysis|tool|hidden)[^|]*\|>[\s\S]*?<\|end[^|]*\|>/gi

function isQuotedLine(line) { return /^\s*>/.test(line) }

function lineRanges(text) {
  const ranges = []
  let offset = 0
  let fenced = false
  for (const line of text.match(/[^\n]*(?:\n|$)/gu) || []) {
    if (!line) continue
    const body = line.replace(/\n$/u, '')
    const fence = /^\s{0,3}(```+|~~~+)/u.test(body)
    if (fence) fenced = !fenced
    ranges.push({ start: offset, end: offset + body.length, fenced, quoted: isQuotedLine(body) })
    offset += line.length
  }
  return ranges
}

function inInlineCode(text, index) {
  let active = false
  for (let cursor = 0; cursor < index; cursor++) {
    if (text[cursor] !== '`') continue
    let count = 1
    while (text[cursor + count] === '`') count++
    active = !active
    cursor += count - 1
  }
  return active
}

function isProtected(text, index, ranges) {
  const line = ranges.find(row => index >= row.start && index <= row.end)
  return Boolean(line?.fenced || line?.quoted || inInlineCode(text, index))
}

function inMarkdownLinkLabel(text, index) {
  for (const match of text.matchAll(/!?\[([^\]\n]+)\]\([^)]*\)/gu)) {
    const labelStart = match.index + (match[0].startsWith('!') ? 1 : 0)
    const labelEnd = labelStart + match[1].length + 2
    if (index >= labelStart && index < labelEnd) return true
  }
  return false
}

function replaceTagLiterals(text, allowed, protectedRanges, controlRanges) {
  let display = ''
  let synthesis = ''
  let cursor = 0
  CONTROL_TAG.lastIndex = 0
  for (let match; (match = CONTROL_TAG.exec(text));) {
    display += text.slice(cursor, match.index)
    synthesis += text.slice(cursor, match.index)
    const tag = match[1]
    const literal = `[${tag}]`
    if (inMarkdownLinkLabel(text, match.index)) {
      display += literal
      synthesis += literal
    } else if (allowed.has(tag) && !isProtected(text, match.index, protectedRanges)) {
      const start = synthesis.length
      controlRanges.push({ tag, start, end: start + literal.length })
      synthesis += literal
    } else {
      display += literal
      synthesis += `方括号 ${tag}`
    }
    cursor = match.index + match[0].length
  }
  display += text.slice(cursor)
  synthesis += text.slice(cursor)
  return { display, synthesis }
}

function markdownToSpeech(text) {
  return text
    .replace(/```[^\n]*\n[\s\S]*?```/gu, '代码内容请看文字。')
    .replace(/~~~[^\n]*\n[\s\S]*?~~~/gu, '代码内容请看文字。')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gmu, '')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/^\s*\d+[.)]\s+/gmu, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, '链接请看文字')
    .replace(/^\s*>\s?/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/\*([^*]+)\*/gu, '$1')
    .replace(/_([^_]+)_/gu, '$1')
    .replace(/\|/gu, '，')
    .replace(/\s{2,}/gu, ' ')
    .replace(/\n{2,}/gu, '。 ')
    .replace(/\n/gu, '， ')
    .trim()
}

/**
 * Separate user-visible reply text from one provider's allowed control tags.
 * `maxChars` is a whole-message budget: this function never truncates or splits.
 */
export function parseSpeechReply(input, { allowedTags = [], maxChars = Infinity } = {}) {
  if (typeof input !== 'string' || !input.trim()) return { plainText: '', synthesisText: '', controls: [], overLimit: false }
  const hiddenFree = input.replace(HIDDEN_BLOCK, ' ')
  const allowed = new Set(Array.isArray(allowedTags) ? allowedTags.filter(tag => typeof tag === 'string') : [])
  const protectedRanges = lineRanges(hiddenFree)
  const controls = []
  const { display, synthesis } = replaceTagLiterals(hiddenFree, allowed, protectedRanges, controls)
  const plainText = display.replace(/[ \t]{2,}/gu, ' ').replace(/\s+$/u, '')
  const synthesisText = markdownToSpeech(synthesis)
  const overLimit = Number.isFinite(maxChars) && synthesisText.length > maxChars
  return { plainText, synthesisText, controls, overLimit }
}
