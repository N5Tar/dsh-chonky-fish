/**
 * Page controller for the 大肥鱼 chat UI panel.
 *
 * The page is the ported chat-UI design: a top bar, a chat pane with an
 * incremental transcript, and an illustration stage that reacts to the chat
 * state. The chat itself is backed by a real DSH Session through the bridge
 * passed in by the client module; when that bridge is unavailable the page
 * falls back to the local simulated replies.
 *
 * `mountChonkyFishPage(wrap, chat, options)` returns a disposer that clears
 * every timer and listener it installed. `options.view` selects the page:
 * `'chat'` (default) is the chat home; `wallet` / `settings` / `sense` /
 * `diary` / `social` mount the matching existing section as a full page.
 *
 * 本文件由 build.mjs 原样嵌入 client.js，因此可以引用构建时注入的模块级
 * `RESOURCES`（来自 src/resources/spec.js + src/assets.json）：存储 key、
 * 路由、preset、立绘素材名都从那里读，不要在页面控制器里硬编码。
 */
function mountChonkyFishPage(wrap, chat, options) {
  'use strict'

  // 一个侧栏入口对应一个 main 面板：`view: 'chat'` 是聊天主页，其余 view 把
  // 现有弹窗里的同一份内容搬成独立整页（DOM 与事件监听完全复用，只换容器）。
  var pageOptions = options || {}
  var pageView = typeof pageOptions.view === 'string' ? pageOptions.view : 'chat'

  var realChat = chat || null
  var realMode = false
  var realStatus = { phase: realChat ? 'idle' : 'disabled', error: null }
  var realUnsubscribe = null
  var lastChatSignature = ''
  var busy = false

  var stateBridge = null
  try {
    if (typeof window !== 'undefined' && window.__CHONKYFISH_STATE__ && typeof window.__CHONKYFISH_STATE__.token === 'string') {
      stateBridge = window.__CHONKYFISH_STATE__
    }
  } catch (error) {
    stateBridge = null
  }
  var fileSaveTimer = null

  // 存储 key 与素材目录都由资源管理模块在构建时注入（build.mjs ← src/resources/spec.js），
  // 这里不再硬编码，避免 Host / Client 两端各写一份。
  var STORAGE = RESOURCES.storageKeys
  var ROUTE_SPEC = RESOURCES.routes
  var KEY = STORAGE.panelState
  var ASSET_SPEC = RESOURCES.assets || {}
  var DEFAULT_PROMPT = RESOURCES.defaultPanelPrompt
  var GREETING = '哼哼！你终于来了！本鲸今天可是很认真地等你哦。\n\n……所以，今天有白饭吃吗？🍚'
  var POSES = (ASSET_SPEC.poses && typeof ASSET_SPEC.poses === 'object') ? ASSET_SPEC.poses : {}
  var PET_AVATAR_SRC = typeof ASSET_SPEC.avatar === 'string' ? ASSET_SPEC.avatar : ''

  function defaults() {
    return {
      name: '大肥鱼',
      prompt: DEFAULT_PROMPT,
      balance: 128,
      messages: [{ role: 'fish', text: GREETING, time: '10:24' }],
      ledger: [{ title: '今日零花钱', amount: 128, date: '初始贝壳', id: 1 }],
    }
  }

  function readStored() {
    try {
      return localStorage.getItem(KEY)
    } catch (error) {
      /* storage unavailable */
      return null
    }
  }

  var state
  try {
    var raw = JSON.parse(readStored())
    var base = defaults()
    state = raw && typeof raw === 'object' ? Object.assign(base, raw) : base
    if (!Array.isArray(state.messages) || !Array.isArray(state.ledger)) state = defaults()
  } catch (error) {
    state = defaults()
  }

  function $(id) {
    return wrap.querySelector('#' + id)
  }
  function $$(selector) {
    return wrap.querySelectorAll(selector)
  }
  function focusedNode() {
    try {
      var root = wrap.getRootNode ? wrap.getRootNode() : null
      if (root && root.activeElement) return root.activeElement
    } catch (error) {
      /* fall through */
    }
    return document.activeElement
  }
  function focusNode(node) {
    if (node && typeof node.focus === 'function') {
      try {
        node.focus()
      } catch (error) {
        /* best effort */
      }
    }
  }

  /* ------------------------------------------------------------- timers */

  var timers = new Set()
  function later(fn, ms) {
    var id = setTimeout(function () {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
    return id
  }
  function saveLocal() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch (error) {
      /* storage full or blocked */
    }
  }

  function scheduleFileSave(delay) {
    if (!stateBridge || typeof fetch !== 'function') return
    if (fileSaveTimer) {
      clearTimeout(fileSaveTimer)
      timers.delete(fileSaveTimer)
    }
    fileSaveTimer = later(function () {
      fileSaveTimer = null
      fetch(stateBridge.endpoint, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-chonkyfish-token': stateBridge.token,
        },
        body: JSON.stringify({ version: 1, savedAt: new Date().toISOString(), state: state }),
      }).catch(function () {
        /* the file may be unavailable; localStorage remains the cache */
      })
    }, delay === undefined ? 250 : delay)
  }

  function save() {
    saveLocal()
    scheduleFileSave()
  }

  function hydrateFromFile() {
    if (!stateBridge || typeof fetch !== 'function') return
    fetch(stateBridge.endpoint, {
      headers: { 'x-chonkyfish-token': stateBridge.token },
      cache: 'no-store',
    }).then(function (response) {
      return response.ok ? response.json() : null
    }).then(function (payload) {
      if (!payload || !payload.state || typeof payload.state !== 'object') {
        /* first run: persist the localStorage/default state into the file */
        scheduleFileSave(0)
        return
      }
      var merged = defaults()
      Object.keys(payload.state).forEach(function (key) {
        merged[key] = payload.state[key]
      })
      if (!Array.isArray(merged.messages) || !Array.isArray(merged.ledger)) {
        scheduleFileSave(0)
        return
      }
      state = merged
      saveLocal()
      updateTitle()
      setBalanceUI()
      renderPersona()
      renderWallet()
      renderChat(true)
    }).catch(function () {
      /* no token (page not refreshed yet) or route offline: localStorage only */
    })
  }

  var toastTimer = null
  function toast(message) {
    var el = $('toast')
    if (!el) return
    el.textContent = message
    el.classList.add('show')
    if (toastTimer) {
      clearTimeout(toastTimer)
      timers.delete(toastTimer)
    }
    toastTimer = later(function () {
      el.classList.remove('show')
    }, 2200)
  }

  /* ------------------------------------------------------------- confirm */

  var confirmEl = $('dfy-confirm')
  var confirmText = $('dfy-confirm-text')
  var confirmOk = $('dfy-confirm-ok')
  var confirmCancel = $('dfy-confirm-cancel')
  var confirmResolve = null
  var confirmReturnFocus = null

  function ask(message) {
    if (!confirmEl) return Promise.resolve(true)
    confirmReturnFocus = focusedNode()
    confirmText.textContent = message
    confirmEl.hidden = false
    return new Promise(function (resolve) {
      confirmResolve = function (value) {
        confirmEl.hidden = true
        confirmResolve = null
        focusNode(confirmReturnFocus)
        confirmReturnFocus = null
        resolve(value)
      }
      focusNode(confirmOk)
    })
  }
  function finishConfirm(value) {
    if (confirmResolve) confirmResolve(value)
  }
  function onConfirmKeydown(event) {
    if (!confirmResolve) return
    if (event.key === 'Escape') {
      event.preventDefault()
      finishConfirm(false)
      return
    }
    if (event.key !== 'Tab') return
    var nodes = confirmEl.querySelectorAll('button:not(:disabled)')
    var focusables = []
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].getClientRects().length) focusables.push(nodes[i])
    }
    if (!focusables.length) return
    var first = focusables[0]
    var last = focusables[focusables.length - 1]
    var active = focusedNode()
    var inside = focusables.indexOf(active) !== -1
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault()
      focusNode(last)
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault()
      focusNode(first)
    }
  }
  document.addEventListener('keydown', onConfirmKeydown)
  if (confirmOk) confirmOk.addEventListener('click', function () { finishConfirm(true) })
  if (confirmCancel) confirmCancel.addEventListener('click', function () { finishConfirm(false) })

  /* --------------------------------------------------------------- modal */

  var modal = $('modal')
  var modalTitle = $('modal-title')
  var walletPanel = $('wallet-panel')
  var settingsPanel = $('settings-panel')
  var sensePanel = $('sense-panel')
  var diaryPanel = $('diary-panel')
  var socialPanel = $('social-panel')
  var modalKind = null
  var modalReturnFocus = null

  function openModal(kind) {
    if (!modal) return
    modalKind = kind
    modalReturnFocus = focusedNode()
    if (modalTitle) {
      modalTitle.textContent = kind === 'settings'
        ? '人格设定'
        : kind === 'sense'
          ? '鱼鱼的感知'
          : kind === 'diary'
            ? '鱼鱼的日记'
            : kind === 'social'
              ? '鱼鱼的社交'
              : '鱼鱼的零花钱'
    }
    if (walletPanel) walletPanel.hidden = kind !== 'wallet'
    if (settingsPanel) settingsPanel.hidden = kind !== 'settings'
    if (sensePanel) sensePanel.hidden = kind !== 'sense'
    if (diaryPanel) diaryPanel.hidden = kind !== 'diary'
    if (socialPanel) socialPanel.hidden = kind !== 'social'
    modal.classList.add('open')
    if (kind === 'settings') renderPersona()
    if (kind === 'wallet') renderWallet()
    if (kind === 'sense') renderSense()
    if (kind === 'diary') renderDiary()
    if (kind === 'social') renderSocial()
    focusNode($('modal-x'))
  }
  function closeModal() {
    if (!modal || !modal.classList.contains('open')) return
    modal.classList.remove('open')
    modalKind = null
    focusNode(modalReturnFocus)
    modalReturnFocus = null
  }
  if (modal) {
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeModal()
    })
  }
  var modalX = $('modal-x')
  if (modalX) modalX.addEventListener('click', closeModal)
  var walletButton = $('wallet-button')
  if (walletButton) walletButton.addEventListener('click', function () { openModal('wallet') })
  var petWallet = $('pet-wallet')
  if (petWallet) petWallet.addEventListener('click', function () { openModal('wallet') })
  var settingsButton = $('settings-button')
  if (settingsButton) settingsButton.addEventListener('click', function () { openModal('settings') })
  var infoButton = $('info-button')
  if (infoButton) {
    infoButton.addEventListener('click', function () {
      toast(realChat ? '大肥鱼聊天界面 · 对话接入 DSH 会话（「大肥鱼」agent preset）' : '大肥鱼聊天界面 · 本地演示回复')
    })
  }
  function onModalKeydown(event) {
    if (event.key !== 'Escape') return
    if (confirmResolve) return
    closeModal()
  }
  document.addEventListener('keydown', onModalKeydown)

  /* --------------------------------------------------------- sense (模块0) */

  var senseList = $('sense-list')
  var senseCount = $('sense-count')
  var senseRefresh = $('sense-refresh')
  var senseButton = $('sense-button')
  var senseRequest = 0

  var SENSE_TYPE_LABELS = {
    'interaction.compliment_expressed': '夸奖',
    'interaction.invitation_expressed': '邀请',
    'interaction.thanks_expressed': '道谢',
    'preference.like_expressed': '说喜欢',
    'preference.dislike_expressed': '说不喜欢',
    'preference.content_feedback_expressed': '评价内容',
    'activity.activity_reported': '说做了什么',
    'environment.content_update_reported': '提到更新',
    'state.self_state_expressed': '说自己的状态',
    'goal.intention_expressed': '说想做',
    'goal.plan_expressed': '说计划',
    'goal.goal_cancelled': '取消目标'
  }

  function senseLabel(type) {
    return SENSE_TYPE_LABELS[type] || type
  }
  function senseEvidenceLabel(status) {
    if (status === 'reported') return '说是这样'
    if (status === 'intent') return '打算'
    if (status === 'hypothetical') return '假设'
    if (status === 'negated') return '否认'
    return '不确定'
  }
  function senseActorLabel(actorRef) {
    return actorRef === 'persona:dafeiyu' ? '鱼鱼' : '主人'
  }
  function senseClock(iso) {
    try {
      return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    } catch (error) {
      return ''
    }
  }

  function senseCard(event) {
    var card = document.createElement('div')
    card.className = 'cf-event'

    var head = document.createElement('div')
    head.className = 'cf-event-head'
    var type = document.createElement('span')
    type.className = 'cf-event-type'
    type.textContent = senseLabel(event.type)
    var tag = document.createElement('span')
    tag.className = 'cf-tag ' + (event.evidenceStatus || 'uncertain')
    tag.textContent = senseEvidenceLabel(event.evidenceStatus)
    head.appendChild(type)
    head.appendChild(tag)
    card.appendChild(head)

    if (event.quote) {
      var quote = document.createElement('p')
      quote.className = 'cf-event-quote'
      quote.textContent = '“' + event.quote + '”'
      card.appendChild(quote)
    }

    var meta = document.createElement('div')
    meta.className = 'cf-event-meta'
    var actor = document.createElement('span')
    actor.textContent = senseActorLabel(event.actorRef)
    var clock = document.createElement('span')
    clock.textContent = senseClock(event.observedAt)
    meta.appendChild(actor)
    meta.appendChild(clock)
    if (event.target) {
      var target = document.createElement('span')
      target.textContent = '对象：' + event.target
      meta.appendChild(target)
    }
    card.appendChild(meta)
    return card
  }

  function renderSenseEvents(payload) {
    if (!senseList) return
    while (senseList.firstChild) senseList.removeChild(senseList.firstChild)
    var events = payload && Array.isArray(payload.events) ? payload.events : []
    if (senseCount) {
      var total = payload && payload.stats && typeof payload.stats.events === 'number' ? payload.stats.events : events.length
      senseCount.textContent = String(total)
    }
    if (events.length === 0) {
      var empty = document.createElement('div')
      empty.className = 'cf-sense-empty'
      empty.textContent = '还没有感知到事件～先和鱼鱼聊两句吧'
      senseList.appendChild(empty)
      return
    }
    // 最新的排在最上面
    for (var index = events.length - 1; index >= 0; index -= 1) {
      senseList.appendChild(senseCard(events[index]))
    }
  }

  function renderSenseError(message) {
    if (!senseList) return
    while (senseList.firstChild) senseList.removeChild(senseList.firstChild)
    var box = document.createElement('div')
    box.className = 'cf-sense-error'
    box.textContent = message
    senseList.appendChild(box)
  }

  function renderSense() {
    if (!senseList) return
    if (!stateBridge || typeof fetch !== 'function') {
      renderSenseError('感知服务还没连上：刷新一下页面拿到新的令牌后再试。')
      return
    }
    var request = ++senseRequest
    if (!senseList.firstChild) {
      var loading = document.createElement('div')
      loading.className = 'cf-sense-empty'
      loading.textContent = '正在翻鱼鱼的记忆…'
      senseList.appendChild(loading)
    }
    var endpoint = (stateBridge.eventsEndpoint || ROUTE_SPEC.events) + '?limit=30'
    fetch(endpoint, {
      headers: { 'x-chonkyfish-token': stateBridge.token },
      cache: 'no-store'
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }).then(function (payload) {
      if (request !== senseRequest) return
      renderSenseEvents(payload)
    }).catch(function () {
      if (request !== senseRequest) return
      renderSenseError('读取感知事件失败：事件引擎可能还没启动（重启 DSH 或稍后再试）。')
    })
  }

  if (senseButton) senseButton.addEventListener('click', function () { openModal('sense') })
  if (senseRefresh) senseRefresh.addEventListener('click', function () { renderSense() })

  /* ------------------------------------------------------- diary (模块1) */

  var diaryDates = $('diary-dates')
  var diaryCount = $('diary-count')
  var diaryTitle = $('diary-title')
  var diaryBody = $('diary-body')
  var diaryRefresh = $('diary-refresh')
  var diaryButton = $('diary-button')
  var diaryRequest = 0
  var diarySelected = ''

  function diaryRoute() {
    var routes = stateBridge && stateBridge.routes ? stateBridge.routes : ROUTE_SPEC
    return routes && typeof routes.diary === 'string' ? routes.diary : ''
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild)
  }

  function diaryMessage(text, isError) {
    if (!diaryDates) return
    clearNode(diaryDates)
    var box = document.createElement('div')
    box.className = isError ? 'cf-sense-error' : 'cf-sense-empty'
    box.textContent = text
    diaryDates.appendChild(box)
  }

  function markDiarySelection() {
    if (!diaryDates) return
    var buttons = diaryDates.querySelectorAll('[data-diary-date]')
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle('active', buttons[i].dataset.diaryDate === diarySelected)
    }
  }

  function showDiaryDate(date) {
    if (diaryTitle) diaryTitle.textContent = date + ' 的日记'
  }

  function loadDiary(date) {
    var route = diaryRoute()
    if (!route || !stateBridge || typeof fetch !== 'function') {
      diaryMessage('日记服务还没连上：刷新一下页面拿到新的令牌后再试。', true)
      return
    }
    diarySelected = date
    markDiarySelection()
    showDiaryDate(date)
    if (diaryBody) diaryBody.textContent = '正在翻开这一页…'
    var request = ++diaryRequest
    fetch(route + '?date=' + encodeURIComponent(date), {
      headers: { 'x-chonkyfish-token': stateBridge.token },
      cache: 'no-store',
    }).then(function (response) {
      return response.json().catch(function () { return null }).then(function (payload) {
        return { ok: response.ok, payload: payload }
      })
    }).then(function (result) {
      if (request !== diaryRequest) return
      if (!result.ok || !result.payload || result.payload.ok !== true) {
        throw new Error('read-failed')
      }
      if (diaryBody) diaryBody.textContent = result.payload.content || '（这一页是空白的）'
    }).catch(function () {
      if (request !== diaryRequest) return
      if (diaryBody) diaryBody.textContent = '读取这篇日记失败，刷新再试。'
    })
  }

  function renderDiaryDates(payload) {
    var dates = payload && Array.isArray(payload.dates) ? payload.dates : []
    if (diaryCount) diaryCount.textContent = String(dates.length)
    if (!diaryDates) return
    clearNode(diaryDates)
    if (dates.length === 0) {
      if (diaryTitle) diaryTitle.textContent = '还没有日记'
      if (diaryBody) diaryBody.textContent = ''
      diaryMessage('还没有写过日记；让鱼鱼写一篇，或者让她用定时任务排一个每日提醒吧～', false)
      return
    }
    dates.forEach(function (date) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'cf-diary-date'
      button.dataset.diaryDate = date
      button.textContent = date
      button.addEventListener('click', function () { loadDiary(date) })
      diaryDates.appendChild(button)
    })
    if (diarySelected && dates.indexOf(diarySelected) === -1) diarySelected = ''
    loadDiary(diarySelected || dates[0])
  }

  function renderDiary() {
    var route = diaryRoute()
    if (!route || !stateBridge || typeof fetch !== 'function') {
      diaryMessage('日记服务还没连上：刷新一下页面拿到新的令牌后再试。', true)
      return
    }
    var request = ++diaryRequest
    if (diaryDates && !diaryDates.firstChild) {
      var loading = document.createElement('div')
      loading.className = 'cf-sense-empty'
      loading.textContent = '正在翻鱼鱼的日记本…'
      diaryDates.appendChild(loading)
    }
    fetch(route + '?limit=60', {
      headers: { 'x-chonkyfish-token': stateBridge.token },
      cache: 'no-store',
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }).then(function (payload) {
      if (request !== diaryRequest) return
      if (!payload || payload.ok !== true) throw new Error('list-failed')
      renderDiaryDates(payload)
    }).catch(function () {
      if (request !== diaryRequest) return
      if (diaryDates) clearNode(diaryDates)
      if (diaryTitle) diaryTitle.textContent = '日记'
      if (diaryBody) diaryBody.textContent = ''
      diaryMessage('读取日记列表失败：日记服务可能还没启动（重启 DSH 或稍后再试）。', true)
    })
  }

  if (diaryButton) diaryButton.addEventListener('click', function () { openModal('diary') })
  if (diaryRefresh) diaryRefresh.addEventListener('click', function () { renderDiary() })

  /* ------------------------------------------------------- social (V1.2) */

  // 社交面板只做「配置 + 显式查看」：
  //   1. 消息到达只进 Host 收件箱并更新未读数，面板不会因此调用模型；
  //   2. 「查看」是用户主动动作，会启动一轮真实模型对话，之后鱼鱼可以沉默；
  //   3. 面板不提供直接发信或自动回复开关，回复只能由受限会话里的显式工具完成。
  var socialButton = $('social-button')
  var socialRefresh = $('social-refresh')
  var socialNew = $('social-new')
  var socialDelete = $('social-delete')
  var socialSave = $('social-save')
  var socialSummary = $('social-summary')
  var socialStatusBox = $('social-status')
  var socialNotices = $('social-notices')
  var socialUnreadCount = $('social-unread-count')
  var socialList = $('social-list')
  var socialFormTitle = $('social-form-title')
  // 表单只保留连一条通道真正需要的东西：标识、平台、接入方式、地址、凭证引用。
  // 启用状态和接收范围不给开关——保存即可用，私聊/群/频道默认都接收。
  var socialFields = {
    id: $('social-id'),
    platform: $('social-platform'),
    provider: $('social-provider'),
    endpoint: $('social-endpoint'),
    tokenEnv: $('social-token-env')
  }
  var socialPayload = null
  var socialEditing = null
  var socialRequest = 0
  var socialBusy = false

  var SOCIAL_STATUS_LABELS = {
    connected: '已连接',
    starting: '连接中',
    disconnected: '未连接',
    error: '出错',
    identity_changed: '待确认新账号'
  }
  var SOCIAL_ERROR_LABELS = {
    SOCIAL_UNAUTHORIZED: '令牌失效，刷新页面后再试',
    SOCIAL_BRIDGE_UNAVAILABLE: '宿主桥接不可用（需要宿主支持受限会话）',
    SOCIAL_BRIDGE_CLOSED: '桥接已关闭，重启 DSH 后再试',
    SOCIAL_MODEL_UNAVAILABLE: '还没有可用的默认模型',
    SOCIAL_READ_ONLY_UNAVAILABLE: '宿主没有 read-only 权限预设',
    SOCIAL_PERSISTENCE_UNVERIFIED: '无法确认会话已持久化，已拒绝继续',
    SOCIAL_DELIVERY_UNCERTAIN: '上一批投递状态不确定，已停止以免重复',
    SOCIAL_SCOPE_STALE: '身份或授权已变化，请刷新后重新查看',
    SOCIAL_NOT_CONNECTED: '连接还没建立（检查地址、凭证和 Provider）',
    SOCIAL_INVALID_CONFIG: '配置不合法（检查平台、接入方式、地址）',
    SOCIAL_INVALID_CONNECTION: '连接字段不合法或 ID 重复',
    SOCIAL_INVALID_ENDPOINT: '连接地址不合法，只能用 ws:// 或 wss://',
    SOCIAL_INSECURE_ENDPOINT: '远程连接必须使用 wss://',
    SOCIAL_TOKEN_REQUIRED: '远程连接必须填写凭证环境变量名',
    SOCIAL_UNSUPPORTED_PROVIDER: '这个平台不支持该接入方式',
    SOCIAL_PLATFORM_MISMATCH: '接入方式和平台不匹配',
    SOCIAL_CONFIRMATION_STALE: '待确认身份已变化，请先刷新',
    SOCIAL_RATE_LIMITED: '发送太频繁，稍后再试',
    SOCIAL_BACKPRESSURE: '处理队列已满，稍后再试'
  }

  function socialErrorMessage(error) {
    var code = error && error.message ? String(error.message) : ''
    if (code === 'social-unavailable') return '社交服务还没连上'
    return SOCIAL_ERROR_LABELS[code] || code || '未知错误'
  }

  function socialRoute() {
    var routes = stateBridge && stateBridge.routes ? stateBridge.routes : ROUTE_SPEC
    return routes && typeof routes.social === 'string' ? routes.social : ''
  }

  function socialApi(method, body) {
    var route = socialRoute()
    if (!route || !stateBridge || typeof fetch !== 'function') return Promise.reject(new Error('social-unavailable'))
    var options = {
      method: method,
      headers: Object.assign({ 'x-chonkyfish-token': stateBridge.token }, body ? { 'content-type': 'application/json' } : {}),
      cache: 'no-store'
    }
    if (body) options.body = JSON.stringify(body)
    return fetch(route, options).then(function (response) {
      return response.json().catch(function () { return null }).then(function (payload) {
        if (!response.ok || !payload || payload.ok !== true) {
          var code = payload && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
          throw new Error(code)
        }
        return payload
      })
    })
  }

  function socialConversationLabel(ref) {
    if (!ref) return '未知会话'
    var kind = ref.type === 'direct' ? '私聊' : ref.type === 'group' ? '群' : '频道'
    var id = ref.type === 'channel' ? String(ref.guildId || '') + '/' + String(ref.id || '') : String(ref.id || '')
    return kind + ' · ' + id
  }

  function socialResetForm() {
    socialEditing = -1
    if (socialFormTitle) socialFormTitle.textContent = '新增连接'
    if (socialFields.id) socialFields.id.value = ''
    if (socialFields.platform) socialFields.platform.value = 'qq'
    if (socialFields.provider) socialFields.provider.value = 'napcat'
    if (socialFields.endpoint) socialFields.endpoint.value = ''
    if (socialFields.tokenEnv) socialFields.tokenEnv.value = ''
  }

  function socialSelect(index) {
    var connections = socialPayload && socialPayload.config && Array.isArray(socialPayload.config.connections)
      ? socialPayload.config.connections
      : []
    var connection = index >= 0 && index < connections.length ? connections[index] : null
    if (!connection) { socialResetForm(); return }
    socialEditing = index
    if (socialFormTitle) socialFormTitle.textContent = '编辑连接 · ' + connection.id
    if (socialFields.id) socialFields.id.value = connection.id
    if (socialFields.platform) socialFields.platform.value = connection.platform
    if (socialFields.provider) socialFields.provider.value = connection.provider
    if (socialFields.endpoint) socialFields.endpoint.value = connection.endpoint
    if (socialFields.tokenEnv) socialFields.tokenEnv.value = connection.tokenEnv || ''
  }

  function socialReadForm() {
    var id = socialFields.id ? String(socialFields.id.value || '').trim() : ''
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('连接 ID 只能用字母、数字、下划线和连字符')
    var endpoint = socialFields.endpoint ? String(socialFields.endpoint.value || '').trim() : ''
    if (!endpoint) throw new Error('请填写连接地址')
    if (endpoint.length > 2048) throw new Error('连接地址太长')
    var platform = socialFields.platform ? socialFields.platform.value : 'qq'
    var connection = {
      id: id,
      platform: platform,
      provider: socialFields.provider ? socialFields.provider.value : 'napcat',
      endpoint: endpoint
    }
    var tokenEnv = socialFields.tokenEnv ? String(socialFields.tokenEnv.value || '').trim() : ''
    if (tokenEnv) connection.tokenEnv = tokenEnv
    return connection
  }

  function socialSubmit(body, okText) {
    if (socialBusy) return
    socialBusy = true
    socialApi('POST', body).then(function () {
      socialBusy = false
      toast(okText)
      loadSocial()
    }).catch(function (error) {
      socialBusy = false
      toast('操作失败：' + socialErrorMessage(error))
      loadSocial()
    })
  }

  function socialSaveConfig() {
    if (!socialPayload) { toast('社交状态还没读出来，先点刷新'); return }
    var connection
    try {
      connection = socialReadForm()
    } catch (error) {
      toast(error && error.message ? error.message : '配置不完整')
      return
    }
    // 配置损坏或首次使用时从空配置开始，保存即可覆盖修好。
    var config = JSON.parse(JSON.stringify(socialPayload.config || { version: 1, connections: [] }))
    config.version = 1
    var connections = Array.isArray(config.connections) ? config.connections.slice() : []
    for (var i = 0; i < connections.length; i += 1) {
      if (i !== socialEditing && connections[i] && connections[i].id === connection.id) {
        toast('已经有一条同名连接了')
        return
      }
    }
    if (typeof socialEditing === 'number' && socialEditing >= 0 && socialEditing < connections.length) {
      connections[socialEditing] = connection
    } else {
      if (connections.length >= 16) { toast('最多 16 条连接'); return }
      connections.push(connection)
    }
    config.connections = connections
    socialSubmit({ action: 'configure', config: config }, '配置已保存')
  }

  function socialDeleteConnection() {
    if (!socialPayload || !socialPayload.config) return
    if (typeof socialEditing !== 'number' || socialEditing < 0) { toast('先选中一条连接'); return }
    var connections = socialPayload.config.connections || []
    var connection = connections[socialEditing]
    if (!connection) return
    ask('删除连接「' + connection.id + '」？已缓存的消息和身份记录不会被自动清理。').then(function (ok) {
      if (!ok) return
      var config = JSON.parse(JSON.stringify(socialPayload.config))
      config.version = 1
      config.connections = (config.connections || []).filter(function (item) { return !item || item.id !== connection.id })
      socialBusy = true
      socialApi('POST', { action: 'configure', config: config }).then(function () {
        socialBusy = false
        toast('连接已删除')
        socialEditing = null
        loadSocial()
      }).catch(function (error) {
        socialBusy = false
        toast('删除失败：' + socialErrorMessage(error))
      })
    })
  }

  function socialView(connectionId, conversation) {
    ask('现在让鱼鱼看这批新消息？这会启动一轮真实模型对话，可能消耗额度；她看过之后可以不回复。').then(function (ok) {
      if (!ok) return
      if (socialBusy) return
      socialBusy = true
      socialApi('POST', { action: 'view', connectionId: connectionId, conversation: conversation }).then(function (payload) {
        socialBusy = false
        var status = payload && payload.result && payload.result.status
        if (status === 'viewed') toast('鱼鱼看过这批消息了；要不要回由她自己决定')
        else if (status === 'empty') toast('这里暂时没有未读消息')
        else if (status === 'busy') toast('鱼鱼正在忙，稍后再让她看')
        else toast('已处理')
        loadSocial()
      }).catch(function (error) {
        socialBusy = false
        toast('查看失败：' + socialErrorMessage(error))
        loadSocial()
      })
    })
  }

  function socialConfirmIdentity(connectionId) {
    var records = socialPayload && Array.isArray(socialPayload.identities) ? socialPayload.identities : []
    var pending = null
    for (var i = 0; i < records.length; i += 1) {
      var row = records[i]
      if (row && row.identity && row.identity.connectionId === connectionId) pending = row.pending || null
    }
    if (!pending) { toast('没有待确认的新账号，先点刷新'); return }
    ask('确认这条连接换成新账号「' + (pending.displayName || pending.protocolUserId) + '」？旧会话和待发消息不会自动迁移。').then(function (ok) {
      if (!ok) return
      socialSubmit({ action: 'confirm_identity', connectionId: connectionId, expectedProtocolUserId: pending.protocolUserId }, '已确认新账号')
    })
  }

  function socialStatusRow(label, value, warning) {
    var row = document.createElement('div')
    var name = document.createElement('span')
    name.textContent = label + '：'
    var detail = document.createElement('b')
    detail.textContent = value
    if (warning) detail.className = 'warn'
    row.appendChild(name)
    row.appendChild(detail)
    return row
  }

  function renderSocialStatus() {
    if (!socialStatusBox) return
    clearNode(socialStatusBox)
    if (!socialPayload) return
    var bridge = socialPayload.bridge || {}
    socialStatusBox.appendChild(socialStatusRow('连接', (socialPayload.connections || []).length + ' 条'))
    socialStatusBox.appendChild(socialStatusRow('收信', '只进收件箱并计数，不会自动调用模型'))
    socialStatusBox.appendChild(socialStatusRow('行动决策', socialPayload.actionEngineConnected ? '已接入' : '未接入：需要你手动点「查看」'))
    socialStatusBox.appendChild(socialStatusRow('受限会话桥接', bridge.available ? '可用' : '不可用：' + (SOCIAL_ERROR_LABELS[bridge.reason] || bridge.reason || '未知'), !bridge.available))
    if (socialPayload.configError) {
      var error = document.createElement('div')
      error.className = 'cf-social-error'
      error.textContent = '配置错误：' + (SOCIAL_ERROR_LABELS[socialPayload.configError] || socialPayload.configError) + '（重新填写并保存会覆盖这份配置）'
      socialStatusBox.appendChild(error)
    }
  }

  function renderSocialNotices() {
    if (!socialNotices) return
    clearNode(socialNotices)
    var notices = socialPayload && Array.isArray(socialPayload.notices) ? socialPayload.notices : []
    if (socialUnreadCount) {
      var total = 0
      for (var i = 0; i < notices.length; i += 1) total += Number(notices[i].unreadCount) || 0
      socialUnreadCount.textContent = String(total)
    }
    if (notices.length === 0) {
      var empty = document.createElement('div')
      empty.className = 'cf-social-empty'
      empty.textContent = '还没有收到消息。'
      socialNotices.appendChild(empty)
      return
    }
    notices.forEach(function (notice) {
      var row = document.createElement('div')
      row.className = 'cf-social-row'
      var info = document.createElement('div')
      var title = document.createElement('span')
      title.textContent = socialConversationLabel(notice.conversation)
      info.appendChild(title)
      if (notice.mentionsSelf) {
        var mention = document.createElement('span')
        mention.className = 'cf-social-chip ok'
        mention.textContent = '提到了鱼鱼'
        info.appendChild(mention)
      }
      if (notice.hasGap) {
        var gap = document.createElement('span')
        gap.className = 'cf-social-chip bad'
        gap.textContent = '有消息过期'
        info.appendChild(gap)
      }
      var detail = document.createElement('small')
      detail.textContent = notice.unreadCount + ' 条未读 · ' + (notice.connectionId || '')
      info.appendChild(detail)
      row.appendChild(info)
      var actions = document.createElement('div')
      actions.className = 'cf-social-actions'
      var view = document.createElement('button')
      view.type = 'button'
      view.className = 'primary-mini'
      view.textContent = '查看'
      view.addEventListener('click', function () { socialView(notice.connectionId, notice.conversation) })
      actions.appendChild(view)
      row.appendChild(actions)
      socialNotices.appendChild(row)
    })
  }

  function renderSocialConnections() {
    if (!socialList) return
    clearNode(socialList)
    var connections = socialPayload && Array.isArray(socialPayload.connections) ? socialPayload.connections : []
    var pendingIds = {}
    var records = socialPayload && Array.isArray(socialPayload.identities) ? socialPayload.identities : []
    for (var r = 0; r < records.length; r += 1) {
      if (records[r] && records[r].pending && records[r].identity) pendingIds[records[r].identity.connectionId] = true
    }
    if (connections.length === 0) {
      var empty = document.createElement('div')
      empty.className = 'cf-social-empty'
      empty.textContent = '还没有配置连接；填写下面的表单再保存。'
      socialList.appendChild(empty)
      return
    }
    var configConnections = socialPayload.config && Array.isArray(socialPayload.config.connections)
      ? socialPayload.config.connections
      : []
    connections.forEach(function (connection) {
      var row = document.createElement('div')
      row.className = 'cf-social-row'
      var info = document.createElement('div')
      var title = document.createElement('span')
      title.textContent = connection.connectionId + ' · ' + connection.platform + ' / ' + connection.provider
      info.appendChild(title)
      var status = document.createElement('span')
      status.className = 'cf-social-chip ' + (connection.status === 'connected' ? 'ok' : connection.status === 'error' || connection.status === 'identity_changed' ? 'bad' : '')
      status.textContent = SOCIAL_STATUS_LABELS[connection.status] || connection.status || '未启用'
      info.appendChild(status)
      var detail = document.createElement('small')
      var identity = connection.identity
      detail.textContent = identity
        ? '身份：' + (identity.displayName || identity.protocolUserId) + (connection.reason ? ' · ' + connection.reason : '')
        : '还没有确认身份' + (connection.reason ? ' · ' + connection.reason : '')
      info.appendChild(detail)
      row.appendChild(info)
      var actions = document.createElement('div')
      actions.className = 'cf-social-actions'
      if (pendingIds[connection.connectionId]) {
        var confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.textContent = '确认新账号'
        confirm.addEventListener('click', function () { socialConfirmIdentity(connection.connectionId) })
        actions.appendChild(confirm)
      }
      var edit = document.createElement('button')
      edit.type = 'button'
      edit.textContent = '编辑'
      edit.addEventListener('click', function () {
        for (var i = 0; i < configConnections.length; i += 1) {
          if (configConnections[i] && configConnections[i].id === connection.connectionId) { socialSelect(i); return }
        }
        toast('这条连接不在当前配置里')
      })
      actions.appendChild(edit)
      row.appendChild(actions)
      socialList.appendChild(row)
    })
  }

  function renderSocialView() {
    if (socialSummary) {
      var connections = socialPayload && Array.isArray(socialPayload.connections) ? socialPayload.connections : []
      var connected = 0
      for (var i = 0; i < connections.length; i += 1) if (connections[i].status === 'connected') connected += 1
      socialSummary.textContent = (connections.length === 0 ? '还没有配置连接' : '社交运行中') +
        ' · ' + connected + '/' + connections.length + ' 条在线'
    }
    renderSocialStatus()
    renderSocialNotices()
    renderSocialConnections()
    var configConnections = socialPayload && socialPayload.config && Array.isArray(socialPayload.config.connections)
      ? socialPayload.config.connections
      : []
    if (socialEditing === null) {
      if (configConnections.length > 0) socialSelect(0)
      else socialResetForm()
    }
  }

  function loadSocial() {
    if (!socialPanel) return
    var request = ++socialRequest
    socialApi('GET').then(function (payload) {
      if (request !== socialRequest) return
      socialPayload = payload
      renderSocialView()
    }).catch(function () {
      if (request !== socialRequest) return
      socialPayload = null
      if (socialSummary) socialSummary.textContent = '读取社交状态失败：社交模块可能没启动，重启 DSH 或刷新页面再试。'
      if (socialStatusBox) clearNode(socialStatusBox)
      if (socialNotices) clearNode(socialNotices)
      if (socialList) clearNode(socialList)
    })
  }

  function renderSocial() {
    if (!socialPanel) return
    if (!stateBridge || typeof fetch !== 'function' || !socialRoute()) {
      if (socialSummary) socialSummary.textContent = '社交服务还没连上：刷新一下页面拿到新的令牌后再试。'
      if (socialStatusBox) clearNode(socialStatusBox)
      if (socialNotices) clearNode(socialNotices)
      if (socialList) clearNode(socialList)
      return
    }
    if (socialSummary) socialSummary.textContent = '正在读取社交连接…'
    loadSocial()
  }

  if (socialButton) socialButton.addEventListener('click', function () { openModal('social') })
  if (socialRefresh) socialRefresh.addEventListener('click', function () { renderSocial() })
  if (socialNew) socialNew.addEventListener('click', function () { socialResetForm() })
  if (socialSave) socialSave.addEventListener('click', socialSaveConfig)
  if (socialDelete) socialDelete.addEventListener('click', socialDeleteConnection)

  /* --------------------------------------------------------------- stage */

  var currentPose = 'eat'
  var poseTimer = null

  function setPose(name) {
    if (!POSES[name]) return
    currentPose = name
    var image = $('pet-avatar')
    if (image) image.src = POSES[name]
  }
  function setSpeech(text) {
    var speech = $('pet-say')
    if (speech) speech.textContent = text
  }
  function setPresence(text) {
    var top = $('presence-top')
    if (top) top.textContent = text
    var stage = $('stage-status')
    if (stage) stage.textContent = text
  }
  function setFoot(text) {
    var foot = $('chat-foot')
    if (foot) foot.textContent = text
  }
  function setBalanceUI() {
    var formatted = state.balance.toLocaleString('zh-CN')
    var top = $('top-balance')
    if (top) top.textContent = formatted
    var stageBalance = $('stage-balance')
    if (stageBalance) stageBalance.textContent = formatted
    var big = $('wallet-big')
    if (big) big.innerHTML = formatted + ' <i>贝壳</i>'
  }
  function excerpt(text) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim()
    return clean.length > 26 ? clean.slice(0, 26) + '…' : clean
  }
  function petReaction(pose, text, revertMs) {
    setPose(pose)
    setSpeech(text)
    if (poseTimer) {
      clearTimeout(poseTimer)
      timers.delete(poseTimer)
    }
    if (revertMs) {
      poseTimer = later(function () {
        setPose(busy || (realChat && realChat.isRunning()) ? 'think' : 'eat')
      }, revertMs)
    }
  }

  var petAvatar = $('pet-avatar')
  if (petAvatar) {
    petAvatar.addEventListener('click', function () {
      if (currentPose === 'blush') return
      petReaction('blush', '不、不许一直摸我的头啦… 💙', 2600)
      toast('鱼鱼害羞啦')
    })
  }
  var feedButton = $('feed-button')
  if (feedButton) {
    feedButton.addEventListener('click', function () {
      if (!transact(-12, '香喷喷白饭')) return
      petReaction('eat', '好耶！白饭！开动啦～ 🍚', 2600)
    })
  }

  /* ---------------------------------------------------------------- chat */

  function formatTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  var renderedMessages = []
  var renderedMode = null
  var renderedConversation = null
  var typingElement = null

  function messageKey(message) {
    return message.role + '|' + (message.time || '') + '|' + message.text
  }
  function clearTyping() {
    if (typingElement && typingElement.parentNode) typingElement.parentNode.removeChild(typingElement)
    typingElement = null
  }
  function ensureTyping(visible) {
    var container = $('messages')
    if (!container) return
    if (!visible) {
      clearTyping()
      return
    }
    if (!typingElement) {
      typingElement = document.createElement('div')
      typingElement.className = 'typing'
    }
    typingElement.textContent = state.name + '正在想该怎么回复……'
    container.append(typingElement)
  }
  function displayedMessages() {
    if (realMode && realChat) {
      var live = realChat.getMessages()
      if (live.length === 0) return [{ role: 'fish', text: GREETING, time: '' }]
      return live
    }
    return state.messages
  }
  function appendMessage(role, text, time) {
    var container = $('messages')
    if (!container) return
    var msg = document.createElement('div')
    msg.className = 'message ' + (role === 'user' ? 'user' : 'fish')
    if (role !== 'user') {
      var avatar = document.createElement('img')
      avatar.className = 'msg-avatar'
      avatar.alt = state.name
      avatar.src = PET_AVATAR_SRC
      msg.append(avatar)
    }
    var box = document.createElement('div')
    box.className = 'msg-wrap'
    var meta = document.createElement('div')
    meta.className = 'msg-meta'
    meta.textContent = (role === 'user' ? '我' : state.name) + ' · ' + (time || formatTime())
    var bubble = document.createElement('div')
    bubble.className = 'msg-bubble'
    bubble.textContent = text
    box.append(meta, bubble)
    msg.append(box)
    container.append(msg)
    container.scrollTop = container.scrollHeight
  }
  function renderChat(force) {
    var container = $('messages')
    if (!container) return
    var mode = realMode && realChat ? 'real' : 'demo'
    var list = displayedMessages().slice(-80)
    var rebuild = force === true || mode !== renderedMode || container !== renderedConversation
    var start = 0
    if (!rebuild) {
      start = -1
      if (renderedMessages.length === 0) {
        start = 0
      } else {
        for (var offset = 0; offset + renderedMessages.length <= list.length; offset += 1) {
          var match = true
          for (var j = 0; j < renderedMessages.length; j += 1) {
            if (messageKey(renderedMessages[j]) !== messageKey(list[offset + j])) {
              match = false
              break
            }
          }
          if (match) {
            start = offset + renderedMessages.length
            break
          }
        }
      }
      if (start === -1) rebuild = true
    }
    if (rebuild) {
      clearTyping()
      container.innerHTML = ''
      renderedMessages = []
      renderedMode = mode
      renderedConversation = container
      start = 0
    }
    var appended = false
    for (var index = start; index < list.length; index += 1) {
      appendMessage(list[index].role, list[index].text, list[index].time)
      appended = true
    }
    renderedMessages = list.slice()
    ensureTyping(mode === 'real' && realChat ? realChat.isRunning() || busy : busy)
    container.scrollTop = container.scrollHeight
    if (appended && list.length) {
      var last = list[list.length - 1]
      if (!last.time && list.length === 1) {
        setPose('eat')
        setSpeech('嘿嘿～ 一起吃饭吧！🍚 ✨')
      } else if (last.role === 'fish') {
        petReaction('happy', excerpt(last.text), 0)
      } else if (realChat && realChat.isRunning()) {
        setPose('think')
        setSpeech('让我想想……')
      }
    }
  }

  function fishReply(text) {
    var t = text.toLowerCase()
    var reply
    if (/钱|贝壳|钱包|买|零花/.test(t)) {
      reply = '我数数……本鲸现在有 ' + state.balance + ' 枚贝壳！要是再来一点，就能吃更多白饭啦。🪙'
    } else if (/白饭|吃|饿|饭|奶茶/.test(t)) {
      reply = '白饭！热乎乎的白饭！可以再来一碗吗？本鲸保证……会认真干活五分钟的！🍚'
    } else if (/今天|怎么样|心情|好吗/.test(t)) {
      reply = '今天心情还不错！就是总感觉缺了点什么……啊，原来是缺你来找我玩！'
    } else if (/你好|嗨|早|晚安/.test(t)) {
      reply = '哼哼，来得正好！本鲸正准备和你说今天的鱼塘趣事呢～'
    } else if (/喜欢|爱你|可爱|摸摸/.test(t)) {
      reply = '欸？！这、这种话突然说出来，会让本鲸害羞的……再说一遍嘛。💙'
    } else {
      var options = [
        '咦？原来是这样！那本鲸也要认真想一想……先吃一碗白饭再想！',
        '本鲸听见啦！说起来，今天的云朵看起来像一碗白饭。',
        '唔……听你这么一说，本鲸好像有一点懂了！你再跟我讲讲嘛～',
      ]
      reply = options[(text.length + state.messages.length) % options.length]
    }
    return reply
  }

  function sendDemo(value) {
    var time = formatTime()
    state.messages.push({ role: 'user', text: value, time: time })
    save()
    busy = true
    petReaction('think', '让我想想……', 0)
    renderChat()
    later(function () {
      var reply = fishReply(value)
      state.messages.push({ role: 'fish', text: reply, time: formatTime() })
      busy = false
      save()
      renderChat()
      petReaction('happy', excerpt(reply), 0)
    }, 520)
  }

  function sendReal(value) {
    busy = true
    petReaction('think', '让我想想……', 0)
    renderChat()
    realChat.send(value).then(function () {
      busy = false
      renderChat()
    }).catch(function (error) {
      busy = false
      realMode = false
      realStatus = { phase: 'error', error: { message: error && error.message ? error.message : String(error) } }
      applyStatus()
      renderChat()
      toast('DSH 会话暂不可用，先用本地演示回复：' + (error && error.message ? error.message : '未知错误'))
      sendDemo(value)
    })
  }

  function send(text) {
    var value = String(text || '').trim()
    if (!value || busy) return
    var input = $('chat-input')
    if (input) input.value = ''
    if (realChat) {
      sendReal(value)
      return
    }
    sendDemo(value)
  }

  var chatForm = $('chat-form')
  if (chatForm) {
    chatForm.addEventListener('submit', function (event) {
      event.preventDefault()
      send($('chat-input').value)
    })
  }
  var chatInput = $('chat-input')
  if (chatInput) {
    chatInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        send(event.currentTarget.value)
      }
    })
  }
  $$('[data-suggest]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var input = $('chat-input')
      if (!input) return
      input.value = chip.dataset.suggest
      focusNode(input)
    })
  })

  var restartButton = $('restart-button')
  if (restartButton) {
    restartButton.addEventListener('click', function () {
      if (realChat) {
        ask('开始新对话会新建一个 DSH 会话；当前鱼鱼会话会保留在 DSH 会话列表里。继续吗？').then(function (ok) {
          if (!ok) return
          toast('正在给鱼鱼换一个新的小鱼塘……')
          realChat.reset().then(function () {
            realMode = true
            lastChatSignature = ''
            handleChatChange()
            toast('鱼鱼已经换到新的小鱼塘啦')
          }).catch(function (error) {
            toast('新建会话失败：' + (error && error.message ? error.message : '未知错误'))
          })
        })
        return
      }
      ask('确定开始新对话吗？当前聊天记录会清空。').then(function (ok) {
        if (!ok) return
        state.messages = [{ role: 'fish', text: '新的一天，从和本鲸打招呼开始！🍚', time: formatTime() }]
        save()
        renderChat(true)
        petReaction('idle', '新的一天，也要一起吃饭哦～', 0)
        toast('已经开始新的悄悄话啦')
      })
    })
  }

  /* ------------------------------------------------------------- persona */

  function updateTitle() {
    var title = $('chat-title')
    if (title) title.textContent = '和' + state.name + ' 聊聊天'
    var brand = wrap.querySelector('.brand-title')
    if (brand) brand.textContent = '和' + state.name + '的悄悄话'
  }

  function renderPersona() {
    var name = $('fish-name')
    var prompt = $('fish-prompt')
    if (!name || !prompt) return
    name.value = state.name
    prompt.value = state.prompt
  }

  var savePersona = $('save-persona')
  if (savePersona) {
    savePersona.addEventListener('click', function () {
      var name = $('fish-name').value.trim()
      if (!name) {
        toast('先给鱼鱼起个名字吧')
        return
      }
      state.name = name
      state.prompt = $('fish-prompt').value.trim()
      save()
      updateTitle()
      renderChat(true)
      toast('人格设定保存好啦！🐳')
    })
  }
  var resetPersona = $('reset-persona')
  if (resetPersona) {
    resetPersona.addEventListener('click', function () {
      var d = defaults()
      Object.assign(state, { name: d.name, prompt: d.prompt })
      save()
      renderPersona()
      updateTitle()
      renderChat(true)
      toast('人格已经恢复默认')
    })
  }

  /* -------------------------------------------------------------- wallet */

  function renderWallet() {
    setBalanceUI()
    var list = $('ledger-list')
    if (!list) return
    list.innerHTML = ''
    if (!state.ledger.length) {
      var empty = document.createElement('div')
      empty.className = 'cf-ledger-empty'
      empty.textContent = '账本空空的，等鱼鱼的第一笔零花钱～'
      list.append(empty)
      return
    }
    state.ledger.slice(0, 15).forEach(function (item) {
      var row = document.createElement('div')
      row.className = 'cf-ledger-row'
      var main = document.createElement('span')
      var title = document.createElement('span')
      title.textContent = item.title
      var date = document.createElement('small')
      date.textContent = '  ' + item.date
      main.append(title, date)
      var amount = document.createElement('b')
      amount.className = item.amount < 0 ? 'negative' : ''
      amount.textContent = (item.amount > 0 ? '+' : '') + item.amount
      row.append(main, amount)
      list.append(row)
    })
  }

  function transact(amount, title) {
    if (amount < 0 && state.balance + amount < 0) {
      toast('贝壳不够啦，先给鱼鱼发点零花钱！')
      return false
    }
    state.balance += amount
    state.ledger.unshift({
      title: title,
      amount: amount,
      date: new Date().toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
      id: Date.now(),
    })
    state.ledger = state.ledger.slice(0, 40)
    save()
    setBalanceUI()
    renderWallet()
    if (amount > 0) {
      petReaction('happy', '呜哇！谢谢你！可以买白饭啦！', 2400)
    } else {
      petReaction('eat', '嘿嘿！本鲸买到喜欢的东西啦！', 2400)
    }
    toast(amount > 0 ? '鱼鱼收到 ' + amount + ' 贝壳！' : '鱼鱼买到了「' + title + '」')
    return true
  }

  $$('[data-add]').forEach(function (button) {
    button.addEventListener('click', function () {
      transact(Number(button.dataset.add), '主人发的零花钱')
    })
  })
  $$('[data-spend]').forEach(function (button) {
    button.addEventListener('click', function () {
      transact(-Number(button.dataset.spend), button.dataset.item)
    })
  })
  var customAdd = $('custom-add')
  if (customAdd) {
    customAdd.addEventListener('click', function () {
      var input = $('custom-money')
      var amount = Number(input.value)
      if (!Number.isInteger(amount) || amount < 1 || amount > 10000) {
        toast('请输入 1～10000 的整数贝壳')
        return
      }
      if (transact(amount, '主人发的零花钱')) input.value = ''
    })
  }
  var clearLedger = $('clear-ledger')
  if (clearLedger) {
    clearLedger.addEventListener('click', function () {
      ask('只清空收支记录，保留当前余额，确定吗？').then(function (ok) {
        if (!ok) return
        state.ledger = []
        save()
        renderWallet()
        toast('账本已经清空')
      })
    })
  }

  /* --------------------------------------------------------- chat status */

  function statusText(status) {
    if (!status || status.phase === 'disabled') return '和鱼鱼聊天 · 本地演示回复'
    if (status.phase === 'ready') return '已接入 DSH · 「大肥鱼」人格预设 · 对话保存在 DSH 会话里'
    if (status.phase === 'connecting') return '正在连接鱼鱼的大脑……'
    var failure = status.error
    var reason = failure && (failure.message || failure.code) ? failure.message || failure.code : '未知错误'
    return '未连接 DSH：' + reason + ' · 当前用本地演示回复'
  }
  function applyStatus() {
    setFoot(statusText(realStatus))
    if (realStatus.phase === 'ready') {
      setPresence('鱼鱼在家')
      if (!busy && !(realChat && realChat.isRunning())) setPose(realMode ? 'eat' : 'idle')
    } else if (realStatus.phase === 'connecting') {
      setPresence('鱼鱼正在上线…')
      setPose('think')
      setSpeech('等我一下，鱼鱼正在连上大脑……')
    } else if (realStatus.phase === 'error') {
      setPresence('鱼鱼睡着了')
      setPose('sleep')
      setSpeech('呜……连不上大脑，先用本地回复陪你。')
    } else {
      setPresence('鱼鱼在家')
    }
  }
  function handleChatChange() {
    if (!realChat) return
    realStatus = realChat.getStatus()
    if (realStatus.phase === 'ready') realMode = true
    else if (realStatus.phase === 'error' && realMode) realMode = false
    applyStatus()
    var messages = realMode ? realChat.getMessages() : state.messages
    var last = messages.length ? messages[messages.length - 1] : null
    var signature = realStatus.phase + '|' + messages.length + '|' +
      (last ? last.role + last.text.length + last.text.slice(0, 24) : '') + '|' +
      (realChat.isRunning() ? 'run' : 'idle') + '|' + (busy ? 'busy' : 'idle')
    if (signature === lastChatSignature) return
    lastChatSignature = signature
    renderChat()
    if (realChat.isRunning()) {
      setPose('think')
      setSpeech('让我想想……')
    } else if (last && last.role === 'fish') {
      petReaction('happy', excerpt(last.text), 0)
    } else if (realStatus.phase === 'ready') {
      setPose('eat')
    }
  }

  /* ------------------------------------------------- standalone section */

  // 独立页复用弹窗里的同款内容：把对应 .cf-section 从隐藏的 dialog 里搬进整页
  // 容器，原有的 fetch / 事件监听 / 渲染函数都不用改，只是换个宿主。
  var SECTION_VIEWS = {
    wallet: {
      panel: function () { return walletPanel },
      icon: '🐚',
      title: '鱼鱼的零花钱',
      subtitle: '贝壳、小卖部和收支小账本，都归鱼鱼自己管。',
      render: function () { renderWallet() },
    },
    settings: {
      panel: function () { return settingsPanel },
      icon: '💙',
      title: '人格设定',
      subtitle: '名字和补充人格会作为 system prompt 的补充交给模型，下一轮对话生效。',
      render: function () { renderPersona() },
    },
    sense: {
      panel: function () { return sensePanel },
      icon: '✨',
      title: '鱼鱼的感知',
      subtitle: '鱼鱼从对话里记住的「说了什么 / 打算什么」，每条都带原话回链。',
      render: function () { renderSense() },
    },
    diary: {
      panel: function () { return diaryPanel },
      icon: '📔',
      title: '鱼鱼的日记',
      subtitle: '一天一篇，由鱼鱼自己调用日记工具写下；面板只读。',
      render: function () { renderDiary() },
    },
    social: {
      panel: function () { return socialPanel },
      icon: '💬',
      title: '鱼鱼的社交',
      subtitle: '连接管理、未读收件箱与「查看」入口；默认不自动回复。',
      render: function () { renderSocial() },
    },
  }

  function mountSectionPage() {
    if (!wrap) return
    var spec = SECTION_VIEWS[pageView]
    if (!spec) return
    var panel = spec.panel()
    if (!panel) return
    wrap.classList.add('cf-section-view')

    var page = document.createElement('div')
    page.className = 'cf-page'
    var inner = document.createElement('div')
    inner.className = 'cf-page-inner'

    var head = document.createElement('header')
    head.className = 'cf-page-head'
    var badge = document.createElement('div')
    badge.className = 'cf-page-icon'
    badge.setAttribute('aria-hidden', 'true')
    badge.textContent = spec.icon
    var heading = document.createElement('div')
    var title = document.createElement('h1')
    title.className = 'cf-page-title'
    title.textContent = spec.title
    var subtitle = document.createElement('p')
    subtitle.className = 'cf-page-sub'
    subtitle.textContent = spec.subtitle
    heading.appendChild(title)
    heading.appendChild(subtitle)
    head.appendChild(badge)
    head.appendChild(heading)

    var body = document.createElement('main')
    body.className = 'cf-page-body'
    panel.hidden = false
    body.appendChild(panel)

    inner.appendChild(head)
    inner.appendChild(body)
    page.appendChild(inner)
    wrap.appendChild(page)

    try {
      spec.render()
    } catch (error) {
      console.error('[chonkyfish] section render failed', error)
    }
  }

  /* ---------------------------------------------------------------- boot */

  var brandAvatar = $('brand-avatar')
  if (brandAvatar) brandAvatar.src = PET_AVATAR_SRC
  var stageAvatar = $('pet-avatar')
  if (stageAvatar) stageAvatar.src = POSES[currentPose] || PET_AVATAR_SRC

  updateTitle()
  setBalanceUI()
  renderPersona()
  renderWallet()
  renderChat()
  applyStatus()
  hydrateFromFile()

  if (pageView !== 'chat') {
    mountSectionPage()
  }

  if (realChat) {
    realUnsubscribe = realChat.onChange(handleChatChange)
    handleChatChange()
    realChat.ensure().catch(function () {
      /* the bridge publishes its error status through onChange */
    })
  }

  return function dispose() {
    timers.forEach(function (id) { clearTimeout(id) })
    timers.clear()
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    if (poseTimer) {
      clearTimeout(poseTimer)
      poseTimer = null
    }
    if (fileSaveTimer) {
      clearTimeout(fileSaveTimer)
      fileSaveTimer = null
    }
    document.removeEventListener('keydown', onConfirmKeydown)
    document.removeEventListener('keydown', onModalKeydown)
    if (realUnsubscribe) {
      realUnsubscribe()
      realUnsubscribe = null
    }
    if (confirmResolve) {
      var pending = confirmResolve
      confirmResolve = null
      pending(false)
    }
  }
}
