// Browser source embedded by build.mjs; React/h/RESOURCES belong to the plugin module.
var ABS_ACTIVITY_LABELS = { interesting: '有意思', repetitive: '重复', follow_up_worthy: '值得跟进' }
var ABS_ACTIVITY_OUTCOMES = { verified: '已验证', no_action: '未观察到行动', failed: '失败', unknown: '未知', not_started: '未启动' }
var ABS_ACTIVITY_EVIDENCE = { verified: '结果已验证', failed: '执行失败', unverified: '结果未验证', pending: '已发起工具请求，尚无回执' }
var ABS_ACTIVITY_FAILURE_PHASES = { before_tools: '工具请求前', during_tools: '工具执行期间', after_tools: '工具执行后', not_executed: '本轮未执行' }
var ABS_ACTIVITY_FAILURE_CODES = { TRANSPORT: '模型连接失败', TIMEOUT: '模型请求超时', RATE_LIMIT: '模型服务限流', QUOTA: '模型额度不足', AUTH: '模型服务认证失败', INVALID_REQUEST: '模型请求无效', MODEL_ERROR: '模型调用失败', ABORTED: '请求被取消', INTERRUPTED: '本轮意外中断', BLOCKED: '本轮未能继续', TURN_ERROR: '本轮执行失败', NOT_EXECUTED: '没有实际执行本轮模型步骤' }
// Action names come from the registry (core/modules/abs/actions.js) via RESOURCES.absActions; none are listed here.
function absActionLabel(intent) {
  var views = typeof RESOURCES !== 'undefined' && RESOURCES.absActions || {}
  return Object.prototype.hasOwnProperty.call(views, intent) ? views[intent].label : null
}
var ABS_ACTION_REASONS = { selected: '符合候选条件', no_candidate: '没有符合条件的行动', action_selection_disabled: '当时没有启用行动选择', owner_interaction_unknown: '当时主人交流时间未知', work_streak_missing_or_unverified: '当时没有可用的连续工作记录', work_streak_already_reminded: '当时这段工作记录已提醒过', gap_below_threshold: '当时的需求未达到候选阈值', quota_cooldown: '历史记录：当时处于触达冷却期', mode_off: '当时 ABS 已关闭', not_due: '本次尚未到审查时间' }
var ABS_ACTION_DISPATCH = { preview: '仅预览，未派发', reserved: '派发请求处理中', enqueued: '已派发到当前会话', unknown: '派发结果未知', released: '派发未完成', suppressed: '未派发' }
var ABS_ACTION_RESOLUTION_REASONS = { action_selection_disabled: '当时没有启用行动选择', quota_cooldown: '历史记录：当时处于触达冷却期', TIME_PAUSED: '状态变化已暂停', MODE_NOT_ACTIVE: '当时 ABS 不是执行模式', ACTION_SELECTION_DISABLED: '当时没有启用行动选择', REST_HOURS: '当前处于每日休息时段', SESSION_BINDING_CHANGED: '绑定会话已变化', 'no-panel-session': '面板尚未绑定会话', 'session-binding-changed': '绑定会话已变化', 'resolve-failed': '无法解析绑定会话', 'session-binding-mismatch': '会话身份不匹配', 'followup-outcome-unknown': '派发结果未知', 'persistence-unacknowledged': '会话尚未确认持久化' }
function absActionSelectionText(selection) {
  if (!selection) return null
  var intent = absActionLabel(selection.intent) || (selection.intent == null ? '无行动提示' : '行动类型未分类')
  return intent + ' · ' + (ABS_ACTION_REASONS[selection.reason] || '选择原因未分类')
}
function absActivityWindow() {
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()), fields = {}
  parts.forEach(function (part) { fields[part.type] = part.value })
  var day = fields.year + '-' + fields.month + '-' + fields.day
  return { from: new Date(day + 'T00:00:00+08:00').toISOString(), to: new Date(new Date(day + 'T00:00:00+08:00').getTime() + 86400000).toISOString() }
}
function absActivityUrl(range, cursor, snapshotAt, snapshotSeq, outcome) {
  var bootstrap = window.__CHONKYFISH_STATE__ || {}, endpoint = (bootstrap.routes || {}).absActivities || (RESOURCES.routes || {}).absActivities
  if (!endpoint) throw new Error('内心活动接口地址缺失，请更新插件并刷新页面。')
  var url = new URL(endpoint, window.location.href), windowRange = range || absActivityWindow()
  url.searchParams.set('from', windowRange.from); url.searchParams.set('to', windowRange.to); url.searchParams.set('limit', '100')
  if (cursor) { url.searchParams.set('beforeWakeAt', cursor.wakeAt); url.searchParams.set('beforeEpisodeId', cursor.episodeId) }
  if (snapshotAt) url.searchParams.set('snapshotAt', snapshotAt)
  if (snapshotSeq !== null && snapshotSeq !== undefined) url.searchParams.set('snapshotSeq', String(snapshotSeq))
  if (outcome && outcome !== 'all') url.searchParams.set('outcome', outcome)
  return url.href
}
async function annotateAbsActivity(activityId, label, active, signal) {
  var response = await fetch(absActivityUrl(), { method: 'POST', signal: signal, cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'annotate', activityId: activityId, label: label, active: active }) })
  var raw = await response.text(), payload
  try { payload = JSON.parse(raw) } catch (error) { throw new Error('观察标注接口返回非 JSON 响应。') }
  if (!response.ok || !payload || payload.ok !== true || !payload.result) throw new Error(payload && payload.error || '观察标注保存失败（HTTP ' + response.status + '）。')
  return payload.result
}
function absActivityTime(value) {
  if (!value) return '时间未记录'
  var date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, dateStyle: 'short', timeStyle: 'medium' }).format(date) + ' UTC+8' : String(value)
}
function absActivityAttribution(value) { return value === 'self_review' ? 'ABS 审查轮次' : value === 'mixed' ? '混合输入' : '归因未关联' }
function absActivityPercent(value) { return typeof value === 'number' && Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '未记录' }
function AbsActivityPanel(props) {
  var initial = { summary: null, episodes: [], window: null, loading: true, error: '' }
  var state = React.useState(initial), data = state[0], setData = state[1]
  var filterState = React.useState('all'), filter = filterState[0], setFilter = filterState[1]
  var cursorState = React.useState(null), cursor = cursorState[0], setCursor = cursorState[1]
  var refreshState = React.useState(0), refresh = refreshState[0], setRefresh = refreshState[1]
  var pendingState = React.useState({}), pending = pendingState[0], setPending = pendingState[1]
  var noticeState = React.useState(''), notice = noticeState[0], setNotice = noticeState[1]
  var windowState = React.useState(absActivityWindow()), windowRange = windowState[0], setWindowRange = windowState[1]
  var snapshotState = React.useState(null), snapshotAt = snapshotState[0], setSnapshotAt = snapshotState[1]
  var snapshotSeqState = React.useState(null), snapshotSeq = snapshotSeqState[0], setSnapshotSeq = snapshotSeqState[1]
  React.useEffect(function () {
    var disposed = false, controller = null, generation = 0
    function cancel() { generation++; if (controller) controller.abort(); controller = null }
    async function load() {
      if (disposed || document.hidden || controller) return
      var current = new AbortController(), token = ++generation; controller = current
      try { setData(function (previous) { return Object.assign({}, previous, { loading: true, error: '' }) }); var url = absActivityUrl(windowRange, cursor, cursor ? snapshotAt : null, cursor ? snapshotSeq : null, filter); var response = await fetch(url, { signal: current.signal, cache: 'no-store' }); var raw = await response.text(), result
        try { result = JSON.parse(raw) } catch (parseError) { throw new Error('内心活动接口返回非 JSON 响应。') }
        if (!response.ok || !result || result.ok !== true) throw new Error(result && result.error || '内心活动读取失败（HTTP ' + response.status + '）。')
        if (!result.summary || !Array.isArray(result.episodes) || !result.page || typeof result.page.snapshotAt !== 'string' || !Number.isSafeInteger(result.page.snapshotSeq) || (result.page.hasMore && (!result.page.nextCursor || typeof result.page.nextCursor.wakeAt !== 'string' || typeof result.page.nextCursor.episodeId !== 'string'))) throw new Error('内心活动接口响应格式无效。')
        if (!disposed && token === generation) { setSnapshotAt(result.page.snapshotAt); setSnapshotSeq(result.page.snapshotSeq); setData(function (previous) { return Object.assign({}, result, { episodes: cursor ? previous.episodes.concat(result.episodes) : result.episodes, loading: false, error: '' }) }) } }
      catch (error) { if (!disposed && token === generation && !current.signal.aborted) setData(function (previous) { return Object.assign({}, previous, { loading: false, error: error.message || '内心活动读取失败。' }) }) }
      finally { if (controller === current) controller = null }
    }
    function syncWindow() {
      var currentWindow = absActivityWindow()
      if (currentWindow.from !== windowRange.from) { setData(initial); setCursor(null); setSnapshotAt(null); setSnapshotSeq(null); setWindowRange(currentWindow); return true }
      return false
    }
    function visibility() { if (document.hidden) cancel(); else if (!syncWindow() && !cursor) load() }
    function tick() { if (!syncWindow() && !cursor) load() }
    load(); var timer = setInterval(tick, 15000); document.addEventListener('visibilitychange', visibility)
    return function () { disposed = true; cancel(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [refresh, windowRange.from, filter])
  async function toggle(activity, label) {
    if (!activity || !activity.id || pending[activity.id]) return
    var active = !(activity.annotations || []).some(function (item) { return item.label === label })
    setPending(function (previous) { return Object.assign({}, previous, { [activity.id]: true }) }); setNotice('')
    try {
      var result = await annotateAbsActivity(activity.id, label, active)
      if (result.activityId !== activity.id || result.label !== label || result.active !== active) throw new Error('标注响应与请求不一致，当前页面未更新。')
      setData(function (previous) { return Object.assign({}, previous, { episodes: previous.episodes.map(function (row) {
        if (row.id !== activity.id) return row
        var annotations = (row.annotations || []).filter(function (item) { return item.label !== label })
        if (active) annotations.push({ label: label, at: result.at })
        return Object.assign({}, row, { annotations: annotations })
      }) }) })
      setNotice('观察标注已保存。')
    } catch (error) { setNotice(error.message || '观察标注保存失败。') }
    finally { setPending(function (previous) { var next = Object.assign({}, previous); delete next[activity.id]; return next }) }
  }
  var count = data.summary || {}, episodes = data.episodes || []
  if (props.view === 'overview') {
    var recent = episodes[0], recentText = recent && recent.actionSelection ? '选择：' + absActionSelectionText(recent.actionSelection) : recent ? ((recent.result || recent.outcome) === 'no_action' ? '本轮已完成，未观察到工具行动' : recent.outcomeSummary || '唤醒后没有可展示的选择摘要') : data.loading ? '正在读取内心活动…' : data.error ? '暂时无法读取活动记录' : '暂无活动片段'
    var completeText = data.loading ? '正在读取今日记录' : data.error ? '更新失败 · 上次读取 ' + (count.opportunities || count.episodes || '—') + ' 个有效机会' : '今日 ' + (count.opportunities || count.episodes || 0) + ' 个有效机会 · ' + (count.noAction || 0) + ' 个未观察到行动 · ' + (count.unknown || 0) + ' 个结果未知'
    return h('a', { className: 'abs-observation-entry', href: props.href, onClick: props.onNavigate, 'aria-label': '查看内心活动详情' },
      h('div', { className: 'abs-entry-heading' }, h('h2', null, '内心活动'), h('span', { 'aria-hidden': 'true' }, '↗')),
      h('p', { className: 'abs-muted' }, '观察每次唤醒后的选择、实际尝试和结果。'),
      h('div', { className: 'abs-entry-sample' }, recentText, h('small', null, recent ? '最近一条 · ' + absActivityTime(recent.wakeAt) + ' · ' + (ABS_ACTIVITY_OUTCOMES[recent.result || recent.outcome] || '未知') : '最近一条记录')),
      h('div', { className: 'abs-entry-foot' }, h('span', null, completeText), h('strong', null, '查看内心活动 →')))
  }
  var visible = episodes
  return h('section', { className: 'abs-activity-page', 'aria-label': '内心活动' },
    h('a', { className: 'abs-back-link', href: props.overviewHref, onClick: props.onNavigate }, '← 返回 ABS 实验台'),
    h('header', { className: 'abs-detail-title' }, h('h1', { id: 'cf-abs-page-title', tabIndex: -1 }, '内心活动'), h('p', null, '从一次唤醒到一次结果，留下可回看的观察。')),
    data.error ? h('div', { className: 'abs-panel abs-activity-error', role: 'alert' }, data.error, data.episodes.length ? h('p', null, '以下为上次读取的活动记录，可能不是最新数据。') : null, h('button', { type: 'button', onClick: function () { setRefresh(function (value) { return value + 1 }) } }, '重试')) : null,
    h('div', { className: 'abs-panel abs-activity-summary' },
      [['今日唤醒片段', count.totalWakes === undefined ? count.episodes : count.totalWakes], ['有效机会', count.opportunities === undefined ? count.episodes : count.opportunities], ['结果已验证', count.verified], ['未观察到行动', count.noAction], ['执行失败', count.failed], ['结果未知', count.unknown]].map(function (item) { return h('div', { key: item[0] }, h('span', null, item[0]), h('strong', null, data.loading ? '—' : item[1] || 0)) })),
    data.window ? h('div', { className: 'abs-activity-coverage' }, h('p', null, '观察窗口：' + absActivityTime(data.window.from) + ' 至 ' + absActivityTime(data.window.to) + ' · 已覆盖 ' + (Math.max(0, Number(data.window.coveredMs) || 0) / 3600000).toFixed(1) + ' 小时 · ' + (data.window.complete ? '记录窗口完整' : '存在 ' + ((data.window.gaps || []).length || 1) + ' 个观察缺口') + '。'), data.window.gaps && data.window.gaps.length ? h('details', null, h('summary', null, '查看观察缺口'), data.window.gaps.map(function (gap, index) { return h('p', { key: index }, absActivityTime(gap.from) + ' 至 ' + absActivityTime(gap.to)) })) : null, h('p', null, '失败 ' + (count.failed || 0) + ' · 未知 ' + (count.unknown || 0) + '。已加载 ' + data.episodes.length + ' / ' + data.page.total + ' 个唤醒片段；筛选覆盖当天全部记录，可加载更多查看较早匹配项。')) : null,
    h('div', { className: 'abs-activity-head' }, h('h2', null, '活动记录'), h('select', { value: filter, 'aria-label': '筛选内心活动', onChange: function (event) { setData(initial); setCursor(null); setSnapshotAt(null); setSnapshotSeq(null); setFilter(event.target.value) } },
      [['all', '全部结果'], ['verified', '已验证'], ['no_action', '未观察到行动'], ['failed', '失败'], ['unknown', '未知'], ['not_started', '未启动']].map(function (item) { return h('option', { key: item[0], value: item[0] }, item[1]) }))),
    data.loading ? h('p', { role: 'status', className: 'abs-muted' }, '正在读取活动记录…') : null,
    !data.loading && visible.length === 0 ? h('p', { role: 'status', className: 'abs-activity-empty' }, data.error ? '活动记录暂不可用。' : '当前筛选下没有活动记录。') : null,
    h('div', { className: 'abs-activity-list' }, visible.map(function (episode) {
        var outcome = episode.result || episode.outcome || 'unknown', annotations = episode.annotations || [], diagnostic = episode.turnDiagnostic
        var diagnosticText = diagnostic && typeof diagnostic === 'object' ? '失败阶段：' + (ABS_ACTIVITY_FAILURE_PHASES[diagnostic.phase] || '阶段未分类') + ' · 原因：' + (ABS_ACTIVITY_FAILURE_CODES[diagnostic.code] || '原因未分类') : outcome === 'failed' ? '这条较早记录没有保存失败诊断，失败阶段和原因未记录。' : null
        var selection = episode.actionSelection
        return h('article', { className: 'abs-activity-record', key: episode.id },
          h('div', { className: 'abs-activity-heading' }, h('h3', null, selection ? absActionSelectionText(selection) : episode.outcomeSummary || '唤醒后没有可确认的选择摘要'), h('span', { className: 'abs-status abs-status-' + outcome }, ABS_ACTIVITY_OUTCOMES[outcome] || '未知')),
          h('p', { className: 'abs-muted' }, absActivityTime(episode.wakeAt) + ' · ' + (episode.cause || '触发来源未记录') + ' · 归因：' + absActivityAttribution(episode.attribution) + ' · 轮次：' + (episode.turnStatus || 'unknown')),
          h('details', null, h('summary', null, '过程与证据'),
            h('ol', { className: 'abs-activity-trail' },
              h('li', null, h('strong', null, '唤醒与状态'), h('p', null, '审查状态：' + (episode.reviewStatus || '未记录') + ' · 运行模式：' + (episode.mode || '未记录') + ' · 社交满足度：' + absActivityPercent(episode.stateAtWake && episode.stateAtWake.socialSatisfaction) + ' · 好奇满足度：' + absActivityPercent(episode.stateAtWake && episode.stateAtWake.curiositySatisfaction))),
              selection ? h('li', null, h('strong', null, '策略选择与派发'), h('p', null, '选择：' + absActionSelectionText(selection)), h('p', null, '派发状态：' + (ABS_ACTION_DISPATCH[selection.dispatchStatus] || '状态未分类') + (selection.selectedAt ? ' · ' + absActivityTime(selection.selectedAt) : '')), selection.visibleAt ? h('p', null, '已在当前会话回复 · ' + absActivityTime(selection.visibleAt)) : null, selection.resolvedAt ? h('p', null, '派发状态已确认' + (selection.resolutionReason ? ' · ' + (ABS_ACTION_RESOLUTION_REASONS[selection.resolutionReason] || '已记录派发结算') : '') + ' · ' + absActivityTime(selection.resolvedAt)) : null, h('p', null, '候选评分：' + absActivityPercent(selection.score) + '（仅用于选择，不代表行动结果）')) : null,
              h('li', null, h('strong', null, '实际尝试 ', h('span', { className: 'abs-source-tag' }, '宿主观察')), episode.evidence && episode.evidence.length ? h('ul', null, episode.evidence.map(function (item, index) { return h('li', { key: item.id || index }, (item.kind || '活动') + ' · ' + (ABS_ACTIVITY_EVIDENCE[item.status] || item.status || '状态未记录') + ' · ' + absActivityTime(item.at) + ' · ' + absActivityAttribution(item.attribution) + ' · ' + [item.sessionId, item.turn && 'turn ' + item.turn, item.seq && 'seq ' + item.seq, item.callId].filter(Boolean).join(' · ')) })) : outcome === 'no_action' ? h('p', null, '没有关联的工具行动记录。') : diagnostic && diagnostic.phase === 'before_tools' ? h('p', null, '本轮在工具请求前失败；没有关联的工具请求或工具回执。') : h('p', null, '没有可关联的工具记录；缺少观察不能证明没有行动。')),
              h('li', null, h('strong', null, '结果与待续'), h('p', null, episode.outcomeSummary || '没有已验证结果摘要。'), diagnosticText ? h('p', { className: 'abs-activity-diagnostic' }, diagnosticText) : null)),
            h('details', null, h('summary', null, '查看关联证据引用'), h('div', { className: 'abs-evidence-ref' }, h('p', null, '片段 ' + episode.id), h('p', null, '审查 ' + (episode.reviewId || episode.reviewStatus || '未关联') + ' · 会话 ' + (episode.sessionId || '未关联') + ' · 轮次 ' + (episode.turn || '未关联')),
              episode.evidence && episode.evidence.length ? episode.evidence.map(function (item, index) { return h('p', { key: index }, [item.id, item.sessionId, item.turn && 'turn ' + item.turn, item.seq && 'seq ' + item.seq, item.callId].filter(Boolean).join(' · ')) }) : h('p', null, '暂无工具回执引用。')))),
          h('div', { className: 'abs-annotations' }, h('span', null, '观察标注'), Object.keys(ABS_ACTIVITY_LABELS).map(function (label) { var pressed = annotations.some(function (item) { return item.label === label }); return h('button', { key: label, type: 'button', 'aria-pressed': pressed, disabled: Boolean(pending[episode.id]), onClick: function () { toggle(episode, label) } }, ABS_ACTIVITY_LABELS[label]) }),
            pending[episode.id] ? h('span', { role: 'status' }, '正在保存…') : null, notice ? h('span', { role: 'status' }, notice) : null))
      })),
    data.page && data.page.hasMore ? h('div', { className: 'abs-activity-pagination' }, h('span', null, '已加载 ' + data.episodes.length + ' / ' + data.page.total + ' 个片段'), h('button', { type: 'button', disabled: data.loading, onClick: function () { setCursor(data.page.nextCursor); setRefresh(function (value) { return value + 1 }) } }, '加载更多')) : null
  )
}
