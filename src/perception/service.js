import { createCollector } from './collector.js'
import { resolveConfig } from './config.js'
import { RULE_VERSION, analyzeActivity, buildIntervals, computeFreshness, shouldPersistSummary } from './core.js'

const fault = (code, message) => Object.assign(new Error(message), { code })
const publicError = (error, code = 'PERCEPTION_ERROR') => ({ code: error?.code || code, message: error?.message || '感知模块不可用' })

/** Host-independent module lifecycle. Construction never starts collection. */
export function createPerceptionService({ store, binaryPath, capabilities = { supported: true }, config: overrides,
  collectorFactory = createCollector, now = Date.now, isEnabled = () => true,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const config = resolveConfig(overrides)
  let state = capabilities.supported ? 'stopped' : 'unsupported'
  let latestSample = null, summary = null, savedSummary = null, error = null, cleanup = null
  let closed = false, closing = null, cleaning = null, initializing = null, stopping = null, haltReason = null, controlGeneration = 0
  let analysisTimer, cleanupTimer
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
    if (!isEnabled()) { void pause(); return }
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
  async function start() {
    assertOpen()
    if (!isEnabled()) throw fault('UNAVAILABLE', '感知模块已禁用')
    if (!capabilities.supported) throw fault('UNSUPPORTED', capabilities.reason || '此平台不支持采集')
    if (stopping) throw fault('CANCELLED', '采集器正在停止，请稍后重试')
    if (state === 'running' || state === 'starting' || state === 'stale') return collector.start()
    const generation = ++controlGeneration
    await clean()
    assertOpen()
    if (!isEnabled()) throw fault('UNAVAILABLE', '感知模块已禁用')
    if (generation !== controlGeneration) throw fault('CANCELLED', '开始采集已取消')
    if (cleanup?.error) throw fault('STORAGE_ERROR', '过期数据清理失败，请修复后重试')
    haltReason = null; error = null; latestSample = null; summary = null; savedSummary = null
    try { return await collector.start() }
    catch (cause) { if (!closed && !haltReason) { state = 'error'; error = publicError(cause, 'COLLECTOR_ERROR') }; throw cause }
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
  const pause = () => halt('paused')
  const stop = () => halt(capabilities.supported ? 'stopped' : 'unsupported')
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
      analysisTimer = setIntervalImpl(analyze, config.analysisIntervalMs)
      cleanupTimer = setIntervalImpl(() => { void clean() }, config.cleanupIntervalMs)
      analysisTimer?.unref?.(); cleanupTimer?.unref?.()
    })()
    return initializing
  }
  function close() {
    if (closing) return closing
    closed = true; state = 'disposed'; ++controlGeneration
    clearIntervalImpl(analysisTimer); clearIntervalImpl(cleanupTimer)
    closing = (async () => {
      await collector.dispose()
      if (cleaning) await cleaning
      store.close()
    })()
    return closing
  }
  return { initialize, start, pause, stop, getStatus, getCurrent, getTimeline, getSummaries, analyze, clean, close }
}
