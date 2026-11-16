// Embedded in the Client factory. Timers and randomness are injectable for tests.
function createAvatarPlayer(options) {
  var timer = null, running = false, disposed = false, previous = null
  var schedule = options.setTimer || setTimeout, cancel = options.clearTimer || clearTimeout
  var random = options.random || Math.random, asset = options.asset
  function show(index) { options.onFrame(index) }
  function clear() { if (timer !== null) cancel(timer); timer = null }
  function later(callback, duration) { timer = schedule(function () { timer = null; if (running && !disposed) callback() }, duration) }
  function integer(min, max) { return Math.min(max, min + Math.floor(random() * (max - min + 1))) }
  function rest() {
    show(asset.idleFrame)
    later(choose, integer(asset.waitMinMs, asset.waitMaxMs))
  }
  function choose() {
    var choices = asset.actions.filter(function (action) { return action.name !== previous })
    if (!choices.length) choices = asset.actions
    var total = choices.reduce(function (sum, action) { return sum + action.weight }, 0)
    var pick = random() * total, action = choices[choices.length - 1]
    for (var i = 0; i < choices.length; i++) {
      pick -= choices[i].weight
      if (pick < 0) { action = choices[i]; break }
    }
    previous = action.name
    play(action, 0, integer(action.minLoops, action.maxLoops))
  }
  function play(action, position, loops) {
    var index = action.frames[position]
    show(index)
    later(function () {
      if (position + 1 < action.frames.length) play(action, position + 1, loops)
      else if (loops > 1) play(action, 0, loops - 1)
      else rest()
    }, asset.frames[index].durationMs / asset.playbackRate)
  }
  return {
    resume: function () { if (disposed || running) return; running = true; rest() },
    pause: function () { if (disposed) return; running = false; clear(); show(asset.idleFrame) },
    dispose: function () { running = false; disposed = true; clear() },
  }
}
