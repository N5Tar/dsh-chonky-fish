const notificationState = new WeakMap()
const microphoneIcon = '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>'
const endCallIcon = '<path d="M3 9.5c4.7 5.8 9.1 8.2 16.2 9.1l1.4-4-5.2-2.1-2.4 2.1a13.3 13.3 0 0 1-4.1-3.4L11 8.8 9 3.5 5 5A12.6 12.6 0 0 1 3 9.5Z"/><path d="m16 4 5 5m0-5-5 5"/>'

const voiceErrorText = error => {
  const code = error?.code
  const mapped = {
    MISSING_CREDENTIAL: 'DSH 模型缺少凭据。请在大肥鱼会话中配置模型凭据后，再重新说一句。',
    DSH_SPEECH_REMOTE_UNAVAILABLE: '当前 DSH 未提供语音识别服务。',
    DSH_SPEECH_NOT_READY: '语音识别模型尚未准备好，请稍后重试。',
    VOICE_RECOGNITION_UNAVAILABLE: '语音识别服务暂未就绪，请重新开启通话以准备模型。',
    VOICE_CAPTURE_UNSUPPORTED: '当前 DSH 无法使用麦克风采集，请更新或重新启动 DSH。',
    VOICE_PLAYBACK_UNSUPPORTED: '当前 DSH 无法播放语音，请更新或重新启动 DSH。',
    VOICE_TTS_UNSUPPORTED: 'Windows 语音合成不可用，请检查系统语音组件后重新开启通话。',
    VOICE_TARGET_NOT_CANONICAL: '当前聊天不属于规范小鱼塘，无法开始语音通话。',
    VOICE_INPUT_LIMIT: '本次通话待处理语音已达上限。请结束通话后重新开始，再继续说话。',
    VOICE_AUDIO_BUDGET: '本次通话音频缓存已达上限。请结束通话后重新开始。',
    VOICE_CAPTURE_STALLED: '麦克风已停止提供音频。请检查输入设备，再结束并重新开始通话。',
    VOICE_VAD_BACKLOG: '语音处理落后过多。请结束通话后重新开始。',
    VOICE_MIC_PERMISSION: '麦克风未获授权。请在系统设置中授权后重新开始通话。',
    MIC_PERMISSION: '麦克风未获授权。请在系统设置中授权后重新开始通话。',
    VOICE_MIC_DISCONNECTED: '麦克风已断开。请重新连接设备，再结束并重新开始通话。',
    MIC_DISCONNECTED: '麦克风已断开。请重新连接设备，再结束并重新开始通话。',
  }
  return mapped[code] || error?.message || code || '语音通话失败，请重试。'
}

/** Bind the app-lifetime controller to the single button in a mounted chat page. */
export function createVoiceComposerControl({ button, chat, toast } = {}) {
  if (!button || !chat || typeof chat.onVoiceController !== 'function') throw new TypeError('Voice composer requires its button and chat bridge')
  let controller = null, snapshot = null, action = '', controllerUnsubscribe = null, disposed = false

  function reportOnce(key, error) {
    if (!controller || typeof toast !== 'function') return
    let state = notificationState.get(controller)
    if (!state) { state = new Set(); notificationState.set(controller, state) }
    if (state.has(key)) return
    state.add(key)
    while (state.size > 128) state.delete(state.values().next().value)
    try { toast(voiceErrorText(error)) } catch {}
  }

  function reportSnapshotErrors(next) {
    if (!controller || typeof toast !== 'function') return
    const errors = []
    if (next?.error) errors.push({ key: `call:${next.call?.id || 'setup'}:${next.error.code || next.error.stage || next.error.message}`, error: next.error })
    for (const input of next?.inputs || []) if (input.error) errors.push({ key: `input:${input.inputId}:${input.error.code || input.error.stage || input.error.message}`, error: input.error })
    for (const item of errors) reportOnce(item.key, item.error)
  }

  function render(next) {
    if (next) snapshot = next
    if (!snapshot && controller?.getSnapshot) snapshot = controller.getSnapshot()
    reportSnapshotErrors(snapshot)
    const callStatus = snapshot?.call?.inputEnabled === false ? 'idle' : snapshot?.call?.status || 'idle'
    const startupPending = Boolean(snapshot?.startupPending || controller?.starting?.())
    const active = startupPending || ['connected', 'preparing', 'ending'].includes(callStatus) || action === 'starting' || action === 'canceling' || action === 'ending'
    const cancelable = callStatus !== 'connected' && (startupPending || callStatus === 'preparing' || action === 'starting')
    const label = action === 'canceling' ? '正在取消语音启动' : action === 'ending' || callStatus === 'ending' ? '正在结束语音通话' : cancelable ? '取消语音启动' : callStatus === 'connected' ? '结束语音通话' : '开始语音通话'
    const currentError = snapshot?.error || snapshot?.inputs?.at(-1)?.error
    button.setAttribute('aria-label', label)
    button.setAttribute('title', currentError ? `${label} · ${voiceErrorText(currentError)}` : label)
    button.setAttribute('aria-pressed', String(active))
    button.disabled = !controller || action === 'canceling' || action === 'ending' || callStatus === 'ending'
    button.innerHTML = `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${active ? endCallIcon : microphoneIcon}</svg>`
  }

  function attach(next) {
    controllerUnsubscribe?.()
    controllerUnsubscribe = null
    controller = next || null
    snapshot = controller?.getSnapshot?.() || null
    if (controller?.subscribe) controllerUnsubscribe = controller.subscribe(render)
    render()
  }

  async function onClick() {
    if (!controller || action === 'canceling' || action === 'ending') return
    const callStatus = snapshot?.call?.inputEnabled === false ? 'idle' : snapshot?.call?.status || 'idle'
    const startupPending = Boolean(snapshot?.startupPending || controller.starting?.())
    const nextAction = callStatus === 'connected' ? 'ending' : startupPending || callStatus === 'preparing' || action === 'starting' ? 'canceling' : 'starting'
    action = nextAction
    render()
    try {
      if (nextAction === 'ending') await controller.hangup()
      else if (nextAction === 'canceling') await (controller.cancelStart ? controller.cancelStart() : controller.hangup())
      else await controller.start()
    } catch (error) {
      if (!disposed && error?.code !== 'VOICE_START_CANCELLED' && error?.code !== 'VOICE_CANCELLED') {
        const key = `call:${snapshot?.call?.id || 'setup'}:${error?.code || error?.stage || error?.message || 'failure'}`
        reportOnce(key, error)
      }
    } finally {
      if (!disposed && action === nextAction) action = ''
      render()
    }
  }

  button.addEventListener('click', onClick)
  const bridgeUnsubscribe = chat.onVoiceController(attach)
  return {
    dispose() {
      disposed = true
      try { bridgeUnsubscribe?.() } catch {}
      try { controllerUnsubscribe?.() } catch {}
      button.removeEventListener?.('click', onClick)
      controllerUnsubscribe = null
      controller = null
    },
  }
}
