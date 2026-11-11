// Frame-wide decoration: only its small hide/restore button accepts pointer events.
Object.assign(zh, { avatarLabel: '大肥鱼虚拟形象', avatarHide: '暂时隐藏大肥鱼', avatarShow: '显示大肥鱼' })
Object.assign(en, { avatarLabel: 'ChonkyFish avatar', avatarHide: 'Hide ChonkyFish', avatarShow: 'Show ChonkyFish' })
var AVATAR_CSS = '.cf-avatar{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));width:144px;height:144px;pointer-events:none;z-index:0;isolation:isolate}.cf-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;user-select:none}.cf-avatar button{position:absolute;right:0;top:0;pointer-events:auto;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;width:26px;height:26px;padding:0;font:14px system-ui;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);opacity:.65}.cf-avatar button:hover,.cf-avatar button:focus-visible{opacity:1}.cf-avatar button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.cf-avatar.is-hidden{width:30px;height:30px}.cf-avatar.is-hidden button{width:30px;height:30px}@media(max-width:640px){.cf-avatar{width:104px;height:104px;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom))}}'
function createAvatarComponent(t) {
  return function AvatarWidget() {
    var frameState = React.useState(AVATAR_ASSET.idleFrame), frame = frameState[0], setFrame = frameState[1]
    var hiddenState = React.useState(false), hidden = hiddenState[0], setHidden = hiddenState[1]
    var readyState = React.useState(false), ready = readyState[0], setReady = readyState[1]
    React.useEffect(function () {
      var active = true, images = []
      Promise.all(AVATAR_ASSET.frames.map(function (entry) {
        return new Promise(function (resolve, reject) {
          var image = new Image(); images.push(image)
          image.onload = function () { if (image.decode) image.decode().then(resolve, reject); else resolve() }
          image.onerror = reject; image.src = entry.src
        })
      })).then(function () { if (active) setReady(true) }).catch(function () { /* Keep the idle image if any action frame fails. */ })
      return function () { active = false; images.forEach(function (image) { image.onload = null; image.onerror = null }) }
    }, [])
    React.useEffect(function () {
      var player = createAvatarPlayer({ asset: AVATAR_ASSET, onFrame: setFrame })
      var reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      function sync() {
        if (hidden || !ready || reduced.matches || document.visibilityState === 'hidden') player.pause()
        else player.resume()
      }
      document.addEventListener('visibilitychange', sync)
      reduced.addEventListener('change', sync)
      sync()
      return function () { player.dispose(); document.removeEventListener('visibilitychange', sync); reduced.removeEventListener('change', sync) }
    }, [hidden, ready])
    return h('div', { className: 'cf-avatar' + (hidden ? ' is-hidden' : ''), 'data-avatar-frame': hidden ? 'hidden' : frame },
      h('style', null, AVATAR_CSS),
      !hidden && h('div', { role: 'img', 'aria-label': t('avatarLabel') }, AVATAR_ASSET.frames.map(function (entry, index) {
        return h('img', { key: index, src: entry.src, alt: '', draggable: false, 'aria-hidden': true, width: AVATAR_ASSET.width, height: AVATAR_ASSET.height, style: { visibility: index === frame ? 'visible' : 'hidden' } })
      })),
      h('button', { type: 'button', title: t(hidden ? 'avatarShow' : 'avatarHide'), 'aria-label': t(hidden ? 'avatarShow' : 'avatarHide'), onClick: function () { setHidden(!hidden) } }, hidden ? '◉' : '×'))
  }
}
