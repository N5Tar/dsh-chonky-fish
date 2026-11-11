// Browser source embedded by build.mjs; React/h/RESOURCES belong to the plugin module.
var ABS_EVENT_CATEGORIES = { interaction: '互动', preference: '偏好', activity: '活动', environment: '环境', state: '状态', goal: '目标与计划' }
var ABS_EVENT_TYPES = {
  'interaction.compliment_expressed': '表达称赞', 'interaction.invitation_expressed': '发出邀请',
  'interaction.thanks_expressed': '表达感谢', 'preference.like_expressed': '表达喜欢',
  'preference.dislike_expressed': '表达不喜欢', 'preference.content_feedback_expressed': '表达内容评价',
  'activity.activity_reported': '自述活动', 'environment.content_update_reported': '转述内容更新',
  'state.self_state_expressed': '表达自身状态', 'goal.intention_expressed': '表达意图',
  'goal.plan_expressed': '表达计划', 'goal.goal_cancelled': '表达取消目标',
}
var ABS_EVENT_EVIDENCE = { reported: '语言自述 · 未经客观验证', intent: '意图 · 不代表已执行', hypothetical: '假设 · 非已发生事实', negated: '否认 · 不代表发生', uncertain: '不确定表达' }
function absEventText(value, fallback) { return typeof value === 'string' && value.length ? value : fallback }
function absEventLabel(map, value, fallback) { return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : absEventText(value, fallback) }
function absEventTime(value) {
  if (!value) return '未明确'
  var date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间无效'
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' UTC+8'
}
async function requestAbsEvents(signal) {
  var bootstrap = window.__CHONKYFISH_STATE__ || {}
  var endpoint = (bootstrap.routes || {}).events || RESOURCES.routes.events
  if (!endpoint) throw new Error('事件接口地址缺失，请更新插件并刷新页面。')
  var url = new URL(endpoint, window.location.href)
  url.searchParams.set('limit', '30')
  url.searchParams.set('latest', 'true')
  url.searchParams.delete('sinceSeq')
  var response = await fetch(url.href, { signal: signal, cache: 'no-store' })
  if (!response.ok) throw new Error('事件接口请求失败（HTTP ' + response.status + '）。')
  var payload
  try { payload = await response.json() } catch (error) { throw new Error('事件接口返回非 JSON 响应。') }
  if (!payload || payload.ok !== true || !Array.isArray(payload.events) || payload.events.some(function (row) { return !row || typeof row !== 'object' || Array.isArray(row) })) throw new Error('事件接口响应格式无效。')
  return payload.events.slice().sort(function (a, b) { return (Number(b.eventSeq) || 0) - (Number(a.eventSeq) || 0) }).slice(0, 30)
}
var ABS_EVENTS_STYLE = '.cf-abs-events{color:var(--dsw-alias-text-primary,inherit);margin-top:28px;min-width:0}.cf-abs-events h2,.cf-abs-events h3,.cf-abs-events p{margin:0}.cf-abs-events-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}.cf-abs-events h2{font-size:17px;font-weight:600}.cf-abs-events-note{font-size:12px;opacity:.7;line-height:1.7}.cf-abs-events select,.cf-abs-events button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:6px;padding:7px 10px}.cf-abs-event{background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:20px;margin-top:10px;overflow-wrap:anywhere}.cf-abs-event-row{display:grid;grid-template-columns:170px minmax(0,1fr) auto;gap:20px;align-items:start}.cf-abs-event h3{font-size:14px;font-weight:600;line-height:1.7}.cf-abs-event-time{font-size:12px;line-height:1.7;font-variant-numeric:tabular-nums}.cf-abs-event-tag{font-size:12px;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:4px;padding:2px 8px}.cf-abs-event details{font-size:12px;line-height:1.8;margin-top:10px}.cf-abs-event summary{cursor:pointer}.cf-abs-event blockquote{margin:12px 0;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,currentColor);white-space:pre-wrap}.cf-abs-events :focus-visible{outline:2px solid var(--dsw-alias-text-primary,currentColor);outline-offset:3px}@container(max-width:760px){.cf-abs-event-row{grid-template-columns:minmax(0,1fr) auto;gap:10px}.cf-abs-event-time{grid-column:1/-1}.cf-abs-event{padding:16px}}'
function AbsEventsPanel() {
  var state = React.useState({ rows: [], loading: true, error: '' }), data = state[0], setData = state[1]
  var filterState = React.useState('all'), filter = filterState[0], setFilter = filterState[1]
  var retryState = React.useState(0), retry = retryState[0], setRetry = retryState[1]
  React.useEffect(function () {
    var disposed = false, controller = null, generation = 0
    function cancel() { generation++; if (controller) controller.abort(); controller = null }
    async function refresh() {
      if (disposed || document.hidden || controller) return
      var current = new AbortController(), token = ++generation
      controller = current
      try {
        var rows = await requestAbsEvents(current.signal)
        if (!disposed && token === generation) setData({ rows: rows, loading: false, error: '' })
      } catch (error) {
        if (!disposed && token === generation && !current.signal.aborted) setData(function (previous) { return { rows: previous.rows, loading: false, error: error.message || '事件读取失败。' } })
      } finally { if (controller === current) controller = null }
    }
    function visibility() { if (document.hidden) cancel(); else refresh() }
    refresh()
    var timer = setInterval(refresh, 15000)
    document.addEventListener('visibilitychange', visibility)
    return function () { disposed = true; cancel(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [retry])
  var rows = data.rows.filter(function (row) { return filter === 'all' || row.category === filter })
  return h('section', { className: 'cf-abs-events', 'aria-label': 'LLM 事件抽取' },
    h('style', null, ABS_EVENTS_STYLE),
    h('div', { className: 'cf-abs-events-head' }, h('div', null,
      h('h2', null, 'LLM 事件抽取'),
      h('p', { className: 'cf-abs-events-note' }, '从对话中提取事件，与应用活动预测分开展示。仅显示最新 30 条，筛选仅作用于这些记录。')),
      h('select', { value: filter, 'aria-label': '筛选事件类别', onChange: function (event) { setFilter(event.target.value) } },
        h('option', { value: 'all' }, '全部事件'), Object.keys(ABS_EVENT_CATEGORIES).map(function (key) { return h('option', { key: key, value: key }, ABS_EVENT_CATEGORIES[key]) }))),
    data.loading ? h('p', { role: 'status', className: 'cf-abs-events-note' }, '正在读取抽取事件…') : null,
    data.error ? h('div', { role: 'alert', className: 'cf-abs-event' }, h('p', null, data.error),
      data.rows.length ? h('p', { className: 'cf-abs-events-note' }, '以下为上次读取的记录，可能不是最新数据。') : null,
      h('button', { type: 'button', onClick: function () { setRetry(function (value) { return value + 1 }) } }, '重试')) : null,
    !data.loading && !data.error && !rows.length ? h('p', { role: 'status', className: 'cf-abs-event' }, data.rows.length ? '最新 30 条中暂无此类别事件。' : '暂无抽取事件。有可提取的对话内容后，会在这里展示。') : null,
    rows.map(function (row, index) {
      var actor = row.actorRef === 'owner' ? '主人表达' : row.actorRef === 'persona:dafeiyu' ? '大肥鱼表达' : absEventText(row.actorRef, '主体未记录')
      return h('article', { className: 'cf-abs-event', key: row.eventId || row.eventSeq || index },
        h('div', { className: 'cf-abs-event-row' },
          h('div', { className: 'cf-abs-event-time' }, h('span', { className: 'cf-abs-events-note' }, '记录时间'), h('div', null, absEventTime(row.observedAt))),
          h('div', null, h('h3', null, absEventLabel(ABS_EVENT_TYPES, row.type, '未记录事件类型') + (row.target ? '：' + row.target : '')),
            h('p', { className: 'cf-abs-events-note' }, actor + ' · ' + absEventLabel(ABS_EVENT_EVIDENCE, row.evidenceStatus, '证据状态未记录')),
            row.type === 'goal.plan_expressed' || row.type === 'goal.intention_expressed' ? h('p', { className: 'cf-abs-events-note' }, '计划或意图不代表已执行。') : null,
            h('details', null, h('summary', null, '查看来源'),
              h('blockquote', null, absEventText(row.quote, '接口未提供原文引用。')),
              h('p', null, '事件发生时间：' + absEventTime(row.occurredAt)),
              h('p', null, '来源会话：' + absEventText(row.sessionId, '未记录')),
              h('p', null, '原文记录：' + absEventText(row.recordId, '未记录')))),
          h('span', { className: 'cf-abs-event-tag' }, absEventLabel(ABS_EVENT_CATEGORIES, row.category, '未分类'))))
    }))
}
