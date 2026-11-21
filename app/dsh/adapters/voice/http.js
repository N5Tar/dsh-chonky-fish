import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { runtimeInfo } from '../../../shared/platform/index.js'
import { createDshForeground } from './foreground.js'
import { DEFAULT_VOICE_CONFIG, validateVoiceConfig } from '../../../../core/modules/voice/config.js'
import { VOICE_LIMITS, parseSpeechReply } from '../../../../core/modules/voice/index.js'
import { messageText } from '../../../../core/modules/event-engine/domain/contracts.js'
import { createVoiceRepository, createVoiceWavHeader } from '../../../shared/storage/voice/repository.js'
import { createVoiceOperationManager } from '../../../shared/voice/operations.js'
import { createVoiceProviders } from '../../../shared/voice/providers/index.js'

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)) }
const errorCode = code => ({ UNAUTHORIZED: 401, FORBIDDEN: 403, METHOD_NOT_ALLOWED: 405, UNSUPPORTED_MEDIA_TYPE: 415, LIMIT_EXCEEDED: 413, INVALID_ARGUMENT: 400, STALE_LEASE: 409, LEASE_REQUIRED: 409, VOICE_BUSY: 409, VOICE_OPERATION_IN_PROGRESS: 409, VOICE_OPERATION_CONFLICT: 409, VOICE_OPERATION_ALREADY_COMPLETED: 409, VOICE_SOURCE_CONFLICT: 409, VOICE_SOURCE_CAPACITY: 409, VOICE_SOURCE_UNAVAILABLE: 503, VOICE_SOURCE_STALE: 409, VOICE_SOURCE_REJECTED: 409, VOICE_SCOPE_DENIED: 403, VOICE_AUDIO_NOT_FOUND: 404, VOICE_AUDIO_CORRUPT: 404, VOICE_AUDIO_READ_TIMEOUT: 504, VOICE_STORE_UNAVAILABLE: 503, VOICE_PROVIDER_NOT_CONFIGURED: 409, UNSUPPORTED: 501, TTS_INVALID_TEXT: 400, TTS_INVALID_EXPRESSION: 400, TTS_CANCELLED: 409, TTS_TIMEOUT: 504, TTS_LIMIT_EXCEEDED: 413, TTS_PROVIDER_FAILED: 502, TTS_INCOMPLETE: 502, TTS_INVALID_WAV: 502, TTS_INVALID_AUDIO: 502, MISSING_CREDENTIAL: 409, INVALID_CREDENTIAL: 403, VOICE_BINDING_STALE: 409, MIGRATION_BUSY: 409 }[code] || 500)

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
export function registerVoiceRoutes(ctx, { resources, ready, isClosed = () => false, assetRoot, tts, foreground: suppliedForeground, sourcePolicy: suppliedSourcePolicy, sessionQuery: suppliedSessionQuery, repository: suppliedRepository, providers: suppliedProviders, logger = ctx.logger } = {}) {
  const connection = ctx.connection
  if (!connection || typeof connection.requestRejection !== 'function') throw new Error('DSH Connection request authentication is required for voice routes')
  const serviceGeneration = randomUUID()
  const foreground = suppliedForeground || (ctx.agents && typeof ctx.on === 'function' ? createDshForeground({ ctx, ownerPath: resources.paths?.workspace }) : null)
  const sourcePolicy = suppliedSourcePolicy || null
  const sessionQuery = suppliedSessionQuery || (typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null)
  const providerRegistry = suppliedProviders || createVoiceProviders({ getConfig: () => resources.getConfig(), windowsTts: tts })
  const operations = createVoiceOperationManager({ repository: null, logger })
  let repository = suppliedRepository || null, repositoryPromise = null
  const sourcePolicyRepository = Object.freeze({
    modelHistoryProjectionVerified: false,
    saveLabelRule(value) { return repository?.saveLabelRule?.(value) === true },
    getLabelRule(value) { return repository?.getLabelRule?.(value) || null },
  })
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
  const getRepository = async () => {
    if (repository) return repository
    if (!resources.paths?.voice || !resources.paths?.voiceDatabase) return null
    repositoryPromise ||= import('node:sqlite').then(({ DatabaseSync }) => {
      repository = createVoiceRepository({ root: resources.paths.voice, dbPath: resources.paths.voiceDatabase, DatabaseSync, maxBytes: resources.limits.voiceMaxSavedBytes, maxFiles: resources.limits.voiceMaxSavedFiles, retentionMs: resources.limits.voiceRetentionMs })
      return repository
    }).catch(error => { repositoryPromise = null; try { logger?.warn?.('[chonkyfish/voice] voice archive unavailable', error?.code || error) } catch {}; return null })
    return repositoryPromise
  }
  const ownerFor = sessionId => ({ namespaceId: String(resources.home || resources.dshHome || 'chonkyfish'), sessionId })
  async function currentAssistantSeqs(sessionId) {
    if (typeof sessionQuery?.listEvents !== 'function') throw Object.assign(new Error(), { code: 'VOICE_SOURCE_UNAVAILABLE' })
    const events = await sessionQuery.listEvents(sessionId)
    return new Set((Array.isArray(events) ? events : []).filter(item => item?.type === 'assistant/message' && (!item.surface || item.surface === 'current')).map(item => Number(item.seq)).filter(Number.isSafeInteger))
  }
  async function isVisibleOwnedSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false
    const snapshot = ctx.sessions?.list?.getSnapshot?.() || (typeof ctx.get === 'function' ? ctx.get('sessions')?.list?.getSnapshot?.() : null)
    const summary = snapshot?.byId?.[sessionId] || snapshot?.entries?.find?.(entry => (entry?.sessionId || entry?.id) === sessionId)
    if (snapshot && (!summary || summary.removed === true)) return false
    const summaryCwd = summary?.cwd || summary?.header?.cwd
    if (summaryCwd && summaryCwd !== resources.paths?.workspace) return false
    let header = summary?.header || null
    if (!header) {
      try {
        const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null
        header = (await persistence?.stat?.(sessionId))?.header || null
      } catch { return false }
    }
    if (!header) {
      try { header = ctx.agents?.get?.(sessionId)?.session?.header || null } catch {}
    }
    return Boolean(header && header.agentPreset === 'chonkyfish' && header.cwd === resources.paths?.workspace)
  }
  const currentVoice = () => resources.getConfig()?.voice || null
  function previewBinding(value) {
    if (value === undefined) return { ...providerRegistry.getBinding() }
    const allowed = ['providerId', 'modelId', 'region', 'workspaceId', 'credentialRef']
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || typeof value.providerId !== 'string') throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    try { return { ...validateVoiceConfig({ ...DEFAULT_VOICE_CONFIG, tts: { ...DEFAULT_VOICE_CONFIG.tts, ...value } }).tts } }
    catch { throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' }) }
  }
  const publicSettings = (storedVoice = null) => {
    const voice = storedVoice || currentVoice(), binding = { ...(voice?.tts || {}) }, provider = providerRegistry.getProvider()
    const providerInfo = provider ? providerRegistry.inspect(provider.binding) : { supported: false, audioOutput: 'unknown', emotionSupported: false, emotionTags: [] }
    const credentialConfigured = provider?.credentialConfigured === true
    return { version: voice?.version || 1, tts: binding, credentialConfigured, capabilities: { providerId: provider?.providerId || binding.providerId, audioOutput: providerInfo.audioOutput || 'unknown', emotionSupported: providerInfo.emotionSupported === true, emotionTags: providerInfo.emotionTags || [], conversationEmotionEnabled: false, stream: providerInfo.audioOutput === 'stream' } }
  }
  const sse = value => `data: ${JSON.stringify(value)}\n\n`
  async function writeSse(res, value) {
    if (res.destroyed || res.writableEnded) throw Object.assign(new Error('Client disconnected'), { code: 'TTS_CANCELLED' })
    if (!res.write(sse(value))) await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve() }, error = e => { cleanup(); reject(e) }
      const cleanup = () => { res.off?.('drain', done); res.off?.('close', error); res.off?.('error', error) }
      res.once?.('drain', done); res.once?.('close', error); res.once?.('error', error)
    })
  }
  async function streamEvents(res, iterable, onCancel) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'keep-alive' })
    let ended = false
    const close = () => { if (!ended) onCancel?.() }
    res.once?.('close', close)
    try {
      for await (const event of iterable) {
        if (event.type === 'audio') await writeSse(res, { type: 'audio', data: Buffer.from(event.data).toString('base64'), format: event.format })
        else if (event.type === 'complete') await writeSse(res, { type: 'complete', receipt: event.receipt || {} })
      }
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) { try { await writeSse(res, { type: 'error', code: error?.code || 'TTS_FAILED' }) } catch {} }
    } finally { ended = true; res.off?.('close', close); if (!res.writableEnded && !res.destroyed) res.end() }
  }
  registrations.push(register(routes.voiceCapabilities, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const binding = providerRegistry.getBinding()
    const provider = providerRegistry.providerFor(binding)
    const capability = provider?.inspect(binding) || { supported: false, providerId: binding.providerId, reason: 'VOICE_PROVIDER_UNAVAILABLE' }
    let voices = []
    if (capability.supported) { try { voices = await provider.listVoices(binding) } catch {} }
    const runtime = runtimeInfo()
    const body = { ok: true, contractVersion: 1, host: { ...runtime, local: runtime.os === 'win32' }, synthesis: { ...capability, providerId: binding.providerId, modelId: binding.modelId || null, voiceId: binding.voiceId || null, voices }, ownership: { available: !lease || lease.expiresAt <= Date.now(), serviceGeneration, leaseMs: 15000, renewMs: 5000 }, assets: { endpoint: routes.voiceAssets } }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body))
  }))

  registrations.push(register(routes.voiceSettings, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { ok: true, data: publicSettings() })
    if (req.method !== 'PUT') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const data = await readJson(req, resources.limits.voiceControlBodyBytes)
    if (!data || Object.keys(data).some(key => key !== 'tts')) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    const current = currentVoice() || {}
    let next
    try { next = validateVoiceConfig({ ...current, tts: { ...(current.tts || {}), ...(data.tts || {}) } }) }
    catch (error) { throw Object.assign(error, { outcome: 'not_applied' }) }
    const result = await resources.updateConfig({ voice: next })
    json(res, 200, { ok: true, data: publicSettings(result?.voice) })
  }))

  registrations.push(register(routes.voiceSources, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const data = await readJson(req, resources.limits.voiceSynthesisBodyBytes)
    const allowed = ['action', 'callId', 'ownerId', 'serviceGeneration', 'leaseGeneration', 'conversationRef', 'inputId', 'submissionId', 'text']
    if (Object.keys(data || {}).some(key => !allowed.includes(key)) || !['register', 'release'].includes(data?.action || 'register') || !plainId(data?.callId) || !plainId(data?.ownerId) || !plainId(data?.serviceGeneration) || !plainId(data?.leaseGeneration) || !validRef(data?.conversationRef) || data.action !== 'release' && !plainId(data?.inputId) || !plainId(data?.submissionId) || data.action !== 'release' && (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > resources.limits.voiceTextChars)) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    if (data.serviceGeneration !== serviceGeneration || !liveLease(data.callId, data.ownerId, data.leaseGeneration) || !equalRef(lease.conversationRef, data.conversationRef)) throw Object.assign(new Error(), { code: 'STALE_LEASE' })
    if (data.action === 'release') {
      if (!sourcePolicy?.release) throw Object.assign(new Error(), { code: 'VOICE_SOURCE_UNAVAILABLE' })
      await sourcePolicy.release?.({ conversationRef: data.conversationRef, submissionId: data.submissionId, callRef: { callId: data.callId, ownerId: data.ownerId } })
      return json(res, 200, { ok: true, data: { released: true } })
    }
    if (!sourcePolicy?.register) throw Object.assign(new Error(), { code: 'VOICE_SOURCE_UNAVAILABLE', outcome: 'not_applied' })
    const result = await sourcePolicy.register({ conversationRef: data.conversationRef, inputId: data.inputId, submissionId: data.submissionId, text: data.text, callRef: { callId: data.callId, ownerId: data.ownerId } })
    if (!result) throw Object.assign(new Error(), { code: 'VOICE_SOURCE_REJECTED', outcome: 'not_applied' })
    json(res, 200, { ok: true, data: { registered: true, duplicate: result?.duplicate === true } })
  }))

  registrations.push(register(routes.voicePreview, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const data = await readJson(req, resources.limits.voiceControlBodyBytes)
    if (data?.action === 'catalog') {
      if (Object.keys(data || {}).some(key => !['action', 'binding'].includes(key))) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
      const binding = previewBinding(data.binding)
      const provider = providerRegistry.providerFor(binding)
      const voices = provider ? await provider.listVoices(binding) : []
      const capability = provider?.inspect(binding) || { supported: false, audioOutput: 'unknown', emotionSupported: false, emotionTags: [] }
      return json(res, 200, { ok: true, data: { providerId: binding.providerId, modelId: binding.modelId || null, voices, audioOutput: capability.audioOutput || 'unknown', emotionTags: capability.emotionTags || [], credentialConfigured: capability.credentialConfigured === true, workspaceConfigured: binding.providerId !== 'aliyun-qwen-tts' || Boolean(binding.workspaceId), officialSampleStatus: 'unverified' } })
    }
    const keys = ['action', 'binding', 'operationId', 'text', 'voiceId', 'rate', 'emotionTag']
    if (data?.action !== 'synthesize' || Object.keys(data || {}).some(key => !keys.includes(key)) || !plainId(data.operationId) || typeof data.text !== 'string' || !data.text.trim() || data.text.length > resources.limits.voicePreviewTextChars || typeof data.voiceId !== 'string' || data.voiceId.length > 200 || !Number.isInteger(data.rate ?? 0) || (data.rate ?? 0) < -10 || (data.rate ?? 0) > 10 || data.emotionTag != null && typeof data.emotionTag !== 'string') throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    const binding = { ...previewBinding(data.binding), voiceId: data.voiceId, rate: data.rate ?? 0 }
    const provider = providerRegistry.providerFor(binding), capability = provider?.inspect(binding)
    if (!provider || !capability?.supported) throw Object.assign(new Error(), { code: 'UNSUPPORTED' })
    if (binding.providerId === 'aliyun-qwen-tts' && (!binding.workspaceId || !binding.credentialRef)) throw Object.assign(new Error(), { code: 'VOICE_PROVIDER_NOT_CONFIGURED' })
    if (!capability.credentialConfigured && binding.providerId === 'aliyun-qwen-tts') throw Object.assign(new Error(), { code: 'MISSING_CREDENTIAL' })
    if (data.emotionTag && (!capability.emotionSupported || !capability.emotionTags?.includes(data.emotionTag))) throw Object.assign(new Error(), { code: 'TTS_INVALID_EXPRESSION' })
    const archive = await getRepository()
    const cacheKey = createHash('sha256').update(JSON.stringify({ providerId: binding.providerId, modelId: binding.modelId || null, region: binding.region || null, workspaceId: binding.workspaceId || null, voiceId: binding.voiceId, rate: binding.rate, text: data.text, emotionTag: data.emotionTag || null })).digest('hex')
    if (archive) {
      try {
        const cached = archive.getPreview({ cacheKey })
        if (cached) {
          const opened = await archive.readPreview({ cacheKey })
          try {
            const bytes = await opened.file.readFile()
            if (createHash('sha256').update(bytes).digest('hex') === opened.sha256) {
              await streamEvents(res, (async function* () { yield { type: 'audio', data: new Uint8Array(bytes), format: { codec: 'wav', sampleRate: opened.format.sampleRate, channels: opened.format.channels } }; yield { type: 'complete', receipt: { cached: true, audioId: opened.audioId } } })(), () => {})
              return
            }
            await archive.invalidatePreview?.({ cacheKey })
          } finally { await opened.close() }
        }
      } catch (error) {
        try { await archive.invalidatePreview?.({ cacheKey }) } catch {}
        try { logger?.warn?.('[chonkyfish/voice] preview cache read failed', error?.code || error) } catch {}
      }
    }
    const run = operations.run({ operationId: data.operationId, owner: ownerFor(`preview:${data.operationId}`), source: { sessionId: `preview:${data.operationId}`, seq: 0 }, text: data.text, voiceId: data.voiceId, provider, binding, save: false, expressionTag: data.emotionTag || null })
    const events = (async function* () {
      const chunks = []; let format = null, total = 0
      for await (const event of run.events) {
        if (event.type === 'audio') {
          format ||= event.format
          total += event.data.byteLength
          if (total <= 12 * 1024 * 1024) chunks.push(Buffer.from(event.data))
          yield event
        } else if (event.type === 'complete') {
          if (archive && total > 0 && total <= 12 * 1024 * 1024 && format) {
            try {
              let wav
              if (format.codec === 'pcm_s16le') {
                const pcm = Buffer.concat(chunks, total), header = createVoiceWavHeader(pcm.length, format)
                wav = Buffer.concat([header, pcm])
              } else if (format.codec === 'wav' && chunks.length === 1) wav = chunks[0]
              if (wav) await archive.storePreview({ cacheKey, bytes: wav, format })
            } catch (error) { try { logger?.warn?.('[chonkyfish/voice] preview cache write failed', error?.code || error) } catch {} }
          }
          yield event
        }
      }
    })()
    await streamEvents(res, events, () => run.cancel('preview-client-disconnected'))
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

  registrations.push(register(routes.voiceForeground, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const data = await readJson(req, resources.limits.voiceControlBodyBytes)
    const common = ['action', 'callId', 'ownerId', 'conversationRef', 'serviceGeneration', 'leaseGeneration']
    const extra = data?.action === 'inspect' ? [] : data?.action === 'query' ? ['interruptionId'] : ['interruptionId', 'expected', 'acceptedInputId', 'acceptedSubmissionId']
    const leaseFields = ['callId', 'ownerId', 'leaseGeneration'].filter(key => data?.[key] !== undefined)
    const hasLease = leaseFields.length === 3
    if (!['inspect', 'interrupt', 'query'].includes(data?.action) || Object.keys(data || {}).some(key => ![...common, ...extra].includes(key)) || !validRef(data?.conversationRef) || data.serviceGeneration !== serviceGeneration || !plainId(data.serviceGeneration) || leaseFields.length !== 0 && !hasLease || hasLease && (!plainId(data.callId) || !plainId(data.ownerId) || !plainId(data.leaseGeneration)) || data.action !== 'inspect' && !plainId(data.interruptionId) || data.action === 'interrupt' && (!plainId(data.acceptedInputId) || !plainId(data.acceptedSubmissionId) || !data.expected || Object.keys(data.expected).some(key => !['conversationTurnId', 'responseId', 'stepId'].includes(key)) || !['conversationTurnId', 'responseId', 'stepId'].every(key => plainId(data.expected[key])))) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    if (hasLease && (!liveLease(data.callId, data.ownerId, data.leaseGeneration) || !equalRef(lease.conversationRef, data.conversationRef))) throw Object.assign(new Error(), { code: 'STALE_LEASE' })
    if (!foreground) return json(res, 200, { ok: true, data: { available: false, valid: true, reason: 'unavailable' } })
    const result = data.action === 'inspect'
      ? await foreground.inspect(data.conversationRef)
      : data.action === 'query'
        ? await foreground.query({ conversationRef: data.conversationRef, interruptionId: data.interruptionId })
        : await foreground.interrupt({ conversationRef: data.conversationRef, interruptionId: data.interruptionId, expected: data.expected, acceptedInputId: data.acceptedInputId, acceptedSubmissionId: data.acceptedSubmissionId })
    json(res, 200, { ok: true, data: result })
  }))

  registrations.push(register(routes.voiceSynthesis, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const data = await readJson(req, resources.limits.voiceSynthesisBodyBytes)
    const synthKeys = ['callId', 'ownerId', 'leaseGeneration', 'serviceGeneration', 'operationId', 'conversationRef', 'source', 'voiceId', 'rate']
    const configuredBinding = providerRegistry.getBinding()
    const validVoiceId = configuredBinding.providerId === 'windows-system-speech'
      ? data?.voiceId === null || typeof data?.voiceId === 'string' && data.voiceId.length > 0 && data.voiceId.length <= 256
      : typeof data?.voiceId === 'string' && data.voiceId.length > 0 && data.voiceId.length <= 256
    if (Object.keys(data || {}).some(key => !synthKeys.includes(key)) || !plainId(data?.callId) || !plainId(data.ownerId) || !plainId(data.leaseGeneration) || !plainId(data.serviceGeneration) || !plainId(data.operationId) || !validRef(data.conversationRef) || data?.source?.sessionId !== data?.conversationRef?.conversationId || !Number.isSafeInteger(data?.source?.seq) || data.source.seq < 0 || Object.keys(data.source || {}).some(key => !['sessionId', 'seq'].includes(key)) || !validVoiceId || !Number.isInteger(data.rate) || data.rate < -10 || data.rate > 10) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    if (data.serviceGeneration !== serviceGeneration || !liveLease(data.callId, data.ownerId, data.leaseGeneration) || !equalRef(lease.conversationRef, data.conversationRef)) throw Object.assign(new Error(), { code: 'STALE_LEASE' })
    if (activeSynthesis) throw Object.assign(new Error(), { code: 'VOICE_BUSY' })
    if (configuredBinding.providerId === 'aliyun-qwen-tts' && data.voiceId !== configuredBinding.voiceId) throw Object.assign(new Error(), { code: 'VOICE_BINDING_STALE' })
    const binding = { ...configuredBinding, voiceId: data.voiceId, rate: data.rate }
    const provider = providerRegistry.providerFor(binding), capability = provider?.inspect(binding)
    if (!provider || !capability?.supported) throw Object.assign(new Error(), { code: 'UNSUPPORTED' })
    if (binding.providerId === 'aliyun-qwen-tts' && !capability.credentialConfigured) throw Object.assign(new Error(), { code: 'MISSING_CREDENTIAL' })
    if (!sessionQuery || typeof sessionQuery.listEvents !== 'function' || typeof sessionQuery.readEvent !== 'function') throw Object.assign(new Error(), { code: 'VOICE_SOURCE_UNAVAILABLE' })
    const eventIndex = await sessionQuery.listEvents(data.source.sessionId)
    const meta = eventIndex?.find(item => Number(item.seq) === data.source.seq)
    if (!meta || meta.type !== 'assistant/message' || meta.surface && meta.surface !== 'current') throw Object.assign(new Error(), { code: 'VOICE_SOURCE_STALE' })
    const window = await sessionQuery.readEvent({ sessionId: data.source.sessionId, seq: data.source.seq, before: 0, after: 0 })
    const event = window?.target || window?.event || null
    if (!event || event.type !== 'assistant/message' || event.seq !== data.source.seq || event.surface && event.surface !== 'current' || event.surfaceOp !== undefined && event.surfaceOp !== 'append') throw Object.assign(new Error(), { code: 'VOICE_SOURCE_STALE' })
    const rawText = messageText(event.data?.message?.content)
    if (!rawText.trim() || rawText.length > resources.limits.voiceTextChars) throw Object.assign(new Error(), { code: rawText.length ? 'TTS_LIMIT_EXCEEDED' : 'TTS_INVALID_TEXT' })
    if (typeof sourcePolicy?.assertReply !== 'function' || sourcePolicy.assertReply({ conversationRef: data.conversationRef, source: data.source, event }) !== true) throw Object.assign(new Error(), { code: 'VOICE_SOURCE_STALE' })
    const archive = await getRepository(); operations.setRepository(archive)
    let allowedTags = []
    const turn = event.data?.turn, step = event.data?.step
    if (archive && Number.isSafeInteger(turn) && Number.isSafeInteger(step) && capability.emotionSupported) {
      try {
        const rule = archive.getLabelRule?.({ requestId: `${data.source.sessionId}:${turn}:${step}`, owner: ownerFor(data.source.sessionId) })
        const current = providerRegistry.getProvider()
        if (rule && rule.providerId === binding.providerId && rule.modelId === (binding.modelId || null) && rule.voiceId === (binding.voiceId || null)
          && current?.providerId === binding.providerId && current?.modelId === (binding.modelId || null) && current?.voiceId === (binding.voiceId || null)
          && Array.isArray(rule.tags) && Array.isArray(capability.emotionTags)) {
          allowedTags = [...new Set(rule.tags.filter(tag => typeof tag === 'string' && capability.emotionTags.includes(tag)))]
        }
      } catch { allowedTags = [] }
    }
    const parsed = parseSpeechReply(rawText, { allowedTags, maxChars: VOICE_LIMITS.replyChars })
    if (!parsed.synthesisText.trim()) throw Object.assign(new Error(), { code: 'TTS_INVALID_TEXT' })
    if (parsed.overLimit) throw Object.assign(new Error(), { code: 'TTS_LIMIT_EXCEEDED' })
    const controller = new AbortController(); const run = { callId: data.callId, ownerId: data.ownerId, operationId: data.operationId, controller }; activeSynthesis = run
    try {
      const operation = operations.run({
        operationId: data.operationId, owner: ownerFor(data.source.sessionId), source: data.source, text: parsed.synthesisText,
        voiceId: data.voiceId || 'system-default', provider, binding, signal: controller.signal,
        isCurrent: () => activeSynthesis === run && !controller.signal.aborted && liveLease(data.callId, data.ownerId, data.leaseGeneration)
          && sourcePolicy.assertReply({ conversationRef: data.conversationRef, source: data.source, event }) === true,
      })
      run.cancel = operation.cancel
      await streamEvents(res, operation.events, () => { controller.abort(); operation.cancel('client-disconnected') })
    } finally { if (activeSynthesis === run) activeSynthesis = null }
  }))

  registrations.push(register(routes.voiceAudio, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    const query = new URL(req.url, 'http://localhost').searchParams
    const sessionId = query.get('sessionId'), audioId = query.get('audioId')
    if (!plainId(sessionId)) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    if (!await isVisibleOwnedSession(sessionId)) throw Object.assign(new Error(), { code: 'VOICE_SCOPE_DENIED' })
    const archive = await getRepository()
    if (!archive) throw Object.assign(new Error(), { code: 'VOICE_STORE_UNAVAILABLE' })
    const owner = ownerFor(sessionId)
    if (!audioId) {
      const rawSeqs = query.get('seqs') || ''
      const seqs = rawSeqs ? rawSeqs.split(',').map(value => Number(value)) : []
      if (seqs.length > 200 || seqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
      const current = await currentAssistantSeqs(sessionId)
      const validSeqs = seqs.filter(seq => current.has(seq))
      for (const seq of seqs) if (!current.has(seq)) await archive.invalidateSource({ owner, source: { sessionId, seq } })
      const items = archive.listAudio({ owner, sessionId, seqs: validSeqs })
      return json(res, 200, { ok: true, data: { items } })
    }
    const opened = await archive.readAudio({ audioId, owner, sessionId })
    let finished = false, disconnected = false
    const onClose = () => { if (!finished) { disconnected = true; opened.cancel?.() } }
    res.once?.('close', onClose)
    try {
      const current = await currentAssistantSeqs(sessionId)
      if (!current.has(opened.source.seq)) {
        await archive.invalidateSource({ owner, source: opened.source })
        throw Object.assign(new Error(), { code: 'VOICE_AUDIO_NOT_FOUND' })
      }
      if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': opened.bytes, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end() }
      if (disconnected) return
      if (opened.signal?.aborted) throw opened.signal.reason || Object.assign(new Error(), { code: 'VOICE_AUDIO_READ_CANCELLED' })
      const chunks = []
      const stream = opened.file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, ...(opened.signal ? { signal: opened.signal } : {}) })
      for await (const chunk of stream) {
        if (opened.signal?.aborted) throw opened.signal.reason || Object.assign(new Error(), { code: 'VOICE_AUDIO_READ_CANCELLED' })
        chunks.push(Buffer.from(chunk))
      }
      if (opened.signal?.aborted || disconnected) throw opened.signal?.reason || Object.assign(new Error(), { code: 'VOICE_AUDIO_READ_CANCELLED' })
      const bytes = Buffer.concat(chunks, opened.bytes)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== opened.sha256) {
        await archive.invalidateSource({ owner, source: opened.source })
        throw Object.assign(new Error(), { code: 'VOICE_AUDIO_CORRUPT' })
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      finished = true
      res.end(bytes)
    } catch (error) {
      if (disconnected) return
      if (opened.signal?.aborted && opened.signal.reason?.code === 'VOICE_AUDIO_READ_TIMEOUT') throw opened.signal.reason
      throw error
    } finally { finished = true; res.off?.('close', onClose); await opened.close() }
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
    repository: sourcePolicyRepository,
    isConversationActive(sessionId) { return !unavailable() && Boolean(lease && lease.expiresAt > Date.now() && lease.conversationRef.conversationId === sessionId) },
    close() { closed = true; stopSynthesis(); operations.close(); lease = null; foreground?.dispose?.(); try { if (typeof sourcePolicy?.dispose === 'function') sourcePolicy.dispose(); else sourcePolicy?.close?.() } catch {}; providerRegistry.close?.(); repository?.close?.(); for (const dispose of registrations) { try { dispose() } catch {} } },
    inspect() { return { serviceGeneration, lease: lease && { callId: lease.callId, ownerId: lease.ownerId, expiresAt: lease.expiresAt }, synthesizing: Boolean(activeSynthesis) } },
  }
}
