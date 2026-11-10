// Browser source embedded by build.mjs; React/h/RESOURCES belong to the plugin module.
async function requestAbsLab(body, signal) {
  var bootstrap = window.__CHONKYFISH_STATE__ || {}
  var endpoint = (bootstrap.routes || {}).abs || RESOURCES.routes.abs
  if (!endpoint) throw new Error('ABS 接口地址缺失，请更新插件并刷新页面。')
  var response = await fetch(endpoint, {
    method: body ? 'POST' : 'GET', signal: signal, cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  var raw = await response.text()
  var status = 'HTTP ' + response.status
  if (response.status === 404) throw new Error('ABS 后端接口未注册（' + status + '）。请更新或重载 Host 插件／重启 DSH，然后刷新页面；仅更新前端不会加载后端。')
  if (!raw.trim()) throw new Error('ABS 接口返回空响应（' + status + '），请检查 Host 插件状态。')
  var payload
  try { payload = JSON.parse(raw) }
  catch (error) { throw new Error('ABS 接口返回非 JSON 响应（' + status + '），请检查 Host 插件及请求地址。') }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ABS 接口响应格式无效（' + status + '）。')
  if (!response.ok || payload.ok !== true) throw new Error(String(payload.error || 'ABS 请求失败') + '（' + status + '）' + (payload.reason ? '：' + payload.reason : ''))
  return payload
}
// Presentation only: persisted timestamps and exported audit data remain UTC.
var ABS_TIME_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
function formatAbsTime(value) {
  if (value === null || value === undefined || value === '') return '—'
  var date = new Date(value)
  if (!Number.isFinite(date.getTime())) return String(value)
  var parts = {}
  ABS_TIME_FORMAT.formatToParts(date).forEach(function (part) { parts[part.type] = part.value })
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second + ' UTC+8'
}
function stringifyAbsDisplay(value) {
  return JSON.stringify(value, function (key, item) {
    return typeof item === 'string' && /(?:At|Time)$|^(?:at|time)$/.test(key) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item) ? formatAbsTime(item) : item
  }, 2)
}
var ABS_LAB_SURFACE = `
.cf-abs-lab{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.65 var(--dsw-font-family,system-ui);font-variant-numeric:tabular-nums}
.cf-abs-lab *{box-sizing:border-box}.cf-abs-lab .abs-shell{max-width:1260px;margin:auto;padding:36px 40px 48px}.cf-abs-lab h1{font-size:28px;margin:0}.cf-abs-lab h2{font-size:17px;margin:0}.cf-abs-lab h3{font-size:14px;font-weight:500;margin:0}.cf-abs-lab p{margin:8px 0}.cf-abs-lab .abs-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.cf-abs-lab .abs-header{margin-bottom:28px}.cf-abs-lab .abs-states{display:grid;grid-template-columns:.85fr 1.4fr;gap:20px}.cf-abs-lab .abs-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:24px 26px;min-width:0}.cf-abs-lab .abs-panel-heading,.cf-abs-lab .abs-panel-footer{display:flex;justify-content:space-between;align-items:center;gap:12px}.cf-abs-lab .abs-panel-footer{border-top:1px solid var(--dsw-alias-border-l1);padding-top:18px;color:var(--dsw-alias-label-secondary);font-size:12px;flex-wrap:wrap}.cf-abs-lab .abs-owner-body{min-height:178px;display:flex;justify-content:center;flex-direction:column}.cf-abs-lab .activity{font-size:40px;font-weight:600;line-height:1.3}.cf-abs-lab .abs-drives{display:grid;grid-template-columns:1fr 1fr;gap:28px;padding:28px 0}.cf-abs-lab .abs-drive+.abs-drive{border-left:1px solid var(--dsw-alias-border-l1);padding-left:28px}.cf-abs-lab .abs-value{font-size:36px;line-height:1.4;margin:8px 0}.cf-abs-lab meter{width:100%;height:10px;accent-color:var(--dsw-alias-brand-primary)}.cf-abs-lab meter::-webkit-meter-bar{background:var(--dsw-alias-bg-layer-2);border:0;border-radius:2px}.cf-abs-lab meter::-webkit-meter-optimum-value{background:var(--dsw-alias-brand-primary)}.cf-abs-lab meter::-moz-meter-bar{background:var(--dsw-alias-brand-primary)}.cf-abs-lab button,.cf-abs-lab input,.cf-abs-lab select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 12px;max-width:100%}.cf-abs-lab button{cursor:pointer;white-space:nowrap}.cf-abs-lab button:disabled{opacity:.5;cursor:default}.cf-abs-lab :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.cf-abs-lab .abs-actions{display:flex;gap:8px}.cf-abs-lab .abs-actions button{font-size:12px;padding:5px 10px}.cf-abs-lab .abs-settings{margin-top:24px;padding:0}.cf-abs-lab .abs-settings>summary{cursor:pointer;padding:20px 26px;font-weight:600}.cf-abs-lab .abs-settings-summary{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:20px}.cf-abs-lab .abs-time-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px;padding:0 26px 20px;border-top:1px solid var(--dsw-alias-border-l1)}.cf-abs-lab .abs-error{padding:12px 16px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
@container(max-width:960px){.cf-abs-lab .abs-shell{padding:28px 24px}.cf-abs-lab .abs-states{grid-template-columns:1fr}.cf-abs-lab .abs-time-grid{grid-template-columns:1fr;gap:0}}@container(max-width:600px){.cf-abs-lab .abs-shell{padding:20px 16px}.cf-abs-lab .abs-panel{padding:20px}.cf-abs-lab .abs-settings{padding:0}.cf-abs-lab .abs-settings-summary{display:block;margin:8px 0 0}.cf-abs-lab .abs-value{font-size:28px}.cf-abs-lab .abs-drives{gap:16px}.cf-abs-lab .abs-drive+.abs-drive{padding-left:16px}.cf-abs-lab .activity{font-size:32px}}
`
var ABS_AUDIT_WORDS = {
  off: '已关闭', shadow: '观察模式', active: '投递模式',
  timer: '定时审查', manual: '手动审查', transition: '模式切换',
  DUE: '到期', SHADOW_PREVIEW_ONLY: '观察模式只预览，不投递', ABS_OFF: 'ABS 已关闭',
  ACTIVATION_COOLDOWN: '仍在启用冷却期', NOT_DUE: '尚未到达审查时间', TIME_PAUSED: '状态自然变化已暂停',
  DELIVERED: '已提交给大肥鱼', REST_HOURS: '处于每日休息时段，不唤醒',
  'no-panel-session': '面板尚未绑定会话', 'session-not-live': '目标会话当前未运行',
  'agent-busy': '大肥鱼正在处理其他输入', 'host-closed': 'ABS 已停止',
  'empty-review': '状态审查文本为空', 'followup-failed': '无法提交到会话',
  'persistence-unacknowledged': '尚未确认已持久化', 'session-binding-mismatch': '会话身份不匹配',
  'resolve-failed': '无法取得会话', 'session-controller-unavailable': '宿主会话接口不可用',
  'search-capability-unavailable': '搜索能力当前不可用',
  owner_message: '主人消息', exploration: '探索', explore_content_found: '取得可用资料',
  explore_no_usable_content: '没有可用内容', failed: '执行失败',
  social: '社交满足度', curiosity: '好奇满足度', proposal: '动机提案', decision: '行动决策', 'execution-turn': '执行轮次',
}
function absAuditWord(value) { return Object.prototype.hasOwnProperty.call(ABS_AUDIT_WORDS, value) ? ABS_AUDIT_WORDS[value] : String(value == null ? '未记录' : value) }
function describeAbsAudit(record) {
  var row = record || {}, facts = [], title = '系统记录', summary = '此类型尚无中文解读，可展开查看原始记录。'
  var acceptance = row.acceptance || {}, outcome = row.outcome || {}
  var number = function (value) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '未记录' }
  switch (row.type) {
    case 'WakeRecord':
      title = '开始一次状态审查'
      summary = absAuditWord(row.cause) + '，当前为' + absAuditWord(row.mode) + '；本次判断：' + absAuditWord(row.gate) + '。'
      if (row.nextWakeRealAt) facts.push(['下次审查', formatAbsTime(row.nextWakeRealAt)])
      break
    case 'ReviewDelivered':
      title = '状态审查已提交给大肥鱼'
      summary = '审查已作为内部状态记录送入主人会话，由大肥鱼自己决定是否行动。请求被接纳不等于它已经行动，也不等于主人已经看到或回复。'
      if (row.reviewId) facts.push(['审查 ID', row.reviewId])
      if (acceptance.reason) facts.push(['说明', absAuditWord(acceptance.reason)])
      break
    case 'ReviewFailed':
      title = '状态审查未提交成功'
      summary = acceptance.reason ? absAuditWord(acceptance.reason) : '本次没有取得明确的投递接纳。'
      break
    case 'ReviewSkipped':
      title = '本次状态审查没有投递'
      summary = absAuditWord(row.reason) + '；没有产生新的模型轮次。'
      break
    case 'Observation':
      title = row.observation && row.observation.kind === 'owner_message' ? '观察到真实的主人消息' : '观察到真实的探索结果'
      summary = row.observation && row.observation.kind === 'owner_message'
        ? '记录到主人在会话中的真实发言，据此更新社交满足度。'
        : '记录到一次严格关联的工具结果：' + ((row.observation && ABS_CHANGE_REASONS[row.observation.result]) || absAuditWord(row.observation && row.observation.result)) + '。'
      if (row.observation) facts.push(['来源', (row.observation.sessionId || '未记录') + ' #' + row.observation.seq])
      break
    case 'FeedbackApplied':
      title = '已根据客观事件更新满足度'
      summary = '来源：' + absAuditWord(row.source) + '。满足度由 ABS 按真实事件计算，不采信模型自述。'
      facts.push([absAuditWord(row.driveId), (row.delta > 0 ? '+' : '') + number(row.delta)])
      break
    case 'ModeChanged':
      title = '运行模式已切换'
      summary = absAuditWord(row.previous) + ' → ' + absAuditWord(row.mode)
      if (row.activationAllowedRealAt) facts.push(['启用冷却至', formatAbsTime(row.activationAllowedRealAt)])
      break
    case 'ClockScaleChanged':
      title = '状态变化倍率已调整'
      summary = row.previous + '× → ' + row.timeScale + '×。只调整状态变化与审查频率，不重置已累计的变化，不代表已经审查或行动。'
      facts.push(['生效时间', formatAbsTime(row.realAt)])
      break
    case 'StateMigrated':
      title = '旧版状态已归档'
      summary = '旧版动机与执行记录已归档，不再参与运行；需求数值与时钟保留。'
      if (row.archived) facts.push(['归档数量', '动机 ' + row.archived.motivations + ' · 执行 ' + row.archived.executions])
      break
    case 'Recovery':
      title = 'ABS 状态已恢复'
      summary = '重启后从保存的状态继续；不会补发错过的审查。'
      break
    case 'ModelBudgetReserved':
      title = '预留模型预算（历史策略）'
      summary = '当前版本已取消此限制。'
      break
    case 'ModelLaunchRecorded':
      title = '准备发起模型调用'
      summary = '用途：' + absAuditWord(row.purpose) + '。仅记录尝试，不代表调用成功。'
      break
    default:
      facts.push(['记录类型', row.type || '未记录'])
  }
  return { title: title, summary: summary, facts: facts, time: formatAbsTime(row.realAt) }
}
function AbsAuditTimeline(props) {
  var rows = Array.isArray(props.records) ? props.records.slice(-30).reverse() : []
  if (!rows.length) return h('p', null, '还没有审计记录。发生审查、投递或观察到真实事件后，会在这里说明。')
  return h('ol', { style: { listStyle: 'none', padding: 0, margin: 0 } }, rows.map(function (row, index) {
    var view = describeAbsAudit(row)
    return h('li', { key: index, style: { padding: '18px 0 18px 18px', borderLeft: '2px solid var(--dsw-alias-border-l2,#9aa8b555)', borderBottom: '1px solid var(--dsw-alias-border-l2,#9aa8b533)', overflowWrap: 'anywhere' } },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px 20px', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('strong', { style: { fontSize: 15, fontWeight: 600 } }, view.title),
        h('span', { style: { fontSize: 12, opacity: .7 } }, view.time)),
      h('p', { style: { margin: '8px 0', lineHeight: 1.7 } }, view.summary),
      view.facts.length ? h('dl', { style: { margin: '8px 0', lineHeight: 1.7 } }, view.facts.map(function (fact, i) {
        return h('div', { key: i, style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px' } }, h('dt', { style: { opacity: .7 } }, fact[0]), h('dd', { style: { margin: 0 } }, fact[1]))
      })) : null,
      h('details', { style: { marginTop: 10, fontSize: 12 } }, h('summary', { style: { cursor: 'pointer', opacity: .75 } }, '技术详情 · 原始记录'),
        h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' } }, JSON.stringify(row, null, 2))))
  }))
}
function describeAbsNeeds(state) {
  var data = state || {}, drives = data.drives || {}
  var valid = function (value) { return typeof value === 'number' && Number.isFinite(value) }
  return ['social', 'curiosity'].map(function (id) {
    var drive = drives[id] || {}
    var available = valid(drive.satisfaction) && drive.satisfaction >= 0 && drive.satisfaction <= 1 && valid(drive.setpoint) && drive.setpoint > 0 && drive.setpoint <= 1
    var demand = available ? Math.max(0, Math.min(1, (drive.setpoint - drive.satisfaction) / drive.setpoint)) : null
    return {
      id: id, title: id === 'social' ? '社交满足程度' : '探索满足程度', available: available, demand: demand,
      satisfaction: available ? drive.satisfaction : null, setpoint: available ? drive.setpoint : null,
      level: !available ? '暂无有效数据' : demand === 0 ? '处于平常的满足水平' : demand < .35 ? '缺口较小' : demand < .7 ? '缺口中等' : '缺口较大',
      decay: valid(drive.decayPerHour) && drive.decayPerHour >= 0 ? drive.decayPerHour : null,
      lastFeedbackAt: drive.lastFeedbackRealAt,
    }
  })
}
function AbsNeedsPanel(props) {
  var state = props.state || {}, rows = describeAbsNeeds(state)
  var percent = function(value) { return value === null ? '暂无数据' : (value*100).toFixed(1)+'%' }
  return h('section',{className:'abs-panel','aria-label':'大肥鱼状态'},
    h('div',{className:'abs-panel-heading'},h('h2',null,'大肥鱼状态'),h('span',{className:'abs-muted'},props.stale?'非实时状态':'内部满足度')),
    h('div',{className:'abs-drives'},rows.map(function(row){return h('article',{key:row.id,className:'abs-drive'},
      h('h3',null,row.id==='social'?'社交满足度':'探索满足度'),h('div',{className:'abs-value'},percent(row.satisfaction)),
      row.available?h('meter',{min:0,max:1,value:row.satisfaction,'aria-label':row.title},percent(row.satisfaction)):null,
      h('p',{className:'abs-muted'},'需求缺口 '+percent(row.demand)+' · '+row.level))})),
    h('div',{className:'abs-panel-footer'},h('span',null,'内部数值不代表真实情绪，也不构成行动命令。'),h('span',null,state.mode?absAuditWord(state.mode):'模式未知')))
}
function parseAbsTimeScale(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  var scale = Number(value)
  return Number.isFinite(scale) && scale >= 0 && scale <= 120 ? scale : null
}
function formatAbsRealWait(clock) {
  if (!clock) return '时钟数据尚不可用'
  if (clock.paused || clock.timeScale === 0) return '状态自然变化已暂停；恢复倍率后再估算'
  if (typeof clock.realWaitMs !== 'number' || !Number.isFinite(clock.realWaitMs) || clock.realWaitMs < 0) return '尚未安排'
  var seconds = Math.ceil(clock.realWaitMs / 1000)
  return seconds === 0 ? '已到期，等待调度（不保证投递）' : seconds < 60 ? '约 ' + seconds + ' 秒' : '约 ' + (seconds / 60).toFixed(1) + ' 分钟'
}
function AbsClockPanel(props) {
  var state = props.state || {}, clock = state.clockView
  // Null follows the server-applied scale; a draft survives every polling update.
  var draftState = React.useState(null), draft = draftState[0], setDraft = draftState[1]
  var applied = clock && clock.timeScale
  var known = typeof applied === 'number' && Number.isFinite(applied) && applied >= 0 && applied <= 120
  var input = draft === null ? (known ? String(applied) : '') : draft
  var scale = parseAbsTimeScale(input)
  var pending = draft !== null && scale !== applied
  var paused = clock && (clock.paused || applied === 0)
  var configured = state.config && state.config.timeScale
  async function apply() {
    if (props.busy || !known || scale === null || scale === applied) return
    if (await props.onAction({ action: 'time-scale', timeScale: scale })) setDraft(null)
  }
  return h('section', { 'aria-label': '状态变化倍率', style: { margin: '24px 0', lineHeight: 1.7 } },
    h('h2', null, '时间与变化速度'),
    h('p', { role: 'status' }, known ? '当前已应用：' + applied + '× · ' + (paused ? '状态自然变化暂停' : '状态自然变化运行中') + (state.mode === 'off' ? ' · 运行模式已关闭（与时钟暂停不同）' : '') : '等待服务端时钟快照，暂不能调整倍率。'),
    h('p', null, '现实时间：' + formatAbsTime(clock && clock.realNow)),
    h('p', null, '预计现实等待：' + (state.mode === 'off' ? '运行模式已关闭，不安排审查' : formatAbsRealWait(clock))),
    h('p', null, '预计现实审查时间：' + (clock && clock.nextWakeRealAt ? formatAbsTime(clock.nextWakeRealAt) : '尚不可估算')),
    h('p', { style: { fontSize: 12, opacity: .75 } }, '以上为服务端采样快照，每 15 秒刷新；预计等待不是实时倒计时，也不保证投递。'),
    h('label', { htmlFor: 'cf-abs-time-scale', style: { display: 'block' } }, '状态变化倍率（0–120，支持小数）'),
    h('input', { id: 'cf-abs-time-scale', type: 'number', min: 0, max: 120, step: 'any', value: input, disabled: props.busy || !known, 'aria-describedby': 'cf-abs-scale-help', 'aria-invalid': scale === null, onChange: function (event) { setDraft(event.target.value) }, style: { padding: 8, width: 130, maxWidth: '100%', boxSizing: 'border-box', margin: '8px 8px 8px 0' } }),
    h('button', { type: 'button', disabled: props.busy || !known || scale === null || scale === applied, onClick: apply, style: { padding: '8px 12px' } }, '应用 Apply'),
    h('div', { 'aria-label': '倍率预设' }, [0, .5, 1, 10, 60, 120].map(function (value) {
      return h('button', { key: value, type: 'button', disabled: props.busy || !known, onClick: function () { setDraft(String(value)) }, style: { padding: '6px 10px', margin: '0 8px 8px 0' } }, value === 0 ? '0× 暂停' : value + '×')
    })),
    h('p', { id: 'cf-abs-scale-help', role: 'status' }, scale === null ? '请输入 0 到 120 之间的有限数值。' : pending ? '输入尚未应用；仍按 ' + applied + '× 运行。点击 Apply 后才生效。' : '预设只填写输入框，必须点击 Apply；调整倍率不会自动审查或投递。'),
    known && configured !== undefined && configured !== applied ? h('p', null, '配置倍率 ' + configured + '× 尚未应用到时钟；实际仍为 ' + applied + '×。') : null,
    h('p', null, '这不是独立沙箱：仍使用真实全权限会话，工具和网络效果不会隔离。切回 1× 不会重置已累计的状态变化。'),
    h('p', null, '0× 暂停状态自然变化并阻止新的审查投递，不会取消已在途的外部工具或暂停正在运行的模型；真实观察仍可记入反馈。'))
}
function AbsRestPanel(props) {
  var state = props.state || {}, rest = state.clockView && state.clockView.rest
  var draftState = React.useState(null), draft = draftState[0], setDraft = draftState[1]
  var value = draft || rest || { enabled: true, start: '23:00', end: '08:00' }
  var valid = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.start) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.end) && value.start !== value.end
  function change(key, next) { var copy = { enabled: value.enabled, start: value.start, end: value.end }; copy[key] = next; setDraft(copy) }
  async function apply() {
    if (!rest || !valid || props.busy) return
    if (await props.onAction({ action: 'rest-hours', enabled: value.enabled, start: value.start, end: value.end })) setDraft(null)
  }
  return h('section', { 'aria-label': '每日休息时段', style: { margin: '24px 0', lineHeight: 1.8 } },
    h('h2', null, '每日休息时段'),
    h('p', { role: 'status' }, !rest ? '等待休息配置。' : !rest.enabled ? '每日休息已关闭。' : '每天 ' + rest.start + '–' + rest.end + '（UTC+8） · ' + (rest.resting ? '正在休息，恢复时间：' + formatAbsTime(rest.resumeAt) : '当前不在休息时段')),
    h('label', null, h('input', { type: 'checkbox', checked: value.enabled, disabled: props.busy || !rest, onChange: function (event) { change('enabled', event.target.checked) } }), '启用每日休息'),
    h('div', null,
      h('label', null, '开始 ', h('input', { type: 'time', value: value.start, disabled: props.busy || !rest, onChange: function (event) { change('start', event.target.value) } })),
      h('label', { style: { marginLeft: 16 } }, '结束 ', h('input', { type: 'time', value: value.end, disabled: props.busy || !rest, onChange: function (event) { change('end', event.target.value) } })),
      h('button', { type: 'button', disabled: props.busy || !rest || !draft || !valid, onClick: apply, style: { marginLeft: 16, padding: '6px 12px' } }, '应用休息时段')),
    !valid ? h('p', { role: 'alert' }, '请输入有效时间，开始和结束不能相同。') : draft ? h('p', null, '修改尚未应用。') : null,
    h('p', null, '按现实时间执行，不受倍率影响。休息时不由 ABS 唤醒，手动投递也不绕过；结束后只恢复正常调度，不补发夜间积压。'),
    h('p', { style: { fontSize: 12, opacity: .75 } }, '不会中断正在进行的任务，也不阻止主人聊天。满足度自然衰减与真实事件反馈保持原规则；此设置只约束 ABS，不控制其他定时任务。'))
}
function AbsReviewPanel(props) {
  var state = props.state || {}, last = state.lastReview
  var statusText = !last ? '尚未投递过审查。'
    : last.status === 'delivered' ? '上次投递：已提交给大肥鱼（' + formatAbsTime(last.realAt) + '）。接纳不等于已经行动，也不等于主人已读。'
      : '上次投递未成功：' + absAuditWord(last.reason) + '（' + formatAbsTime(last.realAt) + '）。'
  return h('section', { 'aria-label': '自身精神状态审查', style: { margin: '24px 0' } },
    h('h2', null, '自身精神状态审查'),
    h('p', { style: { fontSize: 12, opacity: .75, lineHeight: 1.7 } }, '这是当前会交给大肥鱼的文本：只描述内部状态与真实观察，不包含任务、渠道或行动要求。'),
    h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8, padding: '16px 18px', margin: '12px 0', background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2,#f5faff) 70%, transparent)', border: '1px solid var(--dsw-alias-border-l2,#9aa8b555)', borderRadius: 12, fontFamily: 'inherit', fontSize: 14 } }, (typeof state.reviewPreview === 'string' ? state.reviewPreview : state.reviewPreview && state.reviewPreview.text) || '状态审查暂不可用。'),
    h('p', null, statusText),
    h('div', null,
      h('button', { type: 'button', disabled: props.busy, onClick: function () { props.onAction({ action: 'preview' }) }, style: { padding: '8px 12px', marginRight: 8 } }, '刷新预览'),
      h('button', { type: 'button', disabled: props.busy || !state.mode || state.mode === 'off' || (state.clockView && (state.clockView.paused || (state.clockView.rest && state.clockView.rest.resting))), onClick: function () { props.onAction({ action: 'wake' }) }, style: { padding: '8px 12px' } }, state.mode === 'active' ? '手动投递审查' : '手动运行一次审查')),
    h('p', { style: { fontSize: 12, opacity: .75 } }, '手动运行同样遵守模式、暂停与休息时段；观察模式下只记录，不投递。'))
}
function AbsEnvironmentPanel(props) {
  var environment = props.environment || {}, owner = environment.ownerSession || {}, search = environment.search || {}
  return h('section', { 'aria-label': '感知条件', style: { margin: '24px 0' } },
    h('h2', null, '感知条件'),
    h('p', null, '大肥鱼会话：' + (owner.available ? '已绑定且空闲' : '当前不可投递（' + absAuditWord(owner.reason) + '）')),
    h('p', null, '搜索能力：' + (search.available ? '可用' : '当前不可用（' + absAuditWord(search.reason) + '）')),
    h('p', { style: { fontSize: 12, opacity: .75 } }, '这些只描述当前环境是否允许感知与投递；ABS 不会替大肥鱼选择渠道，也不会主动调用工具。'))
}
function AbsObservationsPanel(props) {
  var state = props.state || {}, rows = Array.isArray(state.observations) ? state.observations.slice(-20).reverse() : []
  if (!rows.length) return h('section', { 'aria-label': '真实观察', style: { margin: '24px 0' } }, h('h2', null, '真实观察'), h('p', null, '还没有记录到可用于反馈的真实事件。'))
  return h('section', { 'aria-label': '真实观察', style: { margin: '24px 0' } },
    h('h2', null, '真实观察'),
    h('p', { style: { fontSize: 12, opacity: .75 } }, '只记录严格关联的客观事件；模型自述与普通回复不进入反馈。'),
    h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, rows.map(function (row, index) {
      var label = row.kind === 'owner_message' ? '主人真实发言' : (row.activity ? '本地活动（' + row.activity + '）：' : '搜索工具结果：') + (ABS_CHANGE_REASONS[row.resultKind] || absAuditWord(row.resultKind))
      return h('li', { key: index, style: { padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2,#9aa8b533)', display: 'flex', flexWrap: 'wrap', gap: '6px 16px', justifyContent: 'space-between' } },
        h('span', null, label), h('span', { style: { fontSize: 12, opacity: .7 } }, formatAbsTime(row.realAt)))
    })))
}
var ABS_CHANGE_REASONS = {
  natural_decay: '自然衰减', owner_message: '主人真实发言', explore_content_found: '搜索取得可用资料',
  local_content_found: '本地活动有可验证结果', unverified_activity: '没有可验证的收获证据，不加分',
  duplicate_evidence: '相同内容已计入，不重复加分', local_turn_limit: '本轮本地活动已计入，不逐工具累加',
  feedback_capacity: '去重记录已满，停止加分', failed: '工具失败，不加分', explore_no_usable_content: '搜索无可用内容，不加分',
}
function AbsChangeLedger(props) {
  var rows = (props.state && props.state.changeLedger || []).slice(-40).reverse()
  var percent = function (value) { return Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '—' }
  return h('section', { 'aria-label': '满足度变化账本', style: { margin: '24px 0' } },
    h('h2', null, '满足度变化账本'),
    h('p', null, '满足度增加会降低需求缺口；自然衰减会提高缺口。以下是结算时的变化，不是每秒采样。保留最近 200 条，展示最近 40 条；旧活动不补记或补分。'),
    rows.length ? h('ul', { style: { listStyle: 'none', padding: 0 } }, rows.map(function (row, index) {
      return h('li', { key: index, style: { padding: '12px 0', borderBottom: '1px solid var(--dsw-alias-border-l2,#9aa8b533)', lineHeight: 1.8 } },
        h('div', null, formatAbsTime(row.realAt) + ' · ' + absAuditWord(row.driveId) + ' · ' + (ABS_CHANGE_REASONS[row.reason] || row.reason) + (row.activity ? '（' + row.activity + '）' : '')),
        h('div', null, percent(row.before) + ' → ' + percent(row.after) + '；' + (row.delta > 0 ? '+' : '') + (row.delta * 100).toFixed(2) + ' 个百分点' + (row.timeScale !== undefined ? ' · ' + row.timeScale + '×' : '')))
    })) : h('p', null, '暂无变化记录；新版启用后的变化会从这里开始记录。'))
}
function AbsLabPage() {
  var dataState = React.useState(null), data = dataState[0], setData = dataState[1]
  var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
  var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
  var mounted = React.useRef(false)
  var request = requestAbsLab
  async function refresh() {
    try { var value = await request(); if (mounted.current) { setData(value); setError('') } }
    catch (e) { if (mounted.current) setError(e.message) }
  }
  React.useEffect(function () {
    mounted.current = true
    refresh()
    var timer = setInterval(refresh, 15000)
    return function () { mounted.current = false; clearInterval(timer) }
  }, [])
  async function action(body) {
    setBusy(true); setError('')
    try {
      await request(body)
      if (!mounted.current) return
      await refresh()
      return true
    } catch (e) { if (mounted.current) setError(e.message); return false }
    finally { if (mounted.current) setBusy(false) }
  }
  var state = data && data.state
  var clock = state && state.clockView, rest = clock && clock.rest
  var timeSummary = clock ? '变化速度 '+clock.timeScale+'× · '+(rest && rest.enabled?'每日休息 '+rest.start+'–'+rest.end:rest?'每日休息关闭':'休息设置待加载')+' · UTC+8' : '等待时钟数据'
  return h('main', { className: 'cf-abs-lab cf-module' },h('style',null,ABS_LAB_SURFACE + MODULE_SURFACE),h('div',{className:'abs-shell module-shell'},
    h('header',{className:'abs-header module-head'},h('span',{className:'module-icon','aria-hidden':true},h(ICON_SENSE)),h('div',null,h('h1',null,'ABS 实验台'),h('p',{className:'module-sub'},'主人的当下，大肥鱼的内部状态。'))),
    error ? h('p',{role:'alert',className:'abs-error'},error) : null,
    h('div',{className:'abs-states'},h(AbsOwnerStatePanel),h(AbsNeedsPanel,{state:state,stale:Boolean(error)})),
    h('details',{className:'abs-panel abs-settings'},h('summary',null,'时间设置',h('span',{className:'abs-settings-summary'},timeSummary)),
      state?h('div',{className:'abs-time-grid'},h(AbsClockPanel,{state:state,busy:busy,onAction:action}),h(AbsRestPanel,{state:state,busy:busy,onAction:action})):h('p',null,'正在读取时间设置…')),
    h(AbsEventsPanel)))
}
