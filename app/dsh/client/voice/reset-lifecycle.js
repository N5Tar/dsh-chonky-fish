/** Serialize a Session binding reset behind all active voice teardown handlers. */
export async function finishVoiceResetCall({ service, playback, setupPromise, hangupOptions } = {}) {
  if (setupPromise) { try { await setupPromise } catch {} }
  if (service) await service.hangup(hangupOptions)
  else await playback?.release?.()
}

export function createVoiceResetBarrier() {
  const listeners = new Set()
  let resetting = false
  let pending = null

  return {
    isResetting() { return resetting },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('reset listener must be a function')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    run(details, rebind) {
      if (pending) return pending
      resetting = true
      const current = (async () => {
        const outcomes = await Promise.all(Array.from(listeners, listener =>
          Promise.resolve().then(() => listener(details)).then(
            () => null,
            error => error,
          ),
        ))
        const failure = outcomes.find(error => error !== null)
        if (failure) throw failure
        return typeof rebind === 'function' ? rebind() : undefined
      })()
      let wrapped
      wrapped = current.finally(() => {
        if (pending === wrapped) pending = null
        resetting = false
      })
      pending = wrapped
      return wrapped
    },
  }
}
