import { VOICE_LIMITS } from './limits.js';

const stripCode = (text) => text.replace(/```[\s\S]*?```/g, ' 详细内容请看文字。 ').replace(/`([^`]+)`/g, '$1');
export function speechToText(input, { maxChars = VOICE_LIMITS.replyChars } = {}) {
  if (typeof input !== 'string' || !input.trim()) return '';
  let text = stripCode(input);
  text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<\|(?:think|analysis|tool|hidden)[^|]*\|>[\s\S]*?<\|end[^|]*\|>/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/g, '$2')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, '，')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{2,}/g, '。 ')
    .replace(/\n/g, '， ')
    .trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars).replace(/[，。！？；：,.;:!?\s]+$/u, '')}。其余内容可以看文字，或点击全文朗读。`;
  return text;
}

export function splitSpeechSentences(input, maxChars = VOICE_LIMITS.replySentenceChars) {
  const text = String(input ?? '').trim();
  if (!text || !Number.isInteger(maxChars) || maxChars < 1) return [];
  const sentences = [];
  for (const segment of text.split(/(?<=[。！？!?；;])\s*/u).filter(Boolean)) {
    let remaining = segment.trim();
    while (remaining.length > maxChars) {
      let cut = remaining.lastIndexOf('，', maxChars);
      if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
      sentences.push(remaining.slice(0, cut + (cut < maxChars ? 1 : 0)).trim());
      remaining = remaining.slice(cut + (cut < maxChars ? 1 : 0)).trim();
    }
    if (remaining) sentences.push(remaining);
  }
  return sentences;
}
