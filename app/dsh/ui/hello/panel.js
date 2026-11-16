// Embedded by build.mjs. Hello owns only onboarding UI; existing modules own configuration.
var HELLO_STEPS = ['welcome', 'persona', 'perception', 'rhythm', 'review']
var HELLO_CSS = '.cf-hello{height:100%;overflow:auto;background:var(--dsw-alias-bg-base,#f5faff);color:var(--dsw-alias-label-primary,#283d59);font:14px/1.75 system-ui;container-type:inline-size}.cf-hello *{box-sizing:border-box}.cf-hello .hello-shell{max-width:980px;padding:40px 44px;margin:auto}.cf-hello header,.cf-hello footer,.cf-hello .hello-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.cf-hello header{border-bottom:1px solid var(--dsw-alias-border-l1,#d8e7f6);padding-bottom:24px}.cf-hello h1{font-size:32px;line-height:1.3;margin:8px 0 16px;letter-spacing:-.8px}.cf-hello h2{font-size:24px;line-height:1.4;margin:0 0 14px}.cf-hello p{margin:10px 0}.cf-hello .hello-muted{color:var(--dsw-alias-label-secondary,#5b7794)}.cf-hello .hello-card{padding:32px;border:1px solid var(--dsw-alias-border-l1,#d8e7f6);border-radius:18px;background:var(--dsw-alias-bg-layer-1,#fff);margin:24px 0;min-width:0}.cf-hello button{font:inherit;cursor:pointer;padding:10px 18px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#c2d5e8);color:inherit;background:var(--dsw-alias-bg-layer-1,#fff)}.cf-hello button.primary{color:var(--dsw-alias-brand-primary,#2679cf);border-color:currentColor}.cf-hello button:disabled{opacity:.45;cursor:default}.cf-hello :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2679cf);outline-offset:3px}.cf-hello input,.cf-hello textarea{display:block;width:100%;font:inherit;padding:11px 14px;border:1px solid var(--dsw-alias-border-l2,#c2d5e8);border-radius:9px;background:var(--dsw-alias-bg-base,#f5faff);color:inherit}.cf-hello textarea{min-height:240px;resize:vertical}.cf-hello label{display:block;margin:18px 0 8px}.cf-hello input[type=checkbox]{display:inline;width:auto;margin-right:10px}.cf-hello .hello-choice{display:block;text-align:left;width:100%;white-space:normal;margin:12px 0;padding:18px}.cf-hello .hello-choice[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#2679cf);background:var(--dsw-alias-bg-layer-2,#edf6ff)}.cf-hello .hello-choice strong{display:block}.cf-hello .hello-steps{display:flex;gap:10px;list-style:none;padding:20px 0 0;flex-wrap:wrap;font-size:12px}.cf-hello .hello-steps li{padding:5px 10px;border-radius:20px;background:var(--dsw-alias-bg-layer-2,#edf6ff)}.cf-hello .hello-steps [aria-current=step]{color:var(--dsw-alias-brand-primary,#2679cf);font-weight:700}.cf-hello .hello-notice{padding:14px 18px;border-left:3px solid var(--dsw-alias-brand-primary,#2679cf);background:var(--dsw-alias-bg-layer-2,#edf6ff);white-space:pre-wrap;overflow-wrap:anywhere;margin:16px 0}.cf-hello .hello-error{border-color:#c0525c}.cf-hello .hello-times{display:grid;grid-template-columns:1fr 1fr;gap:18px}.cf-hello pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:300px;overflow:auto}.cf-hello .hello-fish{width:88px;height:88px;object-fit:contain}.cf-hello footer{padding:12px 0 32px}@container(max-width:600px){.cf-hello .hello-shell{padding:22px 18px}.cf-hello .hello-card{padding:22px}.cf-hello h1{font-size:27px}.cf-hello .hello-times{grid-template-columns:1fr}}'
async function helloRequest(body, signal) {
  var endpoint = ((window.__CHONKYFISH_STATE__ || {}).routes || {}).hello || RESOURCES.routes.hello
  var response = await fetch(endpoint, { method: body ? 'POST' : 'GET', cache: 'no-store', signal: signal, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  var payload = await response.json()
  if (!response.ok || !payload || !payload.ok) throw new Error((payload && payload.error && payload.error.code) || 'HELLO_REQUEST_FAILED')
  return payload.data
}
function helloStepIndex(step) { return Math.max(0, HELLO_STEPS.indexOf(step)) }
function helloValidTime(value) { return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) }
function helloCanContinue(step, draft) {
  if (step === 'persona') return typeof draft.name === 'string' && !!draft.name.trim()
  if (step === 'perception') return typeof draft.perceptionRequested === 'boolean'
  if (step === 'rhythm') return !!draft.abs && Number.isFinite(draft.abs.timeScale) && draft.abs.timeScale >= 0 && draft.abs.timeScale <= 120 && (!draft.abs.restHours.enabled || (helloValidTime(draft.abs.restHours.start) && helloValidTime(draft.abs.restHours.end)))
  return true
}
function createHelloPage(t) {
  var Import = createMigrationSettings(t, { importOnly: true })
  return function HelloPage(props) {
    var dataPair = React.useState(null), data = dataPair[0], setData = dataPair[1]
    var draftPair = React.useState(null), draft = draftPair[0], setDraft = draftPair[1]
    var stepPair = React.useState('welcome'), step = stepPair[0], setStep = stepPair[1]
    var errorPair = React.useState(''), error = errorPair[0], setError = errorPair[1]
    var busyPair = React.useState(false), busy = busyPair[0], setBusy = busyPair[1]
    var viewPair = React.useState('hello'), view = viewPair[0], setView = viewPair[1]
    var lock = React.useRef(false), alive = React.useRef(true)
    function adopt(next) { if (!alive.current) return; setData(next); setDraft(JSON.parse(JSON.stringify(next.state.draft))); setStep(next.state.status === 'completed' ? 'done' : HELLO_STEPS.includes(next.state.step) ? next.state.step : 'welcome'); if (next.state.status === 'completed') props?.onComplete?.() }
    async function refresh() { try { adopt(await helloRequest()); if (alive.current) setError('') } catch (e) { if (alive.current) setError(e.message) } }
    React.useEffect(function () { alive.current = true; var ctrl = new AbortController(); helloRequest(null, ctrl.signal).then(adopt).catch(function(e) { if (alive.current && e.name !== 'AbortError') setError(e.message) }); return function () { alive.current = false; ctrl.abort() } }, [])
    async function work(fn) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await fn() } catch(e) { if (alive.current) setError(e.message) } finally { lock.current = false; if (alive.current) setBusy(false) } }
    function edit(patch) { setDraft(Object.assign({}, draft, patch)) }
    async function save(nextStep) { var patch = Object.assign({}, draft); if (data.current.panel.state.prompt) delete patch.prompt; var state = await helloRequest({ action: 'save-draft', expectedRevision: data.state.revision, patch: patch, step: nextStep }); if (alive.current) { setData(Object.assign({}, data, { state: state })); setStep(nextStep) } return state }
    function next() { work(async function () { await save(HELLO_STEPS[helloStepIndex(step) + 1] || 'review') }) }
    function finish() { work(async function () { var state = await save('review'); var id = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : 'hello-' + Date.now() + '-' + Math.random().toString(16).slice(2); await helloRequest({ action: 'apply-base', expectedRevision: state.revision, expectedSources: data.expectedSources, operationId: id }); await refresh() }) }
    if (view === 'import') return h(Import, { onBack: function() { setView('hello'); refresh() } })
    function button(label, onClick, primary, disabled) { return h('button', { type: 'button', onClick: onClick, className: primary ? 'primary' : '', disabled: busy || disabled }, label) }
    var titles = ['初次见面', '认识彼此', '感知选择', '相处节奏', '确认设置']
    var body = null, existingPrompt = data && data.current.panel.state.prompt
    if (draft && step === 'welcome') body = h('div', null, h('img', { className: 'hello-fish', src: RESOURCES.assets.avatar, alt: '' }), h('h1', null, '你好，我是大肥鱼。'), h('p', null, '花两分钟，让小鱼塘更适合你。'), h('p', { className: 'hello-muted' }, '先认识彼此，再选择感知和相处节奏。钉钉可以稍后接入。'), h('p', { className: 'hello-muted' }, '完成首次设置后，就可以进入小鱼塘。已有资料包？可以直接恢复之前的大肥鱼。'), button('导入已有资料', function() { setView('import') }))
    if (draft && step === 'persona') body = h('div', null, h('h2', null, '先认识彼此'), h('label', { htmlFor: 'hello-name' }, '你想怎样称呼她？'), h('input', { id: 'hello-name', value: draft.name, maxLength: 80, onChange: function(e) { edit({ name: e.target.value }) } }), h('label', { htmlFor: 'hello-prompt' }, existingPrompt ? '你已有的补充人格设定' : '新手人格预设 · 可查看与编辑'), h('p', { className: 'hello-muted' }, '沿用大肥鱼现有的人格机制：主预设保持不变，以下内容作为补充人格设定。不是性格标签，也不替换底层人格。'), h('textarea', { id: 'hello-prompt', value: existingPrompt || draft.prompt || '', readOnly: !!existingPrompt, onChange: function(e) { edit({ prompt: e.target.value }) } }), existingPrompt && h('div', { className: 'hello-notice' }, '已保留你的原有人格设置。Hello 不会覆盖它；需要修改时请前往「人格」页面。'))
    if (draft && step === 'perception') body = h('div', null, h('h2', null, '让她感知你的活动吗？'), h('p', null, '感知可以向大肥鱼提供活动上下文。开启需要系统和采集器支持；权限不足时会明确提示。'), h('p', { className: 'hello-muted' }, '这里保存的是采集意图，是否正在采集还取决于系统权限与运行状态。'), h('button', { className: 'hello-choice', 'aria-pressed': draft.perceptionRequested === true, disabled: busy || !data.current.perception.supported, onClick: function() { edit({ perceptionRequested: true }) } }, h('strong', null, '开启感知'), data.current.perception.supported ? '在确认设置后启用，可随时关闭。' : '当前设备暂不支持开启，请先保持关闭。'), h('button', { className: 'hello-choice', 'aria-pressed': draft.perceptionRequested === false, disabled: busy, onClick: function() { edit({ perceptionRequested: false }) } }, h('strong', null, '暂不开启'), '仍然可以聊天。若当前已在采集，确认后将停止。'), h('p', { className: 'hello-muted' }, '当前运行状态：' + data.current.perception.state))
    if (draft && step === 'rhythm') body = h('div', null, h('h2', null, '找到舒服的相处节奏'), h('label', { htmlFor: 'hello-speed' }, 'ABS 时间流速'), h('input', { id: 'hello-speed', type: 'number', min: '0', max: '120', step: 'any', value: draft.abs.timeScale, onChange: function(e) { edit({ abs: Object.assign({}, draft.abs, { timeScale: Number(e.target.value) }) }) } }), h('p', { className: 'hello-muted' }, '1× 接近真实时间，0× 暂停内在时间。流速影响内部时间，不代表她会固定频率打扰你。'), h('label', null, h('input', { type: 'checkbox', checked: draft.abs.restHours.enabled, onChange: function(e) { edit({ abs: Object.assign({}, draft.abs, { restHours: Object.assign({}, draft.abs.restHours, { enabled: e.target.checked }) }) }) } }), '设置防打扰时段'), h('div', { className: 'hello-times' }, ['start', 'end'].map(function(key) { return h('label', { key: key }, key === 'start' ? '开始时间' : '结束时间', h('input', { type: 'time', disabled: !draft.abs.restHours.enabled, value: draft.abs.restHours[key], onChange: function(e) { var rest = Object.assign({}, draft.abs.restHours); rest[key] = e.target.value; edit({ abs: Object.assign({}, draft.abs, { restHours: rest }) }) } })) })), h('p', { className: 'hello-muted' }, '按 ABS 的现实时间规则（UTC+8）判断，可跨午夜。这里只调整流速和防打扰，不更改 ABS 运行模式。'))
    if (draft && step === 'review') body = h('div', null, h('h2', null, '准备好一起生活了'), h('p', null, '称呼：' + draft.name), h('p', null, '人格：' + (existingPrompt ? '保留已有设置' : '使用当前补充人格预设')), h('p', null, '感知：' + (draft.perceptionRequested ? '开启' : '关闭')), h('p', null, 'ABS：' + draft.abs.timeScale + '× · ' + (draft.abs.restHours.enabled ? draft.abs.restHours.start + '–' + draft.abs.restHours.end + ' 防打扰' : '未设置防打扰')), h('p', { className: 'hello-muted' }, '确认后逐项保存。若部分成功，会保留结果并提示恢复，不覆盖你在其他页面的新修改。'))
    if (draft && step === 'done') body = h('div', null, h('h2', null, '小鱼塘准备好了'), button('进入小鱼塘', function() { props?.onComplete?.() }, true))
    var partial = data && ['partial', 'applying'].includes(data.state.status)
    var pendingOperation = data && Object.values(data.state.operations || {}).filter(function(op) { return op.status === 'partial' || op.status === 'applying' }).slice(-1)[0]
    var operationDetails = pendingOperation && Object.entries(pendingOperation.steps || {}).map(function(pair) { return ({panel:'名称与人格',abs:'ABS 设置',perception:'感知'}[pair[0]] || pair[0]) + '：' + ({pending:'等待保存',applied:'已保存',applying:'正在处理',failed:'未完成',unknown:'结果待核对'}[pair[1].status] || pair[1].status) + (pair[1].error ? '（' + pair[1].error + '）' : '') }).join('\n')
    return h('section', { className: 'cf-hello', 'aria-busy': busy }, h('style', null, HELLO_CSS), h('div', { className: 'hello-shell' }, h('header', null, h('div', null, h('strong', null, '大肥鱼 / HELLO'), h('div', { className: 'hello-muted' }, '把初次见面，变成舒服的开始。'))), step !== 'done' && h('ol', { className: 'hello-steps' }, titles.map(function(title, i) { return h('li', { key: title, 'aria-current': helloStepIndex(step) === i ? 'step' : undefined }, (i + 1) + ' · ' + title) })), error && h('div', { role: 'alert', className: 'hello-notice hello-error' }, '操作未完成：' + error + '。已保存的设置不会自动回滚。', ' ', button('重新读取', refresh)), !data && h('p', { role: 'status' }, error ? '请重新读取首次设置后继续。' : '正在读取你的设置…'), partial && h('div', { className: 'hello-notice', role: 'status' }, '上一次提交尚未全部完成。请先检查并恢复，避免重复执行。\n' + (operationDetails || ''), ' ', button('检查并恢复', function() { work(async function() { await helloRequest({ action: 'resume', operationId: (data.state.lastOperationId || Object.values(data.state.operations || {}).filter(function(op) { return op.status === 'partial' || op.status === 'applying' }).slice(-1)[0]?.id) }); await refresh() }) }), ' ', button('保留已保存结果，重新审阅', function() { work(async function() { await helloRequest({ action: 'abandon', operationId: (data.state.lastOperationId || Object.values(data.state.operations || {}).filter(function(op) { return op.status === 'partial' || op.status === 'applying' }).slice(-1)[0]?.id), expectedRevision: data.state.revision }); await refresh() }) })), h('fieldset', { className: 'hello-card', disabled: busy, style: { minWidth: 0 } }, body), draft && step !== 'done' && h('footer', null, button('上一步', function() { setStep(HELLO_STEPS[Math.max(0, helloStepIndex(step) - 1)]) }, false, step === 'welcome'), h('span', { className: 'hello-muted', role: 'status' }, busy ? '正在保存，请稍候…' : '下一步会保存草稿，不会启动采集。'), step === 'review' ? button('确认并保存', finish, true, partial) : button(step === 'welcome' ? '开始认识彼此' : '保存并继续', next, true, partial || !helloCanContinue(step, draft)))))
  }
}
// Wrap every fish destination, so direct opens and sidebar navigation use the
// same authoritative state. Never mount business pages while state is unknown.
function createHelloGate(Page, t) {
  var Hello = createHelloPage(t)
  return function HelloGate() {
    var pair = React.useState('loading'), mode = pair[0], setMode = pair[1]
    var errorPair = React.useState(''), error = errorPair[0], setError = errorPair[1]
    var refreshRef = React.useRef(null)
    React.useEffect(function() {
      var active = true, controller = null, sequence = 0, ready = false
      function refresh() {
        if (!active || ready) return
        controller?.abort(); controller = new AbortController()
        var request = ++sequence
        setMode('loading'); setError('')
        helloRequest(null, controller.signal).then(function(data) {
          if (!active || request !== sequence) return
          if (!data?.state || !['new', 'existing'].includes(data.state.entryKind) || !['draft', 'applying', 'partial', 'completed'].includes(data.state.status)) throw new Error('HELLO_INVALID_RESPONSE')
          ready = data.state.entryKind === 'existing' || data.state.status === 'completed'
          setMode(ready ? 'ready' : 'hello')
        }).catch(function(error) {
          if (active && request === sequence && error.name !== 'AbortError') { setError(error.message); setMode('error') }
        })
      }
      refreshRef.current = refresh
      window.addEventListener('chonkyfish:migration-complete', refresh)
      window.addEventListener('chonkyfish:hello-complete', refresh)
      refresh()
      return function() { active = false; controller?.abort(); refreshRef.current = null; window.removeEventListener('chonkyfish:migration-complete', refresh); window.removeEventListener('chonkyfish:hello-complete', refresh) }
    }, [])
    if (mode === 'hello') return h(Hello, { onComplete: function() { window.dispatchEvent(new CustomEvent('chonkyfish:hello-complete')) } })
    if (mode === 'ready') return h(Page)
    return h('div', { style: { padding: 28 }, role: mode === 'error' ? 'alert' : 'status' },
      mode === 'error' ? '首次状态读取失败：' + error : '正在读取首次状态…',
      mode === 'error' && h('button', { onClick: function() { refreshRef.current?.() } }, '重新读取'))
  }
}
