// Embedded in the existing client factory; uses its React and host design tokens.
// Product dashboard, not a marketing page: preserve the existing navigation and styling.
var PERCEPTION_CSS = `
.cf-perception{height:100%;overflow:auto;container-type:inline-size;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.65 var(--dsw-font-family,system-ui)}
.cf-perception *{box-sizing:border-box}.cf-perception .shell{max-width:1280px;margin:auto;padding:32px 40px 48px}.cf-perception h1{font-size:28px;margin:0 0 8px}.cf-perception h2{font-size:19px;margin:0 0 16px}.cf-perception h3{font-size:15px;margin:0 0 12px}.cf-perception p{margin:6px 0}.cf-perception .muted{color:var(--dsw-alias-label-secondary)}
.cf-perception header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:20px;padding-bottom:24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.cf-perception .actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.cf-perception button,.cf-perception select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 13px;cursor:pointer;white-space:nowrap}.cf-perception button:hover{background:var(--dsw-alias-bg-layer-2)}.cf-perception button:active{transform:translateY(1px)}.cf-perception button:disabled{opacity:.5;cursor:default}.cf-perception .primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}.cf-perception :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.cf-perception .statusline{padding:16px 0;display:flex;gap:20px;flex-wrap:wrap}.cf-perception .notice{padding:12px 16px;background:var(--dsw-alias-bg-layer-1);border-left:3px solid var(--dsw-alias-brand-primary);margin:12px 0;overflow-wrap:anywhere}.cf-perception .columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px}.cf-perception section.block{padding:24px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.cf-perception dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 14px;margin:0}.cf-perception dt{color:var(--dsw-alias-label-secondary)}.cf-perception dd{margin:0;overflow-wrap:anywhere}.cf-perception .activity{font-size:24px;font-weight:600;margin-bottom:8px}.cf-perception .metrics{display:flex;gap:20px;flex-wrap:wrap;margin-top:14px}.cf-perception .metrics strong{font-variant-numeric:tabular-nums}.cf-perception .apps{padding-left:18px;margin-bottom:0}.cf-perception .empty{padding:24px 0;color:var(--dsw-alias-label-secondary)}
.cf-perception .timeline{margin-top:20px}.cf-perception .track{display:grid;grid-template-columns:90px minmax(0,1fr);gap:12px;align-items:center;margin:10px 0}.cf-perception .track svg{width:100%;height:24px;display:block;background:var(--dsw-alias-bg-layer-1)}.cf-perception .axis{display:flex;justify-content:space-between;margin-left:102px;font-size:12px;color:var(--dsw-alias-label-secondary)}.cf-perception .band{fill:var(--dsw-alias-brand-primary);opacity:.75}.cf-perception .band[data-kind=gap]{fill:var(--dsw-alias-border-l2);opacity:.6}.cf-perception .band[data-kind=locked]{fill:var(--dsw-alias-label-secondary);opacity:.4}.cf-perception .band[data-kind=browser]{opacity:.4}.cf-perception .band[data-kind=communication]{opacity:.55}.cf-perception .band[data-kind=terminal]{opacity:.9}.cf-perception .band[data-kind=unknown],.cf-perception .band[data-kind=unclassified],.cf-perception .band[data-kind=no_recent_input]{fill:var(--dsw-alias-label-secondary);opacity:.45}
.cf-perception .table-wrap{overflow:auto}.cf-perception table{border-collapse:collapse;width:100%;text-align:left;font-size:13px}.cf-perception th{font-weight:500;color:var(--dsw-alias-label-secondary)}.cf-perception th,.cf-perception td{padding:10px 12px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}.cf-perception .details{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:var(--dsw-alias-bg-layer-1);padding:14px;border-radius:8px}.cf-perception .footer{margin-top:24px;font-size:12px;color:var(--dsw-alias-label-secondary)}
@container(max-width:720px){.cf-perception .shell{padding:22px 16px}.cf-perception .columns{grid-template-columns:1fr;gap:0}.cf-perception .track{grid-template-columns:70px minmax(0,1fr)}.cf-perception .axis{margin-left:82px}}
`
var PERCEPTION_LABELS = {
  stopped:'未开始', starting:'正在启动', running:'采集中', paused:'已暂停', stale:'采样已过期', stopping:'正在停止', error:'异常', unsupported:'当前不可用', disposed:'已关闭',
  development:'开发倾向', browser:'浏览器活动', communication:'沟通', terminal:'终端', mixed:'混合活动', unknown:'未知', unclassified:'未分类',
  recent_input:'近期有输入', no_recent_input:'无近期输入', locked:'锁定', unlocked:'未锁定', sustained:'持续', brief:'短暂', insufficient:'数据不足', low:'低', medium:'中', high:'高',
  insufficient_coverage:'观察覆盖不足，暂不能判断', wall_clock_discontinuity:'检测到系统时间变化，已截断连续区间', terminal_is_supporting_evidence_only:'终端仅作为辅助线索', awaiting_second_confirmation:'等待下一轮确认', no_recent_input_does_not_imply_absence:'无键鼠输入不等于主人离开',
  foregroundApp:'前台应用', idleSeconds:'闲置时间', lockState:'锁屏检测', no_analysis:'尚无分析', no_sample:'尚无采样', not_running:'采集未运行', sample_stale:'采样过期', analysis_stale:'分析过期', source_stale:'分析来源过期',
}
function perceptionLabel(value) { return PERCEPTION_LABELS[value] || value || '未知' }
function perceptionTime(value) { return Number.isFinite(value) ? new Date(value).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '暂无' }
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
function perceptionBands(items, from, to, field) {
  var result = []
  if (!(to > from)) return result
  items.forEach(function (item) {
    var left = Math.max(from, item.startMs), right = Math.min(to, item.endMs)
    if (!(right > left)) return
    var label = field === 'app' ? item.app && item.app.name || (item.kind === 'locked' ? '锁定' : '数据缺口') : perceptionLabel(item[field] || 'unknown')
    var kind = item.kind === 'gap' ? 'gap' : field === 'app' ? item.category || item.kind : item[field] || 'unknown'
    var prior = result[result.length - 1]
    if (prior && prior.label === label && prior.kind === kind && prior.end === left) prior.end = right
    else result.push({ start:left, end:right, label:label, kind:kind })
  })
  return result
}
function createPerceptionPage() {
  return function PerceptionPage() {
    var state = React.useState(null), status = state[0], setStatus = state[1]
    var currentState = React.useState(null), current = currentState[0], setCurrent = currentState[1]
    var timelineState = React.useState(null), timeline = timelineState[0], setTimeline = timelineState[1]
    var historyState = React.useState({ items:[], nextCursor:null }), history = historyState[0], setHistory = historyState[1]
    var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
    var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
    var rangeState = React.useState(60), minutes = rangeState[0], setMinutes = rangeState[1]
    var detailState = React.useState(null), detail = detailState[0], setDetail = detailState[1]
    var revisionState = React.useState(0), revision = revisionState[0], setRevision = revisionState[1]
    var cursorState = React.useState(null), cursor = cursorState[0], setCursor = cursorState[1]
    var mounted = React.useRef(false), control = React.useRef(null), controlLock = React.useRef(false)
    React.useEffect(function () { mounted.current = true; return function () { mounted.current = false; if (control.current) control.current.abort() } }, [])
    React.useEffect(function () {
      var controller = new AbortController(), alive = true, pending = false, lastTimeline = 0
      async function poll(force) {
        if (pending || document.hidden) return
        pending = true
        try {
          var pair = await Promise.all([requestPerception({ action:'status' }, controller.signal), requestPerception({ action:'current' }, controller.signal)])
          if (!alive) return
          setStatus(pair[0]); setCurrent(pair[1]); setError('')
          if (force || Date.now() - lastTimeline >= 15000) {
            var end = Date.now(), start = end - minutes * 60000
            var range = await requestPerception({ action:'timeline', fromMs:start, toMs:end }, controller.signal)
            var recent = await requestPerception({ action:'summaries', fromMs:start, toMs:end, limit:500 }, controller.signal)
            if (alive) { setTimeline(Object.assign({}, range, { summaries:recent.items || [] })); lastTimeline = Date.now() }
          }
        } catch (cause) { if (alive && cause.name !== 'AbortError') setError(cause.message) }
        finally { pending = false }
      }
      poll(true)
      var timer = setInterval(function () { poll(false) }, 5000)
      var visible = function () { if (!document.hidden) poll(true) }
      document.addEventListener('visibilitychange', visible)
      return function () { alive = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
    }, [minutes, revision])
    React.useEffect(function () {
      var controller = new AbortController(), alive = true
      var params = { action:'summaries', limit:120 }
      if (cursor != null) params.cursor = cursor
      var pending = false
      async function refreshHistory() {
        if (pending || document.hidden) return
        pending = true
        try { var value = await requestPerception(params, controller.signal); if (alive) setHistory(value) }
        catch (cause) { if (alive && cause.name !== 'AbortError') setError(cause.message) }
        finally { pending = false }
      }
      refreshHistory()
      var historyTimer = setInterval(refreshHistory, 15000)
      document.addEventListener('visibilitychange', refreshHistory)
      return function () { alive = false; controller.abort(); clearInterval(historyTimer); document.removeEventListener('visibilitychange', refreshHistory) }
    }, [cursor, revision])
    async function command(action) {
      if (controlLock.current) return
      controlLock.current = true; setBusy(true); setError('')
      control.current = new AbortController()
      try { await requestPerception(null, control.current.signal, action); if (mounted.current) setRevision(function (n) { return n + 1 }) }
      catch (cause) { if (mounted.current && cause.name !== 'AbortError') setError(cause.message) }
      finally { controlLock.current = false; if (mounted.current) setBusy(false) }
    }
    var sample = status && status.latestSample, data = current && current.data, stats = data && data.windowStats && data.windowStats.long
    var fresh = !error && status && status.state === 'running' && current && current.freshness && current.freshness.isFresh
    var active = status && ['running','starting','stale'].includes(status.state)
    var canStart = status && status.enabled !== false && status.capabilities && status.capabilities.supported && !active && status.state !== 'stopping'
    function metric(label, value) { return h('div', { key:label }, h('span', { className:'muted' }, label + ' '), h('strong', null, value)) }
    function definition(pairs) { return h('dl', null, pairs.map(function (pair) { return h(React.Fragment, { key:pair[0] }, h('dt', null, pair[0]), h('dd', null, pair[1])) })) }
    function track(label, bands, from, to) {
      return h('div', { className:'track', key:label }, h('span', null, label), h('svg', { viewBox:'0 0 1000 24', preserveAspectRatio:'none', role:'img', 'aria-label':label + '时间轴' }, bands.map(function (band, index) {
        return h('rect', { key:index, className:'band', 'data-kind':band.kind, x:(band.start-from)/(to-from)*1000, y:2, width:Math.max(.2,(band.end-band.start)/(to-from)*1000), height:20 }, h('title', null, band.label + ' · ' + perceptionTime(band.start) + ' 至 ' + perceptionTime(band.end)))
      })))
    }
    function timelines() {
      if (!timeline || !(timeline.toMs > timeline.fromMs)) return h('p', { className:'empty' }, '尚无时间轴。开始采集后可查看观察与判断。')
      var from = timeline.fromMs, to = timeline.toMs, items = timeline.items || []
      var summaries = (timeline.summaries || []).slice().sort(function (a,b) { return a.analyzedAt - b.analyzedAt })
      // A sparse summary is only evidence near its recorded time, never proof across a long gap.
      var analyzed = summaries.map(function (item, index) { return { start:item.analyzedAt, end:Math.min(to,item.analyzedAt+60000,summaries[index+1] ? summaries[index+1].analyzedAt : to), kind:item.activity, label:perceptionLabel(item.activity) } }).filter(function (item) { return item.end > item.start })
      return h('div', { className:'timeline' }, timeline.containsPriorRuns?h('p',{className:'notice'},'时间轴含此前采集轮次，旧版记录可能不准确；这些历史记录不参与当前分析。'):null, track('前台应用', perceptionBands(items,from,to,'app'),from,to), track('交互状态', perceptionBands(items,from,to,'interaction'),from,to), track('分析结果',analyzed,from,to), h('div', { className:'axis' }, h('span',null,perceptionTime(from)),h('span',null,perceptionTime(to))), h('p',{className:'muted'},'悬停区间查看名称和时间。灰色表示未知或缺口；原始记录只显示保留范围内的数据。'))
    }
    return h('div', { className:'cf-perception' }, h('style',null,PERCEPTION_CSS), h('div',{className:'shell'},
      h('header',null,h('div',null,h('h1',null,'感知实验台'),h('p',{className:'muted'},'观察电脑活动线索，查看大肥鱼会得到什么判断。')),
        h('div',{className:'actions'},h('button',{className:'primary',disabled:busy||!canStart,onClick:function(){command('start')}},busy?'处理中…':'开始采集'),h('button',{disabled:busy||!active,onClick:function(){command('pause')}},'暂停'),h('button',{disabled:busy||!status||['stopped','unsupported','disposed'].includes(status.state),onClick:function(){command('stop')}},'停止'),h('button',{disabled:busy,onClick:function(){setRevision(function(n){return n+1})}},'刷新'))),
      h('div',{className:'statusline','aria-live':'polite'},h('strong',null,error?'连接或采集异常':status?perceptionLabel(status.state):'正在读取状态…'),h('span',{className:'muted'},'最近采集：'+perceptionTime(sample&&sample.receivedAtMs)),h('span',{className:'muted'},'最近分析：'+perceptionTime(status&&status.lastAnalysisAt))),
      h('p',{className:'muted'},'只观察当前输入焦点应用；双屏可同时显示多个应用，但不会把所有可见窗口视为正在使用。新一轮分析只使用本次开始后的采样。'),
      error?h('p',{className:'notice',role:'alert'},error):null,
      status&&status.error?h('p',{className:'notice',role:'alert'},status.error.message):null,
      status&&status.capabilities&&!status.capabilities.supported?h('p',{className:'notice'},status.capabilities.reason):null,
      status&&status.enabled===false?h('p',{className:'notice'},'感知模块已禁用，历史记录仍可查看。'):null,
      h('div',{className:'columns'},h('section',{className:'block'},h('h2',null,'当前观察'),sample?definition([
        ['输入焦点应用',sample.foregroundApp&&sample.foregroundApp.name||'未知'],['应用标识',sample.foregroundApp&&sample.foregroundApp.id||'未知'],['最近输入',Number.isFinite(sample.idleSeconds)?perceptionDuration(sample.idleSeconds*1000)+'前':'未知'],['会话状态',perceptionLabel(sample.sessionState)],['缺失能力',(sample.missing||[]).map(perceptionLabel).join('、')||'无'],
      ]):h('p',{className:'empty'},'尚未采集。仅在点击开始后读取前台应用和闲置时间。')),
      h('section',{className:'block'},h('h2',null,'当前分析'),data?h(React.Fragment,null,h('div',{className:'activity'},perceptionLabel(data.activity)),h('p',null,perceptionLabel(data.interaction)+' · '+perceptionLabel(data.continuity)+' · 置信等级 '+perceptionLabel(data.confidence)),h('p',{className:'muted'},(fresh?'当前结果':'非实时结果')+' · 推断持续 '+perceptionDuration(data.analyzedAt-data.activitySince)),(data.evidence||[]).map(function(value){return h('p',{key:value,className:'muted'},perceptionLabel(value))}),stats?h('div',{className:'metrics'},metric('15 分钟覆盖',perceptionPercent(stats.coverage)),metric('开发占比',perceptionPercent(stats.categoryShare.development)),metric('观察到的切换',stats.observedSwitches??0)):null):h('p',{className:'empty'},'开始采集后每 30 秒分析一次。观察不足时明确显示未知，不强行判断。'))),
      stats&&stats.apps&&stats.apps.length?h('section',{className:'block'},h('h2',null,'最近 15 分钟应用分布'),h('ul',{className:'apps'},stats.apps.slice(0,8).map(function(app,index){return h('li',{key:index},(app.name||app.id||'未分类')+' · '+perceptionDuration(app.durationMs)+' · '+perceptionPercent(app.share))}))):null,
      h('section',{className:'block'},h('div',{className:'actions'},h('h2',null,'近期变化'),h('label',null,'查看范围 ',h('select',{value:minutes,onChange:function(e){setMinutes(Number(e.target.value))}},[15,30,60].map(function(n){return h('option',{key:n,value:n},'最近 '+n+' 分钟')})))),timelines()),
      h('section',{className:'block'},h('h2',null,'历史摘要'),h('p',{className:'muted'},'只保留计算后的结果，不还原已清理的原始活动。'),
        history.items&&history.items.length?h('div',{className:'table-wrap'},h('table',null,h('thead',null,h('tr',null,['时间','活动','交互','置信等级','依据'].map(function(x){return h('th',{key:x,scope:'col'},x)}))),h('tbody',null,history.items.map(function(item){return h('tr',{key:item.id},h('td',null,new Date(item.analyzedAt).toLocaleString()),h('td',null,perceptionLabel(item.activity),item.ruleVersion==='activity-v1'?h('span',{className:'muted'},' · 旧版记录，待核实'):null),h('td',null,perceptionLabel(item.interaction)),h('td',null,perceptionLabel(item.confidence)),h('td',null,h('button',{onClick:function(){setDetail(item)}},'查看')))})))):h('p',{className:'empty'},'尚无历史摘要。'),
        h('div',{className:'actions'},h('button',{disabled:cursor==null,onClick:function(){setCursor(null);setRevision(function(n){return n+1})}},'最新摘要'),h('button',{disabled:history.nextCursor==null,onClick:function(){setCursor(history.nextCursor)}},'更早摘要')),
        detail?h('div',null,h('h3',null,'摘要依据 · '+perceptionTime(detail.analyzedAt)),h('pre',{className:'details'},JSON.stringify({ruleVersion:detail.ruleVersion,activity:perceptionLabel(detail.activity),evidence:(detail.evidence||[]).map(perceptionLabel),windowStats:detail.windowStats},null,2)),h('button',{onClick:function(){setDetail(null)}},'收起')):null),
      h('section',{className:'block'},h('h2',null,'数据保留与清理'),status?definition([
        ['原始采样',(status.storage&&status.storage.samples||0)+' 条 · 保留 '+perceptionDuration(status.retention.rawTtlMs)],['历史摘要',(status.storage&&status.storage.summaries||0)+' 条 · 保留 '+Math.round(status.retention.summaryTtlMs/86400000*100)/100+' 天'],['最近清理',status.cleanup?perceptionTime(status.cleanup.at)+' · 删除 '+status.cleanup.samples+' 条采样 / '+status.cleanup.summaries+' 条摘要':'尚未执行'],['清理状态',status.cleanup&&status.cleanup.error?status.cleanup.error.message:'正常 · 每 5 分钟清理'],
      ]):h('p',{className:'empty'},'正在读取保留状态…')),
      h('p',{className:'footer'},'仅本地处理应用级元数据；不读取屏幕、窗口标题、网页内容或键盘内容。无输入不等于离开，前台时长不等于工作时长。关闭页面不会停止采集，请使用暂停或停止。')
    ))
  }
}
