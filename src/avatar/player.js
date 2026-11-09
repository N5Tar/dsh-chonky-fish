// Embedded in the Client factory. Timers and randomness are injectable for tests.
function createAvatarPlayer(options) {
  var timer = null, running = false, disposed = false
  var schedule = options.setTimer || setTimeout, cancel = options.clearTimer || clearTimeout
  var random = options.random || Math.random
  var asset = options.asset
  function show(index) { options.onFrame(index) }
  function clear() { if (timer !== null) cancel(timer); timer = null }
  function later(callback, duration) { timer = schedule(function () { timer = null; if (running && !disposed) callback() }, duration) }
  function idle() {
    show(asset.idleFrame)
    var delay = asset.waitMinMs + Math.floor(random() * (asset.waitMaxMs - asset.waitMinMs + 1))
    later(function () { play(0) }, Math.min(asset.waitMaxMs, delay))
  }
  function play(index) {
    if (index === asset.idleFrame) { idle(); return }
    show(index)
    later(function () { play(index + 1) }, asset.frames[index].durationMs)
  }
  return {
    resume: function () { if (disposed || running) return; running = true; idle() },
    pause: function () { if (disposed) return; running = false; clear(); show(asset.idleFrame) },
    dispose: function () { running = false; disposed = true; clear() },
  }
}
