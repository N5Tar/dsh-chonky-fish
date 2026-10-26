/**
 * Page controller for the 大肥鱼 chat UI panel.
 *
 * The page is the ported chat-UI design: a top bar, a chat pane with an
 * incremental transcript, and an illustration stage that reacts to the chat
 * state. The chat itself is backed by a real DSH Session through the bridge
 * passed in by the client module; when that bridge is unavailable the page
 * falls back to the local simulated replies.
 *
 * `mountChonkyFishPage(wrap, chat)` returns a disposer that clears every timer
 * and listener it installed.
 */
function mountChonkyFishPage(wrap, chat) {
  'use strict'

  var realChat = chat || null
  var realMode = false
  var realStatus = { phase: realChat ? 'idle' : 'disabled', error: null }
  var realUnsubscribe = null
  var lastChatSignature = ''
  var busy = false

  var KEY = 'chonkyfish-mini-demo-v1'
  var LEGACY_KEYS = ['dafeiyu-mini-demo-v1']
  var DEFAULT_PROMPT = '你是一只喜欢吃白饭的蓝色大肥鱼。你有点傲娇，喜欢摸鱼，偶尔嘴硬，但实际上非常关心和你聊天的人。请用轻松可爱、简短自然的中文交流。'
  var GREETING = '哼哼！你终于来了！本鲸今天可是很认真地等你哦。\n\n……所以，今天有白饭吃吗？🍚'
  var POSES = (typeof PET_POSES === 'object' && PET_POSES) || {}
  var PET_AVATAR_SRC = typeof PET_AVATAR === 'string' ? PET_AVATAR : ''

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
      var current = localStorage.getItem(KEY)
      if (current) return current
      for (var i = 0; i < LEGACY_KEYS.length; i += 1) {
        var legacy = localStorage.getItem(LEGACY_KEYS[i])
        if (legacy) {
          try {
            localStorage.setItem(KEY, legacy)
          } catch (error) {
            /* keep working from the legacy value even if the copy fails */
          }
          return legacy
        }
      }
    } catch (error) {
      /* storage unavailable */
    }
    return null
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
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch (error) {
      /* storage full or blocked */
    }
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
  var modalKind = null
  var modalReturnFocus = null

  function openModal(kind) {
    if (!modal) return
    modalKind = kind
    modalReturnFocus = focusedNode()
    if (modalTitle) modalTitle.textContent = kind === 'settings' ? '人格设定' : '鱼鱼的零花钱'
    if (walletPanel) walletPanel.hidden = kind !== 'wallet'
    if (settingsPanel) settingsPanel.hidden = kind !== 'settings'
    modal.classList.add('open')
    if (kind === 'settings') renderPersona()
    if (kind === 'wallet') renderWallet()
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

  function buildPayload(value, withSupplement) {
    if (withSupplement && state.prompt && state.prompt !== DEFAULT_PROMPT) {
      return '【角色补充设定】' + state.prompt + '\n\n【用户消息】\n' + value
    }
    return value
  }
  function hasUserMessage() {
    if (!realChat) return false
    var messages = realChat.getMessages()
    for (var i = 0; i < messages.length; i += 1) {
      if (messages[i].role === 'user') return true
    }
    return false
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
    realChat.send(buildPayload(value, !hasUserMessage())).then(function () {
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
