import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVoiceRepository } from '../repository.js'

const root = await mkdtemp(join(tmpdir(), 'chonkyfish-voice-repository-'))
const now = { value: 100000 }
const repo = createVoiceRepository({ root: join(root, 'voice'), DatabaseSync, now: () => now.value, retentionMs: 1000, maxBytes: 1024 * 1024, maxFiles: 10 })
const owner = { namespaceId: 'host-1', sessionId: 'session-1' }
const source = { sessionId: 'session-1', seq: 17 }
const format = { codec: 'pcm_s16le', sampleRate: 24000, channels: 1 }
const digest = 'a'.repeat(64)
const previewKey = 'b'.repeat(64)
try {
  assert.equal(repo.saveLabelRule({ requestId: 'request-1', owner, rule: { providerId: 'aliyun-qwen-tts', tags: ['sad'] } }), true)
  assert.deepEqual(repo.getLabelRule({ requestId: 'request-1', owner }), { providerId: 'aliyun-qwen-tts', tags: ['sad'] })
  assert.equal(repo.getLabelRule({ requestId: 'request-1', owner: { ...owner, sessionId: 'other' } }), null)
  const writer = await repo.beginAudio({ owner, source, textDigest: digest, voiceId: 'longanhuan_v3.1', format, operationId: 'op-17' })
  await writer.append(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]))
  const committed = await writer.commit()
  assert.equal(committed.audio.format.container, 'wav')
  assert.equal(committed.audio.format.mimeType, 'audio/wav')
  assert.equal(committed.audio.bytes, 52)
  assert.deepEqual(repo.listAudio({ owner, sessionId: 'session-1', seqs: [16, 17] }).map(item => item.audioId), [committed.audio.audioId])
  assert.equal(repo.getAudioForSource({ owner, source }).audioId, committed.audio.audioId)
  const opened = await repo.readAudio({ audioId: committed.audio.audioId, owner, sessionId: 'session-1' })
  const wav = await opened.file.readFile()
  await opened.close()
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(40), 8)
  const previewWav = Buffer.from(wav)
  const preview = await repo.storePreview({ cacheKey: previewKey, bytes: previewWav, format: { sampleRate: 24000, channels: 1 } })
  assert.equal(preview.audio.bytes, previewWav.length)
  assert.deepEqual(repo.getPreview({ cacheKey: previewKey }).audioId, preview.audio.audioId)
  const previewRead = await repo.readPreview({ cacheKey: previewKey })
  assert.deepEqual(await previewRead.file.readFile(), previewWav)
  await previewRead.close()
  assert.equal((await repo.storePreview({ cacheKey: previewKey, bytes: previewWav, format })).duplicate, true)
  await assert.rejects(repo.storePreview({ cacheKey: 'c'.repeat(64), bytes: Buffer.from(previewWav).fill(0, 4, 8), format }), { code: 'VOICE_PREVIEW_INVALID' })
  await assert.rejects(repo.readAudio({ audioId: committed.audio.audioId, owner: { ...owner, namespaceId: 'other' }, sessionId: 'session-1' }), { code: 'VOICE_AUDIO_NOT_FOUND' })
  assert.equal(await repo.invalidateSource({ owner, source }), true)
  assert.equal(repo.getAudioForSource({ owner, source }), null)
  const stale = await repo.beginAudio({ owner, source, textDigest: digest, voiceId: 'longanhuan_v3.1', format, operationId: 'op-stale' })
  await stale.append(Buffer.from([1, 0, 2, 0]))
  await stale.abort()
  assert.deepEqual(repo.listAudio({ owner, sessionId: 'session-1', seqs: [17] }), [])
  const expiringSource = { sessionId: 'session-1', seq: 18 }
  const expiring = await repo.beginAudio({ owner, source: expiringSource, textDigest: digest, voiceId: 'longanhuan_v3.1', format, operationId: 'op-expiring' })
  await expiring.append(Buffer.from([1, 0, 2, 0]))
  const expiringResult = await expiring.commit()
  now.value += 1500
  assert.deepEqual(repo.listAudio({ owner, sessionId: 'session-1', seqs: [18] }), [], 'expired rows are pruned during summary reads')
  assert.equal(repo.getAudioForSource({ owner, source: expiringSource }), null)
  await assert.rejects(repo.readAudio({ audioId: expiringResult.audio.audioId, owner, sessionId: 'session-1' }), { code: 'VOICE_AUDIO_NOT_FOUND' })
} finally {
  repo.close()
  await rm(root, { recursive: true, force: true })
}
console.log('Voice repository: label rules, one-file WAV publish and scoped reads passed')
