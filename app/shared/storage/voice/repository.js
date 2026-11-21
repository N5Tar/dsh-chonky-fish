import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { inspectPcm16Wav } from '../../audio/wav.js'

const MAX_AUDIO_BYTES = 12 * 1024 * 1024
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024
const fail = (code, message = code) => Object.assign(new Error(message), { code })
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const validOwner = owner => owner && validId(owner.namespaceId) && validId(owner.sessionId)
const json = value => JSON.stringify(value ?? null)

function wavHeader(dataBytes, { sampleRate, channels, bitsPerSample = 16 }) {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes > 0xffffffff - 36) throw fail('VOICE_AUDIO_TOO_LARGE')
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28)
  header.writeUInt16LE(channels * bitsPerSample / 8, 32); header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40)
  return header
}

function formatWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_AUDIO_BYTES) throw fail('TTS_INVALID_AUDIO')
  let info
  try { info = inspectPcm16Wav(bytes, { maxBytes: MAX_AUDIO_BYTES, maxSeconds: 300 }) }
  catch { throw fail('TTS_INVALID_AUDIO') }
  return { container: 'wav', codec: 'pcm_s16le', sampleRate: info.sampleRate, channels: info.channels, bitsPerSample: 16, mimeType: 'audio/wav', durationMs: Math.ceil(info.sampleCount * 1000 / info.sampleRate) }
}

/** One-file voice index and atomic WAV publisher. Never stores transcript bodies. */
export function createVoiceRepository({ root, dbPath = join(root, 'index.sqlite'), DatabaseSync, now = Date.now, maxBytes = 512 * 1024 * 1024, maxFiles = 2000, retentionMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('voice repository root is required')
  if (typeof DatabaseSync !== 'function') throw new TypeError('SQLite DatabaseSync adapter required')
  const base = resolve(root), audioDir = join(base, 'audio'), tmpDir = join(base, 'tmp'), previewDir = join(base, 'preview')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  let closed = false
  const assertOpen = () => { if (closed) throw fail('VOICE_STORE_CLOSED') }
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS voice_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS label_rules(request_id TEXT NOT NULL,namespace_id TEXT NOT NULL,session_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(request_id,namespace_id,session_id));
      CREATE TABLE IF NOT EXISTS reply_audio(audio_id TEXT PRIMARY KEY,namespace_id TEXT NOT NULL,session_id TEXT NOT NULL,source_seq INTEGER NOT NULL,text_digest TEXT NOT NULL,voice_id TEXT NOT NULL,relative_path TEXT NOT NULL,format_json TEXT NOT NULL,duration_ms INTEGER NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(namespace_id,session_id,source_seq));
      CREATE INDEX IF NOT EXISTS reply_audio_owner ON reply_audio(namespace_id,session_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS preview_audio(cache_key TEXT PRIMARY KEY,audio_id TEXT NOT NULL UNIQUE,relative_path TEXT NOT NULL,format_json TEXT NOT NULL,duration_ms INTEGER NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);`)
  } catch (error) { db.close(); throw error }
  const safeRelative = value => {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw fail('VOICE_AUDIO_NOT_FOUND')
    const absolute = resolve(base, value), rel = relative(base, absolute)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== absolute) throw fail('VOICE_AUDIO_NOT_FOUND')
    return absolute
  }
  const removeStoredFile = value => { try { unlinkSync(safeRelative(value)) } catch {} }
  const removeExpired = row => {
    if (!row || Number(row.expires_at) > now()) return false
    db.prepare('DELETE FROM reply_audio WHERE audio_id=?').run(row.audio_id)
    removeStoredFile(row.relative_path)
    return true
  }
  const rowToSummary = row => row ? ({ audioId: row.audio_id, source: { sessionId: row.session_id, seq: row.source_seq }, voiceId: row.voice_id, format: JSON.parse(row.format_json), durationMs: row.duration_ms, bytes: row.bytes, sha256: row.sha256, createdAt: row.created_at }) : null
  const previewSummary = row => row ? ({ audioId: row.audio_id, format: JSON.parse(row.format_json), durationMs: row.duration_ms, bytes: row.bytes, sha256: row.sha256, createdAt: row.created_at }) : null
  function saveLabelRule({ requestId, owner, rule }) {
    assertOpen()
    if (!validId(requestId) || !validOwner(owner) || !rule || typeof rule !== 'object') throw fail('VOICE_RULE_INVALID')
    db.prepare(`INSERT INTO label_rules(request_id,namespace_id,session_id,payload_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(request_id,namespace_id,session_id) DO UPDATE SET payload_json=excluded.payload_json`)
      .run(requestId, owner.namespaceId, owner.sessionId, json(rule), now())
    return true
  }
  function getLabelRule({ requestId, owner }) {
    assertOpen()
    if (!validId(requestId) || !validOwner(owner)) return null
    const row = db.prepare('SELECT payload_json FROM label_rules WHERE request_id=? AND namespace_id=? AND session_id=?').get(requestId, owner.namespaceId, owner.sessionId)
    return row ? JSON.parse(row.payload_json) : null
  }
  function getAudioForSource({ owner, source }) {
    assertOpen()
    if (!validOwner(owner) || !validId(source?.sessionId) || !Number.isSafeInteger(source?.seq) || source.sessionId !== owner.sessionId) return null
    const row = db.prepare('SELECT * FROM reply_audio WHERE namespace_id=? AND session_id=? AND source_seq=?').get(owner.namespaceId, source.sessionId, source.seq)
    if (removeExpired(row)) return null
    return rowToSummary(row)
  }
  async function beginAudio({ owner, source, textDigest, voiceId, format, operationId }) {
    assertOpen()
    if (!validOwner(owner) || source?.sessionId !== owner.sessionId || !Number.isSafeInteger(source?.seq) || source.seq < 0 || !/^[a-f0-9]{64}$/.test(textDigest || '') || !validId(voiceId)) throw fail('VOICE_SOURCE_INVALID')
    if (!format || !['pcm_s16le', 'wav'].includes(format.codec) || ![1, 2].includes(format.channels) || format.sampleRate < 8000 || format.sampleRate > 48000) throw fail('TTS_FORMAT_UNSUPPORTED')
    await Promise.all([mkdir(audioDir, { recursive: true }), mkdir(tmpDir, { recursive: true }), mkdir(previewDir, { recursive: true })])
    const tempPath = join(tmpDir, `${String(operationId || randomUUID()).replace(/[^A-Za-z0-9_-]/g, '')}.part`)
    const file = await open(tempPath, 'wx', 0o600)
    if (format.codec === 'pcm_s16le') await file.write(wavHeader(0, format), 0, 44, 0)
    let dataBytes = 0, done = false
    return {
      async append(value) {
        if (done) throw fail('VOICE_OPERATION_CLOSED')
        const chunk = Buffer.from(value)
        if (!chunk.length || dataBytes + chunk.length > maxBytes || dataBytes + chunk.length > MAX_AUDIO_BYTES) throw fail('TTS_LIMIT_EXCEEDED')
        if (format.codec === 'pcm_s16le' && chunk.length % (format.channels * 2) !== 0) throw fail('TTS_INVALID_AUDIO')
        dataBytes += chunk.length
        const position = format.codec === 'pcm_s16le' ? 44 + dataBytes - chunk.length : dataBytes - chunk.length
        await file.write(chunk, 0, chunk.length, position)
      },
      async commit() {
        if (done) throw fail('VOICE_OPERATION_CLOSED')
        try {
          if (!dataBytes) throw fail('TTS_EMPTY_AUDIO')
          if (format.codec === 'pcm_s16le') await file.write(wavHeader(dataBytes, format), 0, 44, 0)
          await file.sync(); await file.close()
          const audioId = randomUUID(), rel = join('audio', audioId.slice(0, 2), `${audioId}.wav`), finalPath = safeRelative(rel)
          await mkdir(dirname(finalPath), { recursive: true })
          const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(tempPath))
          const storedFormat = formatWav(bytes)
          if (storedFormat.sampleRate !== format.sampleRate || storedFormat.channels !== format.channels) throw fail('TTS_INVALID_AUDIO')
          const digestValue = createHash('sha256').update(bytes).digest('hex')
          const createdAt = now(), expiresAt = createdAt + retentionMs
          const existing = getAudioForSource({ owner, source })
          if (existing) { done = true; await rm(tempPath, { force: true }); return { duplicate: true, audio: existing } }
          await rename(tempPath, finalPath)
          db.prepare('INSERT INTO reply_audio(audio_id,namespace_id,session_id,source_seq,text_digest,voice_id,relative_path,format_json,duration_ms,bytes,sha256,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(audioId, owner.namespaceId, owner.sessionId, source.seq, textDigest, voiceId, rel, json(storedFormat), storedFormat.durationMs, bytes.length, digestValue, createdAt, expiresAt)
          done = true
          await rm(tempPath, { force: true })
          await cleanup()
          return { duplicate: false, audio: { audioId, source, voiceId, format: storedFormat, durationMs: storedFormat.durationMs, bytes: bytes.length, sha256: digestValue, createdAt } }
        } catch (error) {
          done = true
          try { await file.close() } catch {}
          await rm(tempPath, { force: true })
          throw error
        }
      },
      async abort() { if (done) return; done = true; try { await file.close() } catch {} await rm(tempPath, { force: true }) },
    }
  }
  async function cleanup() {
    assertOpen()
    const cutoff = now() - retentionMs
    const rows = db.prepare('SELECT audio_id,relative_path FROM reply_audio ORDER BY created_at ASC').all()
    let bytes = rows.reduce((sum, row) => sum + Number(db.prepare('SELECT bytes FROM reply_audio WHERE audio_id=?').get(row.audio_id)?.bytes || 0), 0)
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], meta = db.prepare('SELECT bytes,expires_at FROM reply_audio WHERE audio_id=?').get(row.audio_id)
      if (rows.length - index <= maxFiles && bytes <= maxBytes && meta.expires_at > now()) break
      db.prepare('DELETE FROM reply_audio WHERE audio_id=?').run(row.audio_id); bytes -= meta.bytes
      await rm(safeRelative(row.relative_path), { force: true })
    }
    db.prepare('DELETE FROM label_rules WHERE created_at<?').run(cutoff)
    const previewRows = db.prepare('SELECT cache_key,audio_id,relative_path,bytes,expires_at FROM preview_audio ORDER BY created_at ASC').all()
    let previewBytes = previewRows.reduce((sum, row) => sum + Number(row.bytes), 0)
    for (const row of previewRows) {
      if (row.expires_at > now() && previewBytes <= MAX_PREVIEW_BYTES) break
      db.prepare('DELETE FROM preview_audio WHERE cache_key=?').run(row.cache_key); previewBytes -= Number(row.bytes)
      await rm(safeRelative(row.relative_path), { force: true })
    }
    for (const entry of await (await import('node:fs/promises')).readdir(tmpDir).catch(() => [])) {
      const path = join(tmpDir, entry)
      const info = await stat(path).catch(() => null)
      if (info && info.mtimeMs < now() - 24 * 60 * 60 * 1000) await rm(path, { force: true })
    }
  }
  function listAudio({ owner, sessionId, seqs = [] }) {
    assertOpen()
    if (!validOwner(owner) || sessionId !== owner.sessionId || !Array.isArray(seqs) || seqs.length > 200 || seqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) throw fail('VOICE_SCOPE_DENIED')
    if (!seqs.length) return []
    const params = [owner.namespaceId, owner.sessionId, ...seqs]
    const rows = db.prepare(`SELECT * FROM reply_audio WHERE namespace_id=? AND session_id=? AND source_seq IN (${seqs.map(() => '?').join(',')})`).all(...params)
    return rows.filter(row => !removeExpired(row)).map(rowToSummary)
  }
  async function readAudio({ audioId, owner, sessionId }) {
    assertOpen()
    if (!validOwner(owner) || sessionId !== owner.sessionId || !validId(audioId)) throw fail('VOICE_SCOPE_DENIED')
    const row = db.prepare('SELECT audio_id,relative_path,bytes,sha256,source_seq,expires_at FROM reply_audio WHERE audio_id=? AND namespace_id=? AND session_id=?').get(audioId, owner.namespaceId, owner.sessionId)
    if (!row) throw fail('VOICE_AUDIO_NOT_FOUND')
    if (removeExpired(row)) throw fail('VOICE_AUDIO_NOT_FOUND')
    const path = safeRelative(row.relative_path), file = await open(path, 'r')
    const statInfo = await file.stat()
    if (statInfo.size !== row.bytes) { await file.close(); throw fail('VOICE_AUDIO_CORRUPT') }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(fail('VOICE_AUDIO_READ_TIMEOUT')), 30000)
    let closedFile = false
    return {
      file, bytes: row.bytes, sha256: row.sha256, source: { sessionId, seq: row.source_seq }, signal: controller.signal,
      cancel(reason = fail('VOICE_AUDIO_READ_CANCELLED')) { if (!controller.signal.aborted) controller.abort(reason) },
      async close() { if (closedFile) return; closedFile = true; clearTimeout(timer); await file.close().catch(() => {}) },
    }
  }
  async function invalidateSource({ owner, source }) {
    assertOpen()
    if (!validOwner(owner) || source?.sessionId !== owner.sessionId || !Number.isSafeInteger(source.seq)) throw fail('VOICE_SCOPE_DENIED')
    const row = db.prepare('SELECT audio_id,relative_path FROM reply_audio WHERE namespace_id=? AND session_id=? AND source_seq=?').get(owner.namespaceId, owner.sessionId, source.seq)
    if (!row) return false
    db.prepare('DELETE FROM reply_audio WHERE audio_id=?').run(row.audio_id); await rm(safeRelative(row.relative_path), { force: true }); return true
  }
  async function storePreview({ cacheKey, bytes, format }) {
    assertOpen()
    if (typeof cacheKey !== 'string' || !/^[a-f0-9]{64}$/.test(cacheKey) || !Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES) throw fail('VOICE_PREVIEW_INVALID')
    let parsed, declared
    try { parsed = formatWav(bytes); declared = inspectPcm16Wav(bytes, { maxBytes: MAX_AUDIO_BYTES, maxSeconds: 300 }) }
    catch { throw fail('VOICE_PREVIEW_INVALID') }
    if (parsed.sampleRate !== declared.sampleRate || parsed.channels !== declared.channels || format && (parsed.sampleRate !== format.sampleRate || parsed.channels !== format.channels)) throw fail('VOICE_PREVIEW_INVALID')
    const existing = getPreview({ cacheKey })
    if (existing) return { duplicate: true, audio: existing }
    await mkdir(previewDir, { recursive: true }); await mkdir(tmpDir, { recursive: true })
    const audioId = randomUUID(), rel = join('preview', `${audioId}.wav`), finalPath = safeRelative(rel), tempPath = join(tmpDir, `${audioId}.preview.part`)
    const sha256 = createHash('sha256').update(bytes).digest('hex'), createdAt = now()
    try {
      await open(tempPath, 'wx', 0o600).then(async file => { try { await file.writeFile(bytes); await file.sync() } finally { await file.close() } })
      await rename(tempPath, finalPath)
      try {
        db.prepare('INSERT INTO preview_audio(cache_key,audio_id,relative_path,format_json,duration_ms,bytes,sha256,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(cacheKey, audioId, rel, json(parsed), parsed.durationMs, bytes.length, sha256, createdAt, createdAt + 24 * 60 * 60 * 1000)
      } catch (error) { await rm(finalPath, { force: true }); throw error }
      await cleanup()
      return { duplicate: false, audio: { audioId, format: parsed, durationMs: parsed.durationMs, bytes: bytes.length, sha256, createdAt } }
    } catch (error) { await rm(tempPath, { force: true }); throw error }
  }
  function getPreview({ cacheKey }) {
    assertOpen()
    if (typeof cacheKey !== 'string' || !/^[a-f0-9]{64}$/.test(cacheKey)) return null
    const row = db.prepare('SELECT audio_id,format_json,duration_ms,bytes,sha256,created_at,expires_at FROM preview_audio WHERE cache_key=?').get(cacheKey)
    if (!row || row.expires_at <= now()) return null
    return previewSummary(row)
  }
  async function readPreview({ cacheKey }) {
    assertOpen()
    if (typeof cacheKey !== 'string' || !/^[a-f0-9]{64}$/.test(cacheKey)) throw fail('VOICE_AUDIO_NOT_FOUND')
    const row = db.prepare('SELECT audio_id,relative_path,bytes,sha256,format_json FROM preview_audio WHERE cache_key=? AND expires_at>?').get(cacheKey, now())
    if (!row) throw fail('VOICE_AUDIO_NOT_FOUND')
    const file = await open(safeRelative(row.relative_path), 'r')
    const info = await file.stat()
    if (info.size !== row.bytes || info.size > MAX_AUDIO_BYTES) { await file.close(); throw fail('VOICE_AUDIO_CORRUPT') }
    return { file, bytes: row.bytes, sha256: row.sha256, format: JSON.parse(row.format_json), audioId: row.audio_id, async close() { await file.close() } }
  }
  async function invalidatePreview({ cacheKey }) {
    assertOpen()
    const row = db.prepare('SELECT relative_path FROM preview_audio WHERE cache_key=?').get(cacheKey)
    if (!row) return false
    db.prepare('DELETE FROM preview_audio WHERE cache_key=?').run(cacheKey)
    await rm(safeRelative(row.relative_path), { force: true })
    return true
  }
  function close() { if (closed) return; closed = true; try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { db.close() } }
  return { saveLabelRule, getLabelRule, beginAudio, getAudioForSource, listAudio, readAudio, invalidateSource, storePreview, getPreview, readPreview, invalidatePreview, cleanup, close }
}

export { formatWav as inspectVoiceWav, wavHeader as createVoiceWavHeader }
