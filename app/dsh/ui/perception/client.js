// Embedded in the existing client factory; uses its React and host design tokens.
// Product dashboard, not a marketing page: preserve the existing navigation and styling.
var PERCEPTION_CSS = `
.cf-perception{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.65 var(--dsw-font-family,system-ui)}
.cf-perception *{box-sizing:border-box}.cf-perception .shell{max-width:960px;margin:auto;padding:32px 40px}.cf-perception header{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:24px}.cf-perception h1{font-size:28px;margin:0}.cf-perception h2{font-size:14px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:0 0 20px}.cf-perception .prediction{padding:64px 0}.cf-perception .activity{font-size:40px;font-weight:600;line-height:1.3}.cf-perception .muted{color:var(--dsw-alias-label-secondary);margin-top:20px}.cf-perception .actions{display:flex;gap:8px}.cf-perception button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 13px;cursor:pointer}.cf-perception button:disabled{opacity:.5;cursor:default}.cf-perception :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}@media(max-width:600px){.cf-perception .shell{padding:24px}.cf-perception .activity{font-size:32px}}
`
var PERCEPTION_LABELS = {
  stopped:'未开始', starting:'正在启动', running:'采集中', paused:'已暂停', stale:'采样已过期', stopping:'正在停止', error:'异常', unsupported:'当前不可用', disposed:'已关闭',
  development:'工作', browser:'浏览器活动', communication:'沟通', terminal:'终端', mixed:'混合活动', unknown:'未知', unclassified:'未分类',
  recent_input:'近期有输入', no_recent_input:'无近期输入', locked:'锁定', unlocked:'未锁定', sustained:'持续', brief:'短暂', insufficient:'数据不足', low:'低', medium:'中', high:'高',
  insufficient_coverage:'观察覆盖不足，暂不能判断', wall_clock_discontinuity:'检测到系统时间变化，已截断连续区间', terminal_is_supporting_evidence_only:'终端仅作为辅助线索', awaiting_second_confirmation:'等待下一轮确认', no_recent_input_does_not_imply_absence:'无键鼠输入不等于主人离开',
  foregroundApp:'前台应用', idleSeconds:'闲置时间', lockState:'锁屏检测', no_analysis:'尚无分析', no_sample:'尚无采样', not_running:'采集未运行', sample_stale:'采样过期', analysis_stale:'分析过期', source_stale:'分析来源过期',
}
function perceptionLabel(value) { return PERCEPTION_LABELS[value] || value || '未知' }
function perceptionTime(value) { return Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }) : '暂无' }
function perceptionDuration(ms) { return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60000)) + ' 分 ' + Math.max(0, Math.floor(ms / 1000) % 60) + ' 秒' : '暂无' }
function perceptionPercent(value) { return Number.isFinite(value) ? Math.round(value * 100) + '%' : '暂无' }
async function requestPerception(params, signal, action) {
  var bootstrap = window.__CHONKYFISH_STATE__ || {}
  var endpoint = (bootstrap.routes || {}).perception || RESOURCES.routes.perception
  if (!endpoint) throw new Error('感知接口尚未加载，请重新加载插件后刷新页面。')
  var response = await fetch(endpoint + (action ? '' : '?' + new URLSearchParams(params)), {
    method: action ? 'POST' : 'GET', signal: signal, cache:'no-store',
    headers: action ? { 'content-type':'application/json' } : undefined, body: action ? JSON.stringify({ action:action }) : undefined,
  })
  if (response.status === 404) throw new Error('感知接口尚未加载，请重新加载插件后刷新页面。')
  var payload
  try { payload = await response.json() } catch (_) { throw new Error('感知服务返回无效响应。') }
  if (!response.ok || !payload || payload.ok !== true) throw new Error(payload && payload.error && payload.error.message || '感知请求失败。')
  if (!action) {
    var type = params.action
    if (type === 'status' && (typeof payload.state !== 'string' || !payload.retention || !payload.storage || !payload.capabilities)) throw new Error('感知状态响应不完整。')
    if (type === 'current' && (!payload.freshness || (payload.data && (!Number.isFinite(payload.data.analyzedAt) || !payload.data.windowStats || !payload.data.windowStats.long || !payload.data.windowStats.long.categoryShare)))) throw new Error('感知分析响应不完整。')
    if ((type === 'timeline' || type === 'summaries') && !Array.isArray(payload.items)) throw new Error('感知历史响应不完整。')
  }
  return payload
}
function createPerceptionPage() {
  return function PerceptionPage() {
    var state = React.useState(null), status = state[0], setStatus = state[1]
    var currentState = React.useState(null), current = currentState[0], setCurrent = currentState[1]
    var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
    var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
    var revisionState = React.useState(0), revision = revisionState[0], setRevision = revisionState[1]
    var mounted = React.useRef(false), control = React.useRef(null), controlLock = React.useRef(false)
    React.useEffect(function () { mounted.current = true; return function () { mounted.current = false; if (control.current) control.current.abort() } }, [])
    React.useEffect(function () {
      var controller = new AbortController(), alive = true, pending = false
      async function poll(force) {
        if (pending || document.hidden) return
        pending = true
        try {
          var pair = await Promise.all([requestPerception({ action:'status' }, controller.signal), requestPerception({ action:'current' }, controller.signal)])
          if (!alive) return
          setStatus(pair[0]); setCurrent(pair[1]); setError('')
        } catch (cause) { if (alive && cause.name !== 'AbortError') setError(cause.message) }
        finally { pending = false }
      }
      poll(true)
      var timer = setInterval(function () { poll(false) }, 5000)
      var visible = function () { if (!document.hidden) poll(true) }
      document.addEventListener('visibilitychange', visible)
      return function () { alive = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
    }, [revision])
    async function command(action) {
      if (controlLock.current) return
      controlLock.current = true; setBusy(true); setError('')
      control.current = new AbortController()
      try { await requestPerception(null, control.current.signal, action); if (mounted.current) setRevision(function (n) { return n + 1 }) }
      catch (cause) { if (mounted.current && cause.name !== 'AbortError') setError(cause.message) }
      finally { controlLock.current = false; if (mounted.current) setBusy(false) }
    }
    var data = current && current.data
    var fresh = !error && status && status.state === 'running' && current && current.freshness && current.freshness.isFresh
    var active = status && ['running','starting','stale'].includes(status.state)
    var canStart = status && status.enabled !== false && status.capabilities && status.capabilities.supported && !active && status.state !== 'stopping'
    var prediction = fresh && data ? perceptionLabel(data.activity) : '暂无当前预测'
    var hint = error || (status && status.error && status.error.message)
      || (status && status.capabilities && !status.capabilities.supported ? status.capabilities.reason : '')
      || (status && status.enabled === false ? '感知模块已禁用。' : '')
      || (!status ? '正在读取状态…' : !active ? '采集已停止或暂停。' : !fresh ? '等待有效的分析结果…' : '')
    return h('section', { className:'abs-owner abs-panel', 'aria-label':'主人状态' },
      h('div',{className:'abs-panel-heading'},h('h2',null,'主人状态'),h('span',{className:'abs-muted'},active?'感知中':'感知未运行')),
      h('div',{className:'abs-owner-body','aria-live':'polite'},h('div',{className:'activity'},prediction),
        h('p',{className:'abs-muted',role:error?'alert':undefined},hint||'当前状态预测')),
      h('div',{className:'abs-panel-footer'},h('span',null,fresh&&data?'更新于 '+perceptionTime(data.analyzedAt):'当前无有效预测'),
        h('div',{className:'abs-actions'},
          h('button',{disabled:busy||(!active&&!canStart),onClick:function(){command(active?'stop':'start')}},busy?'处理中…':active?'停止感知':'开始感知'),
          h('button',{disabled:busy,onClick:function(){setRevision(function(n){return n+1})}},'刷新'))))
  }
}
// Stable component identity: polling effects survive ABS parent refreshes.
var AbsOwnerStatePanel = createPerceptionPage()
