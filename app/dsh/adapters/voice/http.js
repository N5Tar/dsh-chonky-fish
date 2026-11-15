import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { runtimeInfo } from '../../../shared/platform/index.js'

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)) }
const errorCode = code => ({ UNAUTHORIZED: 401, FORBIDDEN: 403, METHOD_NOT_ALLOWED: 405, UNSUPPORTED_MEDIA_TYPE: 415, LIMIT_EXCEEDED: 413, INVALID_ARGUMENT: 400, STALE_LEASE: 409, LEASE_REQUIRED: 409, VOICE_BUSY: 409, UNSUPPORTED: 501, TTS_INVALID_TEXT: 400, TTS_CANCELLED: 409, TTS_TIMEOUT: 504, TTS_SPEECH_FAILED: 502, TTS_INVALID_WAV: 502, TTS_HELPER_FAILED: 502, MIGRATION_BUSY: 409 }[code] || 500)

async function readJson(req, maxBytes) {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(req.headers?.['content-type'] || '')) throw Object.assign(new Error(), { code: 'UNSUPPORTED_MEDIA_TYPE' })
  const declared = req.headers?.['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw Object.assign(new Error(), { code: 'LIMIT_EXCEEDED' })
  let size = 0; const chunks = []
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error(), { code: 'LIMIT_EXCEEDED' })
    chunks.push(chunk)
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) }
  catch (error) { if (error.code) throw error; throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' }) }
}

function validRef(ref) {
  return ref && typeof ref === 'object' && ['runtimeId', 'conversationId', 'bindingRevision'].every(key => typeof ref[key] === 'string' && ref[key].length > 0 && ref[key].length <= 512) && Object.keys(ref).every(key => ['runtimeId', 'conversationId', 'bindingRevision'].includes(key))
}
function equalRef(a, b) { return Boolean(a && b && a.runtimeId === b.runtimeId && a.conversationId === b.conversationId && a.bindingRevision === b.bindingRevision) }
function plainId(v) { return typeof v === 'string' && v.length > 0 && v.length <= 128 }

/** Host-only system synthesis, call ownership, capabilities, and fixed asset map. */
export function registerVoiceRoutes(ctx, { resources, ready, isClosed = () => false, assetRoot, tts }) {
  const connection = ctx.connection
  if (!connection || typeof connection.requestRejection !== 'function') throw new Error('DSH Connection request authentication is required for voice routes')
  const serviceGeneration = randomUUID()
  let lease = null
  let activeSynthesis = null
  let closed = false
  let serial = Promise.resolve()
  const serialize = fn => { const result = serial.then(fn); serial = result.catch(() => {}); return result }
  const routes = resources.routes
  const assetNames = new Set(['silero_vad.onnx', 'onnxruntime-web.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'vad.worker.js', 'capture.worklet.js'])
  const assetDirectory = resolve(assetRoot)
  // The model/runtime manifest lives under web/assets, while the small
  // application worker sources live one level above. Keep that mapping fixed
  // by logical filename; never accept manifest-supplied relative paths.
  const parentWebDirectory = resolve(assetDirectory, '..')
  const assetPathFor = name => name === 'vad.worker.js' || name === 'capture.worklet.js'
    ? resolve(parentWebDirectory, name)
    : resolve(assetDirectory, name)
  let assetManifestPromise
  const verifiedAssetBytes = new Map()
  function loadAssetManifest() {
    assetManifestPromise ||= readFile(join(assetDirectory, 'manifest.json'), 'utf8').then(text => {
      const manifest = JSON.parse(text)
      if (manifest?.version !== 1 || !manifest.files || typeof manifest.files !== 'object') throw Object.assign(new Error('Invalid voice asset manifest'), { code: 'ASSET_MANIFEST_INVALID' })
      const entries = new Map()
      for (const [name, entry] of Object.entries(manifest.files)) {
        if (!assetNames.has(entry?.file) || !/^[0-9a-f]{64}$/i.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !entry.key?.includes(entry.sha256)) throw Object.assign(new Error(`Invalid voice asset entry: ${name}`), { code: 'ASSET_MANIFEST_INVALID' })
        entries.set(entry.key, { name, ...entry })
      }
      return { manifest, entries }
    })
    return assetManifestPromise
  }

  function auth(req, res) {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return true
    json(res, rejection, { ok: false, error: { code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' } }); return false
  }
  function liveLease(callId, ownerId, generation) {
    if (!lease || lease.expiresAt <= Date.now()) { lease = null; stopSynthesis(); return false }
    return lease.callId === callId && lease.ownerId === ownerId && lease.leaseGeneration === generation
  }
  function stopSynthesis() { if (activeSynthesis) { activeSynthesis.controller.abort(); activeSynthesis = null } }
  function unavailable() { return closed || isClosed() }
  function register(path, handler) {
    return ctx.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
      if (!auth(req, res)) return
      try {
        await ready
        if (unavailable()) return json(res, 503, { ok: false, error: { code: 'UNAVAILABLE' } })
        if (resources.isMigrationBusy?.()) return json(res, 409, { ok: false, error: { code: 'MIGRATION_BUSY' } })
        await handler(req, res)
      } catch (error) { json(res, errorCode(error?.code), { ok: false, error: { code: error?.code || 'VOICE_FAILED' } }) }
    } })
  }

  const registrations = []
  registrations.push(register(routes.voiceCapabilities, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const capability = tts.inspect()
    let voices = []
    if (capability.supported) { try { voices = await tts.listVoices() } catch {} }
    const runtime = runtimeInfo()
    const body = { ok: true, contractVersion: 1, host: { ...runtime, local: runtime.os === 'win32' }, synthesis: { ...capability, voices }, ownership: { available: !lease || lease.expiresAt <= Date.now(), serviceGeneration, leaseMs: 15000, renewMs: 5000 }, assets: { endpoint: routes.voiceAssets } }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body))
  }))

  registrations.push(register(routes.voiceCalls, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const data = await readJson(req, resources.limits.voiceControlBodyBytes)
    const callKeys = data?.action === 'acquire' ? ['action', 'callId', 'ownerId', 'conversationRef'] : ['action', 'callId', 'ownerId', 'conversationRef', 'serviceGeneration', 'leaseGeneration']
    if (!['acquire', 'renew', 'release'].includes(data?.action) || Object.keys(data || {}).some(key => !callKeys.includes(key)) || !plainId(data.callId) || !plainId(data.ownerId) || !validRef(data.conversationRef) || data.action !== 'acquire' && (!plainId(data.leaseGeneration) || !plainId(data.serviceGeneration))) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    const result = await serialize(() => {
      if (data.action === 'acquire') {
        if (lease && lease.expiresAt > Date.now() && (lease.ownerId !== data.ownerId || lease.callId !== data.callId)) throw Object.assign(new Error(), { code: 'VOICE_BUSY' })
        if (lease && lease.expiresAt > Date.now() && !equalRef(lease.conversationRef, data.conversationRef)) throw Object.assign(new Error(), { code: 'STALE_LEASE' })
        stopSynthesis()
        lease = { callId: data.callId, ownerId: data.ownerId, conversationRef: data.conversationRef, leaseGeneration: randomUUID(), expiresAt: Date.now() + 15000 }
        return { serviceGeneration, leaseGeneration: lease.leaseGeneration, expiresInMs: 15000 }
      }
      if (data.serviceGeneration !== serviceGeneration || !liveLease(data.callId, data.ownerId, data.leaseGeneration) || !equalRef(lease.conversationRef, data.conversationRef)) throw Object.assign(new Error(), { code: 'STALE_LEASE' })
      if (data.action === 'renew') { lease.expiresAt = Date.now() + 15000; return { serviceGeneration, leaseGeneration: lease.leaseGeneration, expiresInMs: 15000 } }
      stopSynthesis(); lease = null; return { released: true, serviceGeneration }
    })
    json(res, 200, { ok: true, data: result })
  }))

  registrations.push(register(routes.voiceSynthesis, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const data = await readJson(req, resources.limits.voiceSynthesisBodyBytes)
    const synthKeys = ['callId', 'ownerId', 'leaseGeneration', 'serviceGeneration', 'operationId', 'conversationRef', 'text', 'voiceId', 'rate']
    if (Object.keys(data || {}).some(key => !synthKeys.includes(key)) || !plainId(data?.callId) || !plainId(data.ownerId) || !plainId(data.leaseGeneration) || !plainId(data.serviceGeneration) || !plainId(data.operationId) || !validRef(data.conversationRef) || typeof data.text !== 'string' || data.text.trim().length === 0 || data.text.length > resources.limits.voiceTextChars || typeof data.voiceId !== 'string' && data.voiceId !== null || typeof data.voiceId === 'string' && data.voiceId.length > 256 || !Number.isInteger(data.rate) || data.rate < -10 || data.rate > 10) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    if (data.serviceGeneration !== serviceGeneration || !liveLease(data.callId, data.ownerId, data.leaseGeneration) || !equalRef(lease.conversationRef, data.conversationRef)) throw Object.assign(new Error(), { code: 'STALE_LEASE' })
    if (activeSynthesis) throw Object.assign(new Error(), { code: 'VOICE_BUSY' })
    if (!tts.inspect().supported) throw Object.assign(new Error(), { code: 'UNSUPPORTED' })
    const controller = new AbortController(); const run = { callId: data.callId, ownerId: data.ownerId, operationId: data.operationId, controller }; activeSynthesis = run
    try {
      const { wav, info } = await tts.synthesize({ text: data.text, voiceId: data.voiceId, rate: data.rate, signal: controller.signal })
      if (activeSynthesis !== run || controller.signal.aborted || !liveLease(data.callId, data.ownerId, data.leaseGeneration)) throw Object.assign(new Error(), { code: 'TTS_CANCELLED' })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, data: { format: { codec: 'pcm_s16le', ...info }, wav: wav.toString('base64') } }))
    } finally { if (activeSynthesis === run) activeSynthesis = null }
  }))

  registrations.push(register(routes.voiceCancel, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const data = await readJson(req, resources.limits.voiceControlBodyBytes)
    const cancelKeys = ['callId', 'ownerId', 'leaseGeneration', 'serviceGeneration', 'operationId']
    if (Object.keys(data || {}).some(key => !cancelKeys.includes(key)) || !plainId(data?.callId) || !plainId(data.ownerId) || !plainId(data.leaseGeneration) || !plainId(data.serviceGeneration) || !plainId(data.operationId)) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    if (data.serviceGeneration !== serviceGeneration || !liveLease(data.callId, data.ownerId, data.leaseGeneration)) throw Object.assign(new Error(), { code: 'STALE_LEASE' })
    if (activeSynthesis?.callId === data.callId && activeSynthesis.ownerId === data.ownerId && activeSynthesis.operationId === data.operationId) stopSynthesis()
    json(res, 200, { ok: true, data: { cancelled: true } })
  }))

  registrations.push(register(routes.voiceAssets, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const key = new URL(req.url, 'http://localhost').searchParams.get('key')
    if (!key) return json(res, 404, { ok: false, error: { code: 'NOT_FOUND' } })
    const { manifest, entries } = await loadAssetManifest()
    if (key === 'manifest.json') {
      const bytes = Buffer.from(JSON.stringify(manifest))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : bytes)
      return
    }
    const asset = entries.get(key)
    if (!asset) return json(res, 404, { ok: false, error: { code: 'NOT_FOUND' } })
    const file = assetPathFor(asset.file)
    const expectedRoot = asset.file === 'vad.worker.js' || asset.file === 'capture.worklet.js' ? parentWebDirectory : assetDirectory
    if (relative(expectedRoot, file).startsWith('..' + sep) || relative(expectedRoot, file) === '..') return json(res, 404, { ok: false, error: { code: 'NOT_FOUND' } })
    let bytes = verifiedAssetBytes.get(key)
    if (!bytes) {
      bytes = await readFile(file)
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (bytes.length !== asset.bytes || hash !== asset.sha256.toLowerCase()) throw Object.assign(new Error(`Voice asset integrity check failed: ${asset.file}`), { code: 'ASSET_INTEGRITY_FAILED' })
      // A content-addressed key must never start serving replacement bytes
      // during this Host lifetime. Cache only after the digest is verified.
      verifiedAssetBytes.set(key, bytes)
    }
    const type = asset.file.endsWith('.wasm') ? 'application/wasm' : /\.(?:m?js)$/.test(asset.file) ? 'text/javascript; charset=utf-8' : 'application/octet-stream'
    const cache = 'public, max-age=31536000, immutable'
    res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': cache, 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : bytes)
  }))

  return {
    close() { closed = true; stopSynthesis(); lease = null; tts.close?.(); for (const dispose of registrations) { try { dispose() } catch {} } },
    inspect() { return { serviceGeneration, lease: lease && { callId: lease.callId, ownerId: lease.ownerId, expiresAt: lease.expiresAt }, synthesizing: Boolean(activeSynthesis) } },
  }
}
