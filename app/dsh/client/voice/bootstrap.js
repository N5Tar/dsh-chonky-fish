import { createVoiceService, DEFAULT_VOICE_CONFIG, validateVoiceConfig } from '../../../../core/modules/voice/index.js'
import { createMemoryAudioStore, createWebCapture, createWebPlayback } from '../../../shared/audio/index.js'
import { createDshSpeech } from './speech.js'
import { createDshHostVoice } from './host.js'
import { resolveVoiceAssets } from './assets.js'
import { createDshConversation } from '../../adapters/voice/conversation.js'
import { createVoiceComposerControl } from '../../ui/voice/composer.js'
import { createVoiceResetBarrier, finishVoiceResetCall } from './reset-lifecycle.js'

export { createVoiceResetBarrier, createVoiceComposerControl }

const makeId = kind => `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
const clock = {
  monoNow: () => globalThis.performance?.now?.() ?? Date.now(),
  schedule: (fn, delay) => globalThis.setTimeout(fn, delay),
  cancel: handle => globalThis.clearTimeout(handle),
}

function requestJson(endpoint) {
  return fetch(endpoint, { method: 'GET', credentials: 'same-origin', cache: 'no-store' }).then(async response => {
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) throw Object.assign(new Error(payload?.error?.code || `请求失败 (${response.status})`), { code: payload?.error?.code || 'VOICE_CONFIG_UNAVAILABLE' })
    return payload
  })
}

/** Client composition root. It outlives individual panel pages through shell.overlay. */
export function createDshVoiceController({ ctx, chat, routes }) {
  if (!ctx || !chat || !routes) throw new TypeError('Voice bootstrap requires DSH context, chat bridge, and routes')
  const audio = createMemoryAudioStore()
  const playback = createWebPlayback({ audioStore: audio })
  const host = createDshHostVoice({ routes })
  let speechContext = null
  const speech = createDshSpeech({ getRemote: () => speechContext, audioStore: audio })
  const listeners = new Set()
  let service = null, capture = null, speechStatus = null, hostStatus = null, assetURLs = null, config = null, voiceSettings = null;
  let setupPromise = null, disposed = false, prepController = null, snapshot = null, localFailure = null, remoteInjection = null, startGeneration = 0, removeVoiceReset = null, resetInProgress = false
  let startupPending = false, startPromise = null
  let replyAudioPromise = null
  let previewOperation = null, storedAudioOperation = null
  let configRevision = null

  // Optional DSH services must be acquired through Cordis injection. The overlay
  // remains mounted while the experimental speech bundle is absent.
  try {
    remoteInjection = ctx.inject(['remote.speech'], injectedCtx => {
      if (disposed) return
      speechContext = injectedCtx
      speech.setRemote(injectedCtx)
      setupPromise = null
      speechStatus = null
      localFailure = null
      publish()
      return () => {
        if (speechContext !== injectedCtx) return
        speechContext = null
        speech.setRemote(null)
        setupPromise = null
        speechStatus = null
        prepController?.abort()
        if (service && service.getSnapshot().call?.inputEnabled !== false) {
          const oldService = service
          service = null
          capture = null
          void oldService.hangup().finally(() => oldService.dispose())
        }
        if (service?.getSnapshot().call?.inputEnabled !== false) localFailure = { code: 'DSH_SPEECH_REMOTE_UNAVAILABLE', stage: 'capabilities', message: '当前 DSH 未提供语音识别 Remote', outcome: 'not_applied' }
        publish()
      }
    })
    Promise.resolve(remoteInjection).catch(error => {
      if (disposed) return
      localFailure = { code: 'DSH_SPEECH_REMOTE_UNAVAILABLE', stage: 'capabilities', message: error?.message || '当前 DSH 未提供语音识别 Remote', outcome: 'not_applied' }
      publish()
    })
  } catch (error) {
    // A not-yet-mounted optional service is a capability state, not an overlay
    // mount failure. Cordis will normally resolve this through the injector.
    localFailure = { code: 'DSH_SPEECH_REMOTE_UNAVAILABLE', stage: 'capabilities', message: error?.message || '当前 DSH 未提供语音识别 Remote', outcome: 'not_applied' }
  }

  function publish() {
    const current = service ? service.getSnapshot() : {
      call: { status: 'idle', id: null, conversationRef: null }, capture: { status: 'stopped', muted: false },
      inputs: [], playback: { status: 'idle', enabled: config?.replyAudioEnabled !== false, replyId: null }, queue: { unresolved: 0, waiting: 0 }, error: localFailure,
    }
    snapshot = { ...current, error: current.error || localFailure, startupPending }
    for (const listener of listeners) { try { listener(snapshot) } catch {} }
  }

  if (typeof chat.onVoiceReset === 'function') {
    removeVoiceReset = chat.onVoiceReset(async () => {
      resetInProgress = true
      ++startGeneration
      startupPending = false
      startPromise = null
      const stopPreparation = prepController ? cancelPreparation().catch(() => {}) : Promise.resolve()
      const setupBeforeReset = setupPromise
      const oldService = service
      try {
        await Promise.all([finishVoiceResetCall({ service: oldService, playback, setupPromise: setupBeforeReset, hangupOptions: { abandonPending: true } }), stopPreparation])
      } finally {
        localFailure = null
        publish()
        resetInProgress = false
      }
    })
  }

  function ensureSetup() {
    if (disposed) throw Object.assign(new Error('语音控制器已关闭'), { code: 'VOICE_CONTROLLER_DISPOSED', outcome: 'not_applied' })
    if (resetInProgress || chat.isVoiceResetting?.()) throw Object.assign(new Error('大肥鱼会话正在切换，请稍后重试'), { code: 'VOICE_TARGET_RESETTING', outcome: 'not_applied' })
    // Optional ASR can mount/unmount while output is live. Keep the existing
    // core, subscription and lease; input readiness is checked separately.
    if (service) return Promise.resolve({ hostStatus, speechStatus, config })
    if (setupPromise) return setupPromise
    setupPromise = (async () => {
      hostStatus = await host.capabilities()
      if (disposed) throw Object.assign(new Error('语音控制器已关闭'), { code: 'VOICE_CONTROLLER_DISPOSED', outcome: 'not_applied' })
      if (!hostStatus?.ownership) throw Object.assign(new Error('本机语音运行环境不可用'), { code: 'VOICE_HOST_UNSUPPORTED' })
      voiceSettings = await host.readVoiceSettings()
      const endpoint = hostStatus?.assets?.endpoint || routes.voiceAssets
      const manifestEndpoint = new URL(endpoint, globalThis.location?.href)
      manifestEndpoint.searchParams.set('key', 'manifest.json')
      const manifestResponse = await fetch(manifestEndpoint.href, { credentials: 'same-origin', cache: 'no-store' })
      if (disposed) throw Object.assign(new Error('语音控制器已关闭'), { code: 'VOICE_CONTROLLER_DISPOSED', outcome: 'not_applied' })
      if (!manifestResponse.ok) throw Object.assign(new Error('语音模型资源清单不可用'), { code: 'VOICE_ASSET_MANIFEST_UNAVAILABLE' })
      const manifest = await manifestResponse.json()
      assetURLs = resolveVoiceAssets(endpoint, manifest)
      const configResponse = await requestJson(routes.config)
      if (disposed) throw Object.assign(new Error('语音控制器已关闭'), { code: 'VOICE_CONTROLLER_DISPOSED', outcome: 'not_applied' })
      config = validateVoiceConfig({ ...(configResponse?.config?.voice || DEFAULT_VOICE_CONFIG), tts: voiceSettings?.tts || configResponse?.config?.voice?.tts || DEFAULT_VOICE_CONFIG.tts })
      // Old settings used half duplex. The single phone button always uses the
      // new capture path; start will reject a missing actual AEC track.
      if (config.duplexPreference === 'speaker-turn-taking') config = { ...config, duplexPreference: 'speaker-duplex' }
      configRevision = configResponse?.configRevision || null
      capture = createWebCapture({
        audioStore: audio,
        requireEchoCancellation: config.duplexPreference === 'speaker-duplex',
        modelUrl: assetURLs.modelUrl,
        ortModuleUrl: assetURLs.ortModuleUrl,
        wasmPaths: assetURLs.wasmPaths,
        workletUrl: assetURLs.workletUrl,
        vadWorkerUrl: assetURLs.workerUrl,
      })
      const conversation = createDshConversation({ chat, foreground: host.foreground, registerVoiceSource: host.registerVoiceSource, releaseVoiceSource: host.releaseVoiceSource })
      service = createVoiceService({
        capture,
        recognition: speech.recognition,
        conversation,
        synthesis: host.synthesis,
        playback,
        ownership: host.ownership,
        audio,
        clock,
        ids: { createId: makeId },
        config,
      })
      service.subscribe(next => { snapshot = next; publish() })
      publish()
      return { hostStatus, speechStatus, config }
    })().catch(error => {
      setupPromise = null
      localFailure = { code: error?.code || 'VOICE_SETUP_FAILED', stage: 'capabilities', message: error?.message || String(error), outcome: 'not_applied' }
      publish()
      throw error
    })
    return setupPromise
  }

  function start() {
    if (disposed) return Promise.reject(Object.assign(new Error('语音控制器已关闭'), { code: 'VOICE_CONTROLLER_DISPOSED', outcome: 'not_applied' }))
    if (startPromise) return startPromise
    // Playback unlock is intentionally the first side effect in this click stack.
    const generation = ++startGeneration
    const pendingReplyAudio = replyAudioPromise
    const unlock = playback.unlock()
    startupPending = true
    localFailure = null; publish()
    const attempt = (async () => {
      const unlockResult = await unlock
      if (pendingReplyAudio) await pendingReplyAudio
      if (resetInProgress || chat.isVoiceResetting?.()) throw Object.assign(new Error('大肥鱼会话正在切换，请稍后重试'), { code: 'VOICE_TARGET_RESETTING', outcome: 'not_applied' })
      if (generation !== startGeneration) throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
      const ready = await ensureSetup()
      if (generation !== startGeneration) throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
      await chat.ensure()
      if (generation !== startGeneration) throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
      const serviceGeneration = ready.hostStatus?.ownership?.serviceGeneration
      if (typeof serviceGeneration !== 'string' || !serviceGeneration) throw Object.assign(new Error('本机 DSH Host 未提供有效运行时身份'), { code: 'VOICE_RUNTIME_ID_UNAVAILABLE', outcome: 'not_applied' })
      if (ready.config?.tts?.providerId === 'windows-system-speech' && (ready.hostStatus?.host?.local !== true || ready.hostStatus.host.os !== 'win32' || ready.hostStatus.host.arch !== 'x64')) {
        throw Object.assign(new Error('系统语音只在本机 Windows x64 DSH Host 可用'), { code: 'VOICE_HOST_UNSUPPORTED', outcome: 'not_applied' })
      }
      const current = chat.getVoiceTarget(`dsh:${serviceGeneration}`)
      if (!current) throw Object.assign(new Error('当前大肥鱼会话不属于规范小鱼塘工作区，语音不会发送到其他工作区'), { code: 'VOICE_TARGET_NOT_CANONICAL', outcome: 'not_applied' })
      // The Host may reclaim an idle ASR worker after a previous call. Setup is
      // app-lifetime, while readiness is live state and must be checked per start.
      const currentSpeechStatus = await speech.inspect()
      if (generation !== startGeneration) throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
      speechStatus = currentSpeechStatus
      if (!speechStatus?.selection?.providerId || !speechStatus.selection.language) throw Object.assign(new Error(speechStatus?.reason || 'DSH 语音识别提供方不可用，请先在 DSH 中配置识别'), { code: speechStatus?.reason || 'DSH_SPEECH_UNAVAILABLE', outcome: 'not_applied' })
      if (!speechStatus?.available) {
        if (!speechStatus?.selection?.providerId) throw Object.assign(new Error(speechStatus?.reason || 'DSH 尚未选择可用的语音识别提供方'), { code: speechStatus?.reason || 'DSH_SPEECH_PROVIDER_UNAVAILABLE', outcome: 'not_applied' })
        prepController = new AbortController()
        await prepareModel({ signal: prepController.signal, generation })
        if (generation !== startGeneration) throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
      }
      if (!speechStatus?.available) throw Object.assign(new Error(speechStatus?.reason || '语音识别模型准备未完成'), { code: speechStatus?.reason || 'DSH_SPEECH_NOT_READY', outcome: 'not_applied' })
      if (service.getSnapshot().call?.status === 'connected' && service.getSnapshot().call.inputEnabled === false) await service.hangup({ abandonPending: true, preservePlayback: true })
      if (generation !== startGeneration) throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
      const started = await service.start(current, { unlockResult, selection: speechStatus.selection })
      if (generation !== startGeneration) { await service.hangup(); throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' }) }
      return started
    })().catch(async error => {
      if (generation !== startGeneration) {
        try { await playback.release() } catch {}
        throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
      }
      if (service?.getSnapshot?.().call?.status !== 'connected') { try { await playback.release() } catch {} }
      localFailure = { code: error?.code || 'VOICE_START_FAILED', stage: error?.stage || 'start', message: error?.message || String(error), outcome: error?.outcome || 'unknown' }
      publish(); throw error
    }).finally(() => {
      if (generation === startGeneration) {
        startupPending = false
        startPromise = null
        publish()
      }
    })
    startPromise = attempt
    return attempt
  }

  // Arm only new replies from the canonical conversation before a keyboard
  // submission. Output unlock stays in the user's Send action; no ASR or mic.
  function prepareReplyAudio() {
    if (disposed || resetInProgress || chat.isVoiceResetting?.() || config?.replyAudioEnabled === false) return Promise.resolve(false)
    if (startupPending) return Promise.resolve(false)
    const unlock = playback.unlock()
    if (replyAudioPromise) return replyAudioPromise
    if (service?.getSnapshot().call?.status === 'connected') return unlock.then(result => result.ready !== false).catch(() => false)
    const generation = ++startGeneration
    localFailure = null
    const check = () => {
      if (disposed || generation !== startGeneration || resetInProgress || chat.isVoiceResetting?.()) throw Object.assign(new Error('语音播报准备已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
    }
    const attempt = (async () => {
      const unlockResult = await unlock; check()
      const ready = await ensureSetup(); check()
      if (ready.config.replyAudioEnabled === false) return false
      await chat.ensure(); check()
      const serviceGeneration = ready.hostStatus?.ownership?.serviceGeneration
      if (typeof serviceGeneration !== 'string' || !serviceGeneration) throw Object.assign(new Error('本机 DSH Host 未提供有效运行时身份'), { code: 'VOICE_RUNTIME_ID_UNAVAILABLE' })
      const current = chat.getVoiceTarget(`dsh:${serviceGeneration}`)
      if (!current) throw Object.assign(new Error('当前聊天不属于规范小鱼塘，无法准备回复播报'), { code: 'VOICE_TARGET_NOT_CANONICAL' })
      await service.start(current, { unlockResult, inputEnabled: false }); check()
      localFailure = null; publish()
      return true
    })().catch(async error => {
      if (error?.code !== 'VOICE_START_CANCELLED') localFailure = { code: error?.code || 'VOICE_OUTPUT_SETUP_FAILED', stage: error?.stage || 'playback', message: error?.message || String(error), outcome: 'not_applied' }
      if (generation === startGeneration && service?.getSnapshot().call?.status !== 'connected') { try { await playback.release() } catch {} }
      publish()
      return false
    }).finally(() => { if (replyAudioPromise === attempt) replyAudioPromise = null })
    replyAudioPromise = attempt
    return attempt
  }

  async function prepareModel({ signal: suppliedSignal, generation } = {}) {
    const ownedController = suppliedSignal ? null : new AbortController()
    if (ownedController) prepController = ownedController
    const signal = suppliedSignal || ownedController.signal
    const check = () => {
      if (disposed) throw Object.assign(new Error('语音控制器已关闭'), { code: 'VOICE_CONTROLLER_DISPOSED', outcome: 'not_applied' })
      if (signal.aborted || (generation !== undefined && generation !== startGeneration)) throw Object.assign(new Error('语音启动已取消'), { code: 'VOICE_START_CANCELLED', outcome: 'not_applied' })
    }
    try {
      check()
      await ensureSetup()
      check()
      const status = await speech.inspect(); check(); speechStatus = status
      if (status.available) { publish(); return status }
      const providerId = status.selection?.providerId
      if (!providerId) throw Object.assign(new Error(status.reason || 'DSH 尚未选择可用的语音识别提供方'), { code: status.reason || 'DSH_SPEECH_PROVIDER_UNAVAILABLE' })
      await speech.prepare(providerId)
      check()
      for await (const catalog of speech.follow(signal)) {
        check()
        const provider = catalog?.providers?.find(item => item.id === providerId)
        if (provider?.preparation?.phase === 'ready') {
          speechStatus = { available: true, selection: catalog.selection, catalog }
          publish(); return speechStatus
        }
        if (provider?.preparation?.phase === 'failed') throw Object.assign(new Error(provider.preparation.error?.message || '语音识别模型准备失败'), { code: provider.preparation.error?.code || 'DSH_SPEECH_PREPARE_FAILED' })
      }
      throw Object.assign(new Error('语音识别模型准备状态订阅已结束'), { code: 'DSH_SPEECH_FOLLOW_ENDED' })
    } finally { if (prepController?.signal === signal) prepController = null }
  }

  async function cancelPreparation() {
    const providerId = speechStatus?.selection?.providerId
    prepController?.abort()
    prepController = null
    if (!providerId || !speech.available) return { cancelled: false }
    return speech.cancelPreparation(providerId)
  }

  async function readVoiceConfig() {
    const result = await requestJson(routes.config)
    configRevision = result.configRevision || null
    return { config: validateVoiceConfig(result?.config?.voice || DEFAULT_VOICE_CONFIG), revision: configRevision }
  }

  async function updateVoiceConfig(patch, expectedRevision = configRevision) {
    if (service && ['connected', 'connecting', 'starting', 'reconnecting'].includes(service.getSnapshot()?.call?.status)) {
      throw Object.assign(new Error('请先结束语音通话，再更改语音设置'), { code: 'VOICE_CONFIG_CALL_ACTIVE', outcome: 'not_applied' })
    }
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedRevision)) {
      throw Object.assign(new Error('语音设置版本无效，请重新读取设置'), { code: 'CONFIG_REVISION_INVALID', outcome: 'not_applied' })
    }
    const response = await fetch(routes.config, {
      method: 'PUT', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-config-revision': expectedRevision },
      body: JSON.stringify({ voice: patch }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) {
      const code = payload?.error?.code || `VOICE_CONFIG_${response.status}`
      throw Object.assign(new Error(code === 'STALE_TARGET' ? '语音设置已被其他窗口修改，请重新读取' : code), { code, outcome: payload?.error?.outcome || 'not_applied' })
    }
    config = validateVoiceConfig(payload.config?.voice || DEFAULT_VOICE_CONFIG)
    configRevision = payload.configRevision || null
    if (service) { await service.dispose(); service = null; capture = null; setupPromise = null }
    publish()
    return { config, revision: configRevision }
  }

  function operation(kind) {
    const controller = new AbortController()
    return { operationId: makeId(kind), signal: controller.signal, cancel() { controller.abort() } }
  }
  async function readVoiceSettings() {
    try { hostStatus = await host.capabilities() } catch {}
    voiceSettings = await host.readVoiceSettings()
    return voiceSettings
  }
  async function updateVoiceSettings(tts) {
    if (service && ['connected', 'connecting', 'starting', 'reconnecting'].includes(service.getSnapshot()?.call?.status)) {
      throw Object.assign(new Error('请先结束语音通话，再更改语音设置'), { code: 'VOICE_CONFIG_CALL_ACTIVE', outcome: 'not_applied' })
    }
    stopVoicePreview()
    voiceSettings = await host.updateVoiceSettings(tts)
    config = validateVoiceConfig({ ...(config || DEFAULT_VOICE_CONFIG), tts: voiceSettings?.tts || tts })
    if (service) { await service.dispose(); service = null; capture = null; setupPromise = null }
    publish()
    return voiceSettings
  }
  function getVoicePreviewCatalog(binding) { return host.getVoicePreviewCatalog(binding) }
  async function playVoicePreview({ binding, voiceId, text, rate = voiceSettings?.tts?.rate ?? 0, emotionTag } = {}) {
    const savedTts = voiceSettings?.tts
    const draftBinding = binding !== undefined
    const previewVoiceId = draftBinding ? voiceId : (voiceId ?? savedTts?.voiceId)
    if (draftBinding) {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding) || typeof binding.providerId !== 'string' || !binding.providerId || typeof previewVoiceId !== 'string' || !previewVoiceId) throw Object.assign(new Error('试听配置需要提供厂商绑定和音色'), { code: 'VOICE_PREVIEW_SETTINGS_UNAVAILABLE', outcome: 'not_applied' })
    } else if (savedTts?.providerId !== 'aliyun-qwen-tts' || !savedTts?.voiceId || savedTts?.credentialRef !== 'DASHSCOPE_API_KEY') {
      throw Object.assign(new Error('请先保存可用的云端语音设置，再开始试听'), { code: 'VOICE_PREVIEW_SETTINGS_UNAVAILABLE', outcome: 'not_applied' })
    }
    if (!Number.isInteger(rate) || rate < -10 || rate > 10) throw Object.assign(new TypeError('试听语速需为 -10 到 10 的整数'), { code: 'VOICE_PREVIEW_RATE_INVALID', outcome: 'not_applied' })
    if (service?.getSnapshot?.().call?.status === 'connected') throw Object.assign(new Error('请先结束语音通话，再试听音色'), { code: 'VOICE_PLAYBACK_BUSY' })
    if (playback.inspect().playing && !previewOperation) throw Object.assign(new Error('另一段语音正在播放'), { code: 'VOICE_PLAYBACK_BUSY' })
    stopVoicePreview()
    const op = operation('voice-preview')
    previewOperation = op
    const unlock = playback.unlock()
    let output = null, format = null, audioSeen = false, completeSeen = false, receipt = null
    try {
      const unlockResult = await unlock
      if (!unlockResult.ready) throw Object.assign(new Error('当前浏览器无法播放语音'), { code: unlockResult.code || 'VOICE_PLAYBACK_UNSUPPORTED' })
      for await (const item of host.synthesizeVoicePreview({ operationId: op.operationId, binding, text, voiceId: previewVoiceId, rate, emotionTag }, { operation: op })) {
        if (op.signal.aborted) throw Object.assign(new Error('试听已取消'), { code: 'TTS_CANCELLED' })
        if (item.type === 'audio') {
          if (!output) { format = item.format; output = playback.openStream({ format, operation: op }) }
          else if (JSON.stringify(format) !== JSON.stringify(item.format)) throw Object.assign(new Error('音频格式发生变化'), { code: 'VOICE_AUDIO_FORMAT_CHANGED' })
          await output.append(item.data); audioSeen = true
        } else if (item.type === 'complete') { completeSeen = true; receipt = item.receipt }
      }
      if (!audioSeen || !completeSeen || !output) throw Object.assign(new Error('试听未返回完整音频'), { code: 'VOICE_TTS_INCOMPLETE' })
      output.endInput()
      const result = await output.finished
      return { played: result?.ended === true, receipt }
    } catch (error) {
      if (output && !op.signal.aborted) playback.stop()
      throw error
    } finally { if (previewOperation === op) previewOperation = null }
  }
  function stopVoicePreview() {
    if (!previewOperation) return false
    previewOperation.cancel('preview-stopped')
    previewOperation = null
    return true
  }
  async function listStoredAudio(sessionId, seqs, options) { return host.listStoredAudio(sessionId, seqs, options) }
  async function playStoredReply(summary) {
    const source = summary?.source
    if (typeof summary?.audioId !== 'string' || typeof source?.sessionId !== 'string' || !Number.isSafeInteger(source.seq)) throw Object.assign(new TypeError('Reply audio summary is invalid'), { code: 'VOICE_AUDIO_INVALID' })
    stopVoicePreview()
    stopStoredReply()
    const op = operation('stored-audio')
    storedAudioOperation = op
    const unlock = playback.unlock()
    let output = null
    try {
      const unlockResult = await unlock
      if (!unlockResult.ready) throw Object.assign(new Error('当前浏览器无法播放语音'), { code: unlockResult.code || 'VOICE_PLAYBACK_UNSUPPORTED' })
      const stored = await host.getStoredAudio(summary.audioId, source.sessionId, { signal: op.signal })
      if (op.signal.aborted) throw Object.assign(new Error('语音回放已取消'), { code: 'VOICE_PLAYBACK_STOPPED' })
      const format = { codec: 'wav', sampleRate: summary.format?.sampleRate, channels: summary.format?.channels }
      if (service?.getSnapshot?.().call?.status === 'connected') {
        if (typeof service.playStoredAudio !== 'function') throw Object.assign(new Error('当前语音服务暂不支持文件回放'), { code: 'VOICE_PLAYBACK_UNAVAILABLE' })
        return await service.playStoredAudio({ format, data: stored.data, operation: op })
      }
      output = playback.openStream({ format, operation: op })
      await output.append(stored.data)
      output.endInput()
      const result = await output.finished
      return result?.ended === true
    } finally { if (storedAudioOperation === op) storedAudioOperation = null }
  }
  function stopStoredReply() {
    if (!storedAudioOperation) return false
    storedAudioOperation.cancel('stored-playback-stopped')
    storedAudioOperation = null
    return true
  }
  function stopReplyPlayback() {
    stopVoicePreview()
    stopStoredReply()
    playback.stop()
  }

  return {
    foreground: host.foreground,
    async foregroundTarget() {
      if (disposed || resetInProgress || chat.isVoiceResetting?.()) return null
      try {
        const caps = hostStatus || await host.capabilities()
        const generation = caps?.ownership?.serviceGeneration
        return typeof generation === 'string' ? chat.getVoiceTarget(`dsh:${generation}`) : null
      } catch { return null }
    },
    subscribe(fn) { listeners.add(fn); fn(snapshot || { call: { status: 'idle' }, capture: { status: 'stopped' }, inputs: [], playback: { enabled: true }, queue: { unresolved: 0, waiting: 0 }, error: localFailure, startupPending }); return () => listeners.delete(fn) },
    getSnapshot() { const current = service?.getSnapshot(); return current ? { ...current, error: current.error || localFailure, startupPending } : snapshot },
    starting() { return startupPending },
    start,
    prepareReplyAudio,
    async cancelStart() {
      const generation = ++startGeneration
      const pendingStart = startPromise
      const status = service?.getSnapshot?.().call?.status
      const stopCall = status && !['idle', 'ended', 'failed'].includes(status) ? service.hangup() : Promise.resolve()
      const stopPreparation = prepController ? cancelPreparation().catch(() => {}) : Promise.resolve()
      await Promise.all([stopCall, stopPreparation])
      if (pendingStart) await pendingStart.catch(() => {})
      try { await playback.release() } catch {}
      if (generation === startGeneration) {
        startupPending = false
        startPromise = null
        publish()
      }
    },
    prepareModel,
    cancelPreparation,
    readVoiceConfig,
    updateVoiceConfig,
    readVoiceSettings,
    updateVoiceSettings,
    getVoicePreviewCatalog,
    playVoicePreview,
    stopVoicePreview,
    listStoredAudio,
    playStoredReply,
    stopStoredReply,
    stopReplyPlayback,
    getVoiceVoices() { return hostStatus?.synthesis?.voices || [] },
    modelReady() { return speechStatus?.available === true },
    capabilityText() {
      if (localFailure) return localFailure.message || localFailure.code
      if (!speech.available) return '当前 DSH 未提供语音识别 Remote'
      if (!hostStatus) return '正在检查本机语音能力…'
      if (!hostStatus.synthesis?.supported) return hostStatus.synthesis?.reason || '本机语音合成不可用'
      if (!speechStatus?.available) return speechStatus?.reason === 'DSH_SPEECH_NOT_READY' ? '识别模型需要显式准备' : speechStatus?.reason || '等待识别模型'
      return '语音能力就绪'
    },
    mute: () => service?.mute(), unmute: () => service?.unmute(),
    setOutputEnabled: enabled => service?.setOutputEnabled(enabled),
    hangup: () => service?.hangup({ abandonPending: true }),
    canContinueCall() {
      const ref = service?.getSnapshot?.().call?.conversationRef
      const serviceGeneration = hostStatus?.ownership?.serviceGeneration
      if (!ref || typeof serviceGeneration !== 'string' || resetInProgress || chat.isVoiceResetting?.()) return false
      const current = chat.getVoiceTarget(`dsh:${serviceGeneration}`)
      return Boolean(current && current.runtimeId === ref.runtimeId && current.conversationId === ref.conversationId && current.bindingRevision === ref.bindingRevision)
    },
    continueCall() {
      const unlock = playback.unlock()
      return unlock.then(unlockResult => {
        if (!this.canContinueCall()) throw Object.assign(new Error('语音通话目标已切换，请开始新通话'), { code: 'VOICE_TARGET_STALE', outcome: 'not_applied' })
        return service?.continueCall({ unlockResult, selection: speechStatus?.selection })
      })
    },
    retryInput: id => service?.retryInput(id), editInput: (id, text) => service?.editInput(id, text),
    retryUnknown: id => service?.retryUnknown(id), submitHeld: id => service?.submitHeld(id), discardInput: id => service?.discardInput(id),
    async dispose() {
      if (disposed) return
      disposed = true
      ++startGeneration
      startupPending = false
      startPromise = null
      try { await cancelPreparation() } catch {}
      try { await service?.dispose() } finally {
        try { await playback.release() } catch {}
        try { removeVoiceReset?.() } catch {}
        try { await remoteInjection?.dispose?.() } catch {}
        speechContext = null
        speech.setRemote(null)
        host.close(); audio.clear(); listeners.clear()
      }
    },
  }
}

export function createVoiceOverlay(ctx, chat, routes) {
  return function ChonkyFishVoiceOverlay() {
    React.useEffect(() => {
      let controller
      try {
        controller = createDshVoiceController({ ctx, chat, routes })
        chat.setVoiceController?.(controller)
        return () => {
          chat.clearVoiceController?.(controller)
          void controller.dispose()
        }
      } catch (error) {
        console.error('[chonkyfish] voice overlay failed to mount', error)
        return undefined
      }
    }, [])
    return null
  }
}
