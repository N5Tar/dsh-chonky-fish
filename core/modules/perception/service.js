import { resolveConfig } from './config.js'
import { RULE_VERSION, analyzeActivity, buildIntervals, computeFreshness, shouldPersistSummary } from './core.js'

const fault = (code, message) => Object.assign(new Error(message), { code })
const publicError = (error, code = 'PERCEPTION_ERROR') => ({ code: error?.code || code, message: error?.message || '感知模块不可用' })

/** Host-independent module lifecycle. Construction never starts collection. */
export function createPerceptionService({ store, binaryPath, capabilities = { supported: true }, config: overrides,
  collectorFactory, now = Date.now, isEnabled = () => true, preferences,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const config = resolveConfig(overrides)
  if (typeof collectorFactory !== 'function') throw new TypeError('createPerceptionService requires a collectorFactory port')
  let state = capabilities.supported ? 'stopped' : 'unsupported'
  let latestSample = null, summary = null, savedSummary = null, error = null, cleanup = null
  let closed = false, closing = null, cleaning = null, initializing = null, stopping = null, haltReason = null, controlGeneration = 0
  let analysisTimer, cleanupTimer, restoring
  let preferenceTail = Promise.resolve(), preferenceRead = null, preferenceLoaded = false, preferenceRequested = false, preferenceError = null, manualControl = false, preferenceGeneration = 0
  function preferenceOperation(fn) { const next = preferenceTail.then(fn); preferenceTail = next.catch(() => {}); return next }
  function loadPreference() {
    if (!preferenceRead) preferenceRead = preferenceOperation(async () => {
      try {
        const value = preferences ? await preferences.read() : false
        if (typeof value !== 'boolean') throw fault('PREFERENCE_INVALID', '采集偏好无效，未自动开始采集')
        preferenceRequested = value; preferenceLoaded = true; preferenceError = null
      } catch (cause) {
        preferenceLoaded = true; preferenceRequested = false; preferenceError = publicError(cause, 'PREFERENCE_READ_FAILED')
        error = preferenceError
        if (!closed) { haltReason = 'preference'; state = 'error' }
      }
    })
    return preferenceRead
  }
  function savePreference(value, generation) {
    return preferenceOperation(async () => {
      // Public controls check admission before enqueueing. Once accepted, their
      // intent must drain even if plugin shutdown begins before this write runs.
      // Only a newer explicit user control may supersede intent persistence.
      // Internal collector/storage halts must not cancel a queued user-off write.
      if (generation !== preferenceGeneration) throw fault('CANCELLED', '采集控制请求已被新的操作取代')
      try {
        if (preferences) await preferences.write(value)
        preferenceRequested = value; preferenceLoaded = true
        if (preferenceError && error?.code === preferenceError.code) error = null
        preferenceError = null
      } catch (cause) {
        preferenceError = publicError(cause, 'PREFERENCE_WRITE_FAILED')
        await stopWithError(cause, 'PREFERENCE_WRITE_FAILED')
        throw cause
      }
    })
  }
  const collector = collectorFactory({ binaryPath, supported: capabilities.supported, now,
    firstSampleTimeoutMs: config.sampleStaleMs, staleTimeoutMs: config.sampleStaleMs,
    onState(next) {
      if (closed || haltReason) return
      state = next.state
    },
    onError(cause) { error ||= publicError(cause, 'COLLECTOR_ERROR'); state = 'error' },
    onSample(sample) {
      if (closed || haltReason || !isEnabled()) throw fault('UNAVAILABLE', '采集已停止或模块已禁用')
      try {
        if (store.insertSample(sample)) latestSample = sample
      } catch (cause) {
        error = publicError(cause, 'STORAGE_ERROR'); state = 'error'; throw cause
      }
    },
  })
  const assertOpen = () => { if (closed) throw fault('UNAVAILABLE', '感知模块已关闭') }
  function expireMemory(time) {
    if (summary && time - summary.analyzedAt >= config.summaryTtlMs) summary = null
    if (latestSample && time - latestSample.receivedAtMs >= config.rawTtlMs) latestSample = null
  }
  const stopWithError = async (cause, code) => {
    const generation = ++controlGeneration
    error = publicError(cause, code); haltReason = 'error'; state = 'error'
    const pending = stopping || collector.stop()
    stopping = pending
    try { await pending }
    finally { if (stopping === pending) stopping = null }
    if (!closed && generation === controlGeneration) state = 'error'
  }
  function analyze() {
    if (closed || haltReason || !latestSample) return
    if (!isEnabled()) { void halt('paused'); return } // Internal disable preserves the user's saved intent.
    if (state !== 'running' || now() - latestSample.receivedAtMs > config.sampleStaleMs) return
    if (summary?.sourceRunId === latestSample.runId && summary?.sourceSeq === latestSample.seq) return
    try {
      const time = now()
      // Preserve history, but never let an old/possibly faulty collector run
      // populate a fresh run's decision window after pause, restart or repair.
      const samples = store.querySamples({ fromMs: time - 900000 - 10000, toMs: time, nowMs: time, limit: 2000 })
        .filter(sample => sample.runId === latestSample.runId)
      const next = analyzeActivity(samples, { nowMs: time, previous: summary, config })
      if (shouldPersistSummary(next, savedSummary)) {
        try { store.insertSummary(next); savedSummary = next }
        catch (cause) { void stopWithError(cause, 'STORAGE_ERROR'); return }
      }
      summary = next
      error = null
    } catch (cause) {
      error = publicError(cause, 'ANALYSIS_ERROR')
      // Analysis failure never disables retention cleanup.
    }
  }
  async function clean() {
    if (closed) return null
    if (cleaning) return cleaning
    cleaning = (async () => {
      const time = now()
      try {
        const result = await store.cleanup({ nowMs: time })
        cleanup = { at: time, ...result, error: null }
        if (summary && time - summary.analyzedAt >= config.summaryTtlMs) summary = null
        if (latestSample && time - latestSample.receivedAtMs >= config.rawTtlMs) latestSample = null
        return cleanup
      } catch (cause) {
        cleanup = { at: time, samples: 0, summaries: 0, error: publicError(cause, 'CLEANUP_ERROR') }
        await stopWithError(cause, 'CLEANUP_ERROR')
        return cleanup
      } finally { cleaning = null }
    })()
    return cleaning
  }
  async function startCollector(generation) {
    assertOpen()
    if (generation !== controlGeneration) throw fault('CANCELLED', '开始采集已取消')
    if (!isEnabled()) throw fault('UNAVAILABLE', '感知模块已禁用')
    if (!capabilities.supported) throw fault('UNSUPPORTED', capabilities.reason || '此平台不支持采集')
    if (stopping) throw fault('CANCELLED', '采集器正在停止，请稍后重试')
    if (state === 'running' || state === 'starting' || state === 'stale') return collector.start()
    await clean()
    assertOpen()
    if (!isEnabled()) throw fault('UNAVAILABLE', '感知模块已禁用')
    if (generation !== controlGeneration) throw fault('CANCELLED', '开始采集已取消')
    if (cleanup?.error) throw fault('STORAGE_ERROR', '过期数据清理失败，请修复后重试')
    haltReason = null; error = null; latestSample = null; summary = null; savedSummary = null
    try { return await collector.start() }
    catch (cause) { if (!closed && !haltReason) { state = 'error'; error = publicError(cause, 'COLLECTOR_ERROR') }; throw cause }
  }
  async function start() {
    assertOpen()
    if (!isEnabled()) throw fault('UNAVAILABLE', '感知模块已禁用')
    if (!capabilities.supported) throw fault('UNSUPPORTED', capabilities.reason || '此平台不支持采集')
    if (stopping) throw fault('CANCELLED', '采集器正在停止，请稍后重试')
    manualControl = true
    const generation = ++controlGeneration, intent = ++preferenceGeneration
    await savePreference(true, intent)
    return startCollector(generation)
  }
  async function halt(next) {
    assertOpen(); const generation = ++controlGeneration
    haltReason = next; state = next
    const pending = stopping || collector.stop()
    stopping = pending
    try { await pending }
    finally { if (stopping === pending) stopping = null }
    if (!closed && generation === controlGeneration) state = next
    return { state }
  }
  async function userHalt(next) {
    assertOpen(); manualControl = true
    // Stop admission immediately, even if a previous start/preference read is pending.
    const intent = ++preferenceGeneration, halted = halt(next)
    const saved = savePreference(false, intent)
    const results = await Promise.allSettled([halted, saved])
    for (const result of results) if (result.status === 'rejected' && result.reason?.code !== 'CANCELLED') throw result.reason
    if (!closed && intent === preferenceGeneration && !preferenceError) { haltReason = next; state = next }
    return { state }
  }
  const pause = () => userHalt('paused')
  const stop = () => userHalt(capabilities.supported ? 'stopped' : 'unsupported')
  // Compare and reserve a user control in one synchronous turn. Existing controls
  // reserve preferenceGeneration before their first await, preventing stale Hello
  // requests from overwriting a newer settings-page choice.
  function getControlState() { return { revision: preferenceGeneration, requested: preferenceRequested } }
  function setRequested(requested, { expectedRevision, expectedRequested } = {}) {
    if (typeof requested !== 'boolean' || expectedRevision !== preferenceGeneration || expectedRequested !== preferenceRequested)
      throw Object.assign(fault('STALE_TARGET', '采集选择已变更，请重新确认'), { outcome: 'not_applied' })
    return requested ? start() : stop()
  }
  function getCurrent() {
    const time = now()
    expireMemory(time)
    const freshness = computeFreshness({ nowMs: time, status: isEnabled() ? state : 'stopped', runId: collector.getStatus().runId,
      sample: latestSample, summary, config })
    return { data: summary, freshness }
  }
  function getStatus() {
    const time = now()
    expireMemory(time)
    let visibleState = state
    if (state === 'running' && (!latestSample || time - latestSample.receivedAtMs > config.sampleStaleMs)) visibleState = 'stale'
    return { state: closed ? 'disposed' : visibleState, enabled: isEnabled(), latestSample,
      analysisVersion: RULE_VERSION, observationScope: 'focused-application',
      lastAnalysisAt: summary?.analyzedAt ?? null, error, capabilities,
      collectionPreference: { requested: preferenceRequested, loaded: preferenceLoaded, error: preferenceError },
      retention: { rawTtlMs: config.rawTtlMs, summaryTtlMs: config.summaryTtlMs },
      storage: store.getCounts({ nowMs: time }), cleanup }
  }
  function getTimeline({ fromMs = now() - config.rawTtlMs, toMs = now() } = {}) {
    assertOpen()
    const time = now(), actualFrom = Math.max(fromMs, time - config.rawTtlMs)
    const samples = store.querySamples({ fromMs: actualFrom - 10000, toMs, nowMs: time, limit: 2000 })
    const counts = store.getCounts({ nowMs: time })
    const activeRun = collector.getStatus().runId
    const containsPriorRuns = samples.some(sample => sample.runId !== activeRun)
    if (actualFrom >= toMs) return { items: [], fromMs, toMs, availableFrom: counts.samplesFromMs, retentionLimited: true, containsPriorRuns: false }
    const items = buildIntervals(samples, { nowMs: time, fromMs: actualFrom, toMs, config }).map(item => ({
      ...item, startMs: item.fromMs, endMs: item.toMs, app: item.foregroundApp ?? null,
    }))
    return { items, fromMs: actualFrom, toMs, availableFrom: counts.samplesFromMs, retentionLimited: actualFrom > fromMs, containsPriorRuns }
  }
  function getSummaries(options = {}) { assertOpen(); return store.querySummaries({ ...options, nowMs: now() }) }
  function initialize() {
    if (initializing) return initializing
    initializing = (async () => {
      await clean()
      if (closed) return
      await loadPreference()
      if (closed) return
      analysisTimer = setIntervalImpl(analyze, config.analysisIntervalMs)
      cleanupTimer = setIntervalImpl(() => { void clean() }, config.cleanupIntervalMs)
      analysisTimer?.unref?.(); cleanupTimer?.unref?.()
      if (!manualControl && !preferenceError && !cleanup?.error && preferenceRequested && capabilities.supported && isEnabled()) {
        const generation = controlGeneration
        // Do not block the HTTP controls waiting for the collector's first sample.
        restoring = startCollector(generation).catch(cause => {
          if (!closed && generation === controlGeneration && cause?.code !== 'CANCELLED') {
            error = publicError(cause, 'COLLECTOR_ERROR'); state = 'error'
          }
        })
      }
    })()
    return initializing
  }
  function close() {
    if (closing) return closing
    closed = true; state = 'disposed'; ++controlGeneration
    clearIntervalImpl(analysisTimer); clearIntervalImpl(cleanupTimer)
    closing = (async () => {
      await collector.dispose()
      if (restoring) await restoring
      if (cleaning) await cleaning
      await preferenceTail
      store.close()
    })()
    return closing
  }
  return { initialize, start, pause, stop, getControlState, setRequested, getStatus, getCurrent, getTimeline, getSummaries, analyze, clean, close }
}
