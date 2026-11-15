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
  const host = createDshHostVoice({ routes, audioStore: audio })
  let speechContext = null
  const speech = createDshSpeech({ getRemote: () => speechContext, audioStore: audio })
  const listeners = new Set()
  let service = null, capture = null, speechStatus = null, hostStatus = null, assetURLs = null, config = null;
  let setupPromise = null, disposed = false, prepController = null, snapshot = null, localFailure = null, remoteInjection = null, startGeneration = 0, removeVoiceReset = null, resetInProgress = false
  let startupPending = false, startPromise = null
  let replyAudioPromise = null
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
      if (hostStatus?.host?.local !== true || hostStatus.host.os !== 'win32' || hostStatus.host.arch !== 'x64') {
        throw Object.assign(new Error('语音通话需要与本机 Client 同一 Windows x64 DSH Host'), { code: 'VOICE_HOST_UNSUPPORTED' })
      }
      if (!hostStatus?.ownership || !hostStatus?.synthesis?.supported) {
        throw Object.assign(new Error(hostStatus?.synthesis?.reason || '本机 Windows 语音合成能力不可用'), { code: hostStatus?.synthesis?.reason || 'VOICE_TTS_UNSUPPORTED' })
      }
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
      config = validateVoiceConfig(configResponse?.config?.voice || DEFAULT_VOICE_CONFIG)
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
      const conversation = createDshConversation({ chat, foreground: host.foreground })
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
    replayReply: id => service?.replayReply(id),
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
