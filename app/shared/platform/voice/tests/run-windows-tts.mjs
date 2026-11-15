import assert from 'node:assert/strict'
import { voiceTtsTarget } from '../../index.js'
import { inspectWave } from '../windows-tts.js'

const tts = voiceTtsTarget()
try {
  const capability = tts.inspect()
  if (!capability.supported) {
    assert.equal((await tts.listVoices()).length, 0)
    console.log('Windows TTS unsupported platform: 1 passed')
  } else {
    const voices = await tts.listVoices()
    assert.ok(voices.length > 0, 'Windows should have at least one enabled System.Speech voice')
    const voiceId = voices.find(voice => /^zh(?:-|$)/i.test(voice.culture))?.id || voices[0].id
    const first = await tts.synthesize({ text: '测试语音输出。', voiceId, rate: 0 })
    assert.ok(first.wav.length > 44)
    assert.equal(inspectWave(first.wav).sampleRate, first.info.sampleRate)
    const second = await tts.synthesize({ text: '持续复用合成助手。', voiceId, rate: 0 })
    assert.ok(second.wav.length > 44)
    const controller = new AbortController()
    const pending = tts.synthesize({ text: '这是一个验证取消时可以终止本次系统语音任务的较长句子。'.repeat(4), voiceId, rate: 0, signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, error => error.code === 'TTS_CANCELLED')
    assert.ok((await tts.listVoices()).length > 0, 'helper must recover after cancellation')
    const afterCancel = await tts.synthesize({ text: '取消后继续。', voiceId, rate: 0 })
    assert.ok(afterCancel.wav.length > 44)
    console.log('Windows System.Speech helper: enumeration, WAV, reuse, cancel, recovery passed')
  }
} finally { tts.close() }
