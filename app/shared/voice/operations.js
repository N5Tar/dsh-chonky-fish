import { createHash } from 'node:crypto'

const fail = (code, message = code) => Object.assign(new Error(message), { code })
const MAX_ACTIVE = 16
const OPERATION_TTL_MS = 2 * 60 * 1000

/**
 * Owns one provider operation and its optional archive writer. Provider events
 * are forwarded immediately; persistence errors only disable this archive.
 */
export function createVoiceOperationManager({ repository = null, now = Date.now, maxActive = MAX_ACTIVE, operationTtlMs = OPERATION_TTL_MS, logger = null } = {}) {
  const active = new Map(), completed = new Map()
  let archive = repository
  let closed = false
  const warn = error => { try { logger?.warn?.('[chonkyfish/voice] audio archive failed', error?.code || error) } catch {} }
  function prune() {
    const cutoff = now() - operationTtlMs
    for (const [id, value] of completed) if (value.updatedAt < cutoff) completed.delete(id)
    while (completed.size > 256) completed.delete(completed.keys().next().value)
  }
  function run({ operationId, owner, source, text, voiceId, provider, binding, signal, isCurrent = () => true, save = true, expressionTag = null }) {
    if (closed) throw fail('VOICE_OPERATION_CLOSED')
    prune()
    if (typeof operationId !== 'string' || !operationId || operationId.length > 128 || active.size >= maxActive) throw fail(active.size >= maxActive ? 'VOICE_BUSY' : 'INVALID_ARGUMENT')
    if (active.has(operationId)) throw fail('VOICE_OPERATION_IN_PROGRESS')
    const existing = completed.get(operationId)
    const digest = createHash('sha256').update(text).digest('hex')
    if (existing) {
      if (existing.digest !== digest || JSON.stringify(existing.source) !== JSON.stringify(source)) throw fail('VOICE_OPERATION_CONFLICT')
      throw fail('VOICE_OPERATION_ALREADY_COMPLETED')
    }
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const operation = { operationId, controller, digest, source, startedAt: now(), updatedAt: now() }
    active.set(operationId, operation)
    const completedOps = completed
    const events = (async function* () {
      let writer = null, successful = false, archived = null, bytes = 0
      try {
        if (save && repository && provider.id !== 'aliyun-qwen-tts' && provider.id !== 'windows-system-speech') throw fail('VOICE_PROVIDER_UNSUPPORTED')
        for await (const event of provider.synthesize({ binding, text, expressionTag, operationId, signal: controller.signal, format: 'pcm' })) {
          if (controller.signal.aborted) throw fail('TTS_CANCELLED')
          if (event?.type === 'audio') {
            if (!(event.data instanceof Uint8Array) || !event.data.length || !event.format || typeof event.format.codec !== 'string') throw fail('TTS_INVALID_AUDIO')
            bytes += event.data.byteLength
            if (bytes > 12 * 1024 * 1024) throw fail('TTS_LIMIT_EXCEEDED')
            if (!writer && save && archive) {
              try { writer = await archive.beginAudio({ owner, source, textDigest: digest, voiceId, format: event.format, operationId }) }
              catch (error) { warn(error); writer = null }
            }
            if (writer) {
              try { await writer.append(event.data) }
              catch (error) { warn(error); try { await writer.abort() } catch {} writer = null }
            }
            yield event
          } else if (event?.type === 'complete') {
            if (successful || !bytes) throw fail('TTS_INVALID_RESPONSE')
            if (controller.signal.aborted || !isCurrent()) throw fail('TTS_CANCELLED')
            successful = true
            if (writer) {
              try { archived = await writer.commit(); writer = null }
              catch (error) { warn(error); try { await writer?.abort() } catch {}; writer = null }
            }
            operation.updatedAt = now()
            yield { type: 'complete', receipt: { ...(event.receipt || {}), archived: Boolean(archived?.audio), audio: archived?.audio || null } }
            return
          } else throw fail('TTS_INVALID_RESPONSE')
        }
        if (!successful) throw fail('TTS_INCOMPLETE')
      } catch (error) {
        if (writer) { try { await writer.abort() } catch {} }
        throw error
      } finally {
        signal?.removeEventListener('abort', abort)
        active.delete(operationId)
        if (successful) completedOps.set(operationId, { digest, source, updatedAt: now(), audio: archived?.audio || null })
      }
    })()
    return {
      events,
      cancel(reason = 'cancelled') { if (!controller.signal.aborted) controller.abort(fail('TTS_CANCELLED', reason)) },
      get signal() { return controller.signal },
    }
  }
  return {
    run,
    setRepository(value) { archive = value || null },
    cancel(operationId, reason) { const item = active.get(operationId); if (!item) return false; item.controller.abort(fail('TTS_CANCELLED', reason || 'cancelled')); return true },
    abortAll(reason = 'closed') { for (const item of active.values()) item.controller.abort(fail('TTS_CANCELLED', reason)) },
    close() { if (closed) return; closed = true; this.abortAll('closed'); active.clear(); completed.clear() },
    get activeCount() { return active.size },
  }
}
