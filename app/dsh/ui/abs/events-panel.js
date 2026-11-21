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
function absEventsDayKey(value) {
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value || new Date()), fields = {}
  parts.forEach(function (part) { fields[part.type] = part.value })
  return fields.year + '-' + fields.month + '-' + fields.day
}
async function requestAbsEvents(signal, filters, offset, dayKey, snapshotSeq) {
  var bootstrap = window.__CHONKYFISH_STATE__ || {}
  var endpoint = (bootstrap.routes || {}).events || RESOURCES.routes.events
  if (!endpoint) throw new Error('事件接口地址缺失，请更新插件并刷新页面。')
  var url = new URL(endpoint, window.location.href)
  url.searchParams.set('limit', '30')
  url.searchParams.set('latest', 'true')
  url.searchParams.delete('sinceSeq')
  url.searchParams.set('day', dayKey || absEventsDayKey())
  url.searchParams.set('offset', String(offset || 0))
  if (snapshotSeq !== null && snapshotSeq !== undefined) url.searchParams.set('snapshotSeq', String(snapshotSeq))
  if (filters && filters.category !== 'all') url.searchParams.set('category', filters.category)
  if (filters && filters.evidenceStatus !== 'all') url.searchParams.set('evidenceStatus', filters.evidenceStatus)
  var response = await fetch(url.href, { signal: signal, cache: 'no-store' })
  var payload
  try { payload = await response.json() } catch (error) { throw new Error('事件接口返回非 JSON 响应。') }
  if (!response.ok) throw new Error(payload && payload.error || '事件接口请求失败（HTTP ' + response.status + '）。')
  if (!payload || payload.ok !== true || !Array.isArray(payload.events) || payload.events.some(function (row) { return !row || typeof row !== 'object' || Array.isArray(row) })) throw new Error('事件接口响应格式无效。')
  if (!payload.summary || typeof payload.summary.total !== 'number' || !payload.summary.categories || !payload.page || typeof payload.page.total !== 'number' || !Number.isSafeInteger(payload.page.snapshotSeq)) throw new Error('事件接口尚不支持 UTC+8 当日汇总和稳定分页筛选，请更新 Host 插件后重试。')
  return {
    rows: payload.events.slice(),
    summary: payload.summary && typeof payload.summary.total === 'number' && payload.summary.categories && typeof payload.summary.categories === 'object' ? payload.summary : null,
    page: payload.page && typeof payload.page.total === 'number' ? payload.page : null,
  }
}
var ABS_EVENTS_STYLE = '.cf-abs-events{color:var(--dsw-alias-text-primary,inherit);margin-top:28px;min-width:0}.cf-abs-events h2,.cf-abs-events h3,.cf-abs-events p{margin:0}.cf-abs-events-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}.cf-abs-events h2{font-size:17px;font-weight:600}.cf-abs-events-note{font-size:12px;opacity:.7;line-height:1.7}.cf-abs-events select,.cf-abs-events button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:6px;padding:7px 10px}.cf-abs-event{background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:20px;margin-top:10px;overflow-wrap:anywhere}.cf-abs-event-row{display:grid;grid-template-columns:170px minmax(0,1fr) auto;gap:20px;align-items:start}.cf-abs-event h3{font-size:14px;font-weight:600;line-height:1.7}.cf-abs-event-time{font-size:12px;line-height:1.7;font-variant-numeric:tabular-nums}.cf-abs-event-tag{font-size:12px;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:4px;padding:2px 8px}.cf-abs-event details{font-size:12px;line-height:1.8;margin-top:10px}.cf-abs-event summary{cursor:pointer}.cf-abs-event blockquote{margin:12px 0;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,currentColor);white-space:pre-wrap}.cf-abs-events :focus-visible{outline:2px solid var(--dsw-alias-text-primary,currentColor);outline-offset:3px}@container(max-width:760px){.cf-abs-event-row{grid-template-columns:minmax(0,1fr) auto;gap:10px}.cf-abs-event-time{grid-column:1/-1}.cf-abs-event{padding:16px}}'
ABS_EVENTS_STYLE += '.cf-abs-event-filters{display:flex;gap:8px;flex-wrap:wrap}.cf-abs-events-page{display:flex;justify-content:center;align-items:center;gap:12px;margin:18px 0;font-size:12px;opacity:.75}@container(max-width:760px){.cf-abs-events-page{flex-wrap:wrap}}'
function AbsEventsPanel(props) {
  var state = React.useState({ rows: [], summary: null, loading: true, error: '' }), data = state[0], setData = state[1]
  var filterState = React.useState({ category: 'all', evidenceStatus: 'all' }), filter = filterState[0], setFilter = filterState[1]
  var offsetState = React.useState(0), offset = offsetState[0], setOffset = offsetState[1]
  var dayState = React.useState(absEventsDayKey()), dayKey = dayState[0], setDayKey = dayState[1]
  var snapshotState = React.useState(null), snapshotSeq = snapshotState[0], setSnapshotSeq = snapshotState[1]
  var retryState = React.useState(0), retry = retryState[0], setRetry = retryState[1]
  React.useEffect(function () {
    var disposed = false, controller = null, generation = 0
    function cancel() { generation++; if (controller) controller.abort(); controller = null }
    async function refresh() {
      if (disposed || document.hidden || controller) return
      var current = new AbortController(), token = ++generation
      controller = current
      try {
        setData(function (previous) { return Object.assign({}, previous, { loading: true, error: '' }) })
        var result = await requestAbsEvents(current.signal, filter, offset, dayKey, offset ? snapshotSeq : null)
        if (!disposed && token === generation) { setSnapshotSeq(result.page.snapshotSeq); setData(function (previous) { return { rows: offset ? previous.rows.slice(0, offset).concat(result.rows) : result.rows, summary: result.summary, page: result.page, loading: false, error: '' } }) }
      } catch (error) {
        if (!disposed && token === generation && !current.signal.aborted) setData(function (previous) { return { rows: previous.rows, summary: previous.summary, page: previous.page, loading: false, error: error.message || '事件读取失败。' } })
      } finally { if (controller === current) controller = null }
    }
    function syncDay() {
      var currentDay = absEventsDayKey()
      if (currentDay !== dayKey) { setData({ rows: [], summary: null, page: null, loading: true, error: '' }); setOffset(0); setSnapshotSeq(null); setDayKey(currentDay); return true }
      return false
    }
    function visibility() { if (document.hidden) cancel(); else if (!syncDay()) refresh() }
    function tick() { if (!syncDay() && offset === 0) refresh() }
    refresh()
    var timer = setInterval(tick, 15000)
    document.addEventListener('visibilitychange', visibility)
    return function () { disposed = true; cancel(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [retry, filter.category, filter.evidenceStatus, offset, dayKey])
  var rows = data.rows
  var todaySummary = data.summary
  if (props && props.view === 'overview') {
    var latest = data.rows[0]
    var latestText = latest ? absEventLabel(ABS_EVENT_TYPES, latest.type, '未记录事件类型') + (latest.target ? '：' + latest.target : '') : data.loading ? '正在读取抽取事件…' : data.error ? '暂时无法读取事件' : '暂无抽取事件'
    var todayLabel = data.loading ? '正在读取今日记录' : data.error ? '更新失败 · 上次读取 ' + (todaySummary ? todaySummary.total : '—') + ' 条' : todaySummary ? '今日 ' + todaySummary.total + ' 条事件 · 来自主人的对话' : '今日数量暂不可用'
    return h('a', { className: 'abs-observation-entry', href: props.href, onClick: props.onNavigate, 'aria-label': '查看 LLM 事件抽取详情' },
      h('div', { className: 'abs-entry-heading' }, h('h2', null, 'LLM 事件抽取'), h('span', { 'aria-hidden': 'true' }, '↗')),
      h('p', { className: 'abs-muted' }, '查看对话中提取的事实、偏好与计划。'),
      h('div', { className: 'abs-entry-sample' }, latestText,
        h('small', null, latest ? '最近一条 · ' + absEventTime(latest.observedAt) + ' · ' + absEventLabel(ABS_EVENT_CATEGORIES, latest.category, '未分类') : '最近一条记录')),
      h('div', { className: 'abs-entry-foot' }, h('span', null, todayLabel), h('strong', null, '查看抽取事件 →')))
  }
  return h('section', { className: 'cf-abs-events', 'aria-label': 'LLM 事件抽取' },
    h('style', null, ABS_EVENTS_STYLE),
    h('a', { className: 'abs-back-link', href: props && props.overviewHref, onClick: props && props.onNavigate }, '← 返回 ABS 实验台'),
    h('header', { className: 'abs-detail-title' }, h('h1', { id: 'cf-abs-page-title', tabIndex: -1 }, 'LLM 事件抽取'), h('p', null, '回看从主人对话中提取了什么，以及依据是什么。')),
    h('div', { className: 'abs-events-summary' },
      h('div', null, h('span', null, '今日抽取'), h('strong', null, data.loading || !todaySummary ? '—' : todaySummary.total)),
      Object.keys(ABS_EVENT_CATEGORIES).map(function (category) { return h('div', { key: category }, h('span', null, ABS_EVENT_CATEGORIES[category]), h('strong', null, data.loading || !todaySummary ? '—' : (todaySummary.categories[category] || 0))) })),
    h('p', { className: 'cf-abs-events-note' }, '计划或意图是对话抽取结果，不代表已经执行。'),
    h('p', { className: 'cf-abs-events-note' }, '总量和分类数来自完整 UTC+8 当日记录。下方按记录时间倒序分页，类别和证据状态筛选由服务端应用于当日全部记录。'),
    h('div', { className: 'cf-abs-events-head' }, h('div', null,
      h('h2', null, 'LLM 事件抽取'),
      h('p', { className: 'cf-abs-events-note' }, '从对话中提取事件，与应用活动预测分开展示。')),
      h('div', { className: 'cf-abs-event-filters' },
        h('select', { value: filter.category, 'aria-label': '筛选事件类别', onChange: function (event) { setData({ rows: [], summary: null, page: null, loading: true, error: '' }); setOffset(0); setSnapshotSeq(null); setFilter(Object.assign({}, filter, { category: event.target.value })) } },
          h('option', { value: 'all' }, '全部类别'), Object.keys(ABS_EVENT_CATEGORIES).map(function (key) { return h('option', { key: key, value: key }, ABS_EVENT_CATEGORIES[key]) })),
        h('select', { value: filter.evidenceStatus, 'aria-label': '筛选证据状态', onChange: function (event) { setData({ rows: [], summary: null, page: null, loading: true, error: '' }); setOffset(0); setSnapshotSeq(null); setFilter(Object.assign({}, filter, { evidenceStatus: event.target.value })) } },
          h('option', { value: 'all' }, '全部证据状态'), Object.keys(ABS_EVENT_EVIDENCE).map(function (key) { return h('option', { key: key, value: key }, ABS_EVENT_EVIDENCE[key]) }))),
    data.loading ? h('p', { role: 'status', className: 'cf-abs-events-note' }, '正在读取抽取事件…') : null,
    data.error ? h('div', { role: 'alert', className: 'cf-abs-event' }, h('p', null, data.error),
      data.rows.length ? h('p', { className: 'cf-abs-events-note' }, '以下为上次读取的记录，可能不是最新数据。') : null,
      h('button', { type: 'button', onClick: function () { setRetry(function (value) { return value + 1 }) } }, '重试')) : null,
    !data.loading && !data.error && !rows.length ? h('p', { role: 'status', className: 'cf-abs-event' }, filter.category !== 'all' || filter.evidenceStatus !== 'all' ? '当日记录中没有符合当前筛选的事件。' : '今日暂无抽取事件。有可提取的对话内容后，会在这里展示。') : null,
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
    })),
    data.page && data.page.hasMore ? h('div', { className: 'cf-abs-events-page' }, h('span', null, '已显示 ' + data.rows.length + ' / ' + data.page.total + ' 条'), h('button', { type: 'button', disabled: data.loading, onClick: function () { setOffset(data.rows.length) } }, '加载更多')) : data.page ? h('p', { className: 'cf-abs-events-note' }, '已显示当日匹配记录 ' + data.rows.length + ' / ' + data.page.total + ' 条。') : null
    )
}
