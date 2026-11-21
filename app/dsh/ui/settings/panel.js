var MIGRATION_ZH = {
  navSettings: '设置', settingsSubtitle: '管理大肥鱼的资料与运行偏好', migrationTitle: '资料导入 / 导出', migrationIntro: '在另一台电脑上继续保留大肥鱼的养成资料。',
  migrationIncluded: '包含：身份与人格、钱包与账本、日记、活动技能库、通用偏好，以及已经整理好的记忆。', migrationExcluded: '不包含：聊天、工作区、事件记忆、本机会话索引、社交连接和定时任务。',
  migrationExport: '导出资料', migrationImport: '导入资料', migrationSelect: '选择 .fishpack 文件', migrationPrivacy: '资料包含有人格、账本、日记、已整理的记忆和个人资料，请妥善保管。自定义个人资料目录和本机会话索引不会自动打包。',
  migrationReplace: '导入会替换已整理的记忆和其他纳入迁移的资料。现有资料会先备份；本机会话索引和其他未包含的数据保持不变。电脑活动采集与主动投递不会自动开启。', migrationConfirm: '确认替换', migrationCancel: '取消', migrationWorking: '正在处理资料…', migrationBusy: '正在准备导出…', migrationDone: '资料已恢复。', migrationDownload: '下载资料包', migrationReady: '检查完成，请确认要替换当前资料。', migrationError: '操作未完成，当前资料未确认改变。', migrationRecovery: '恢复未能自动完成。请保留备份并联系维护人员。', migrationCount: '项', migrationBytes: '字节', migrationRestart: '部分偏好需要重启 DSH 后生效。', migrationWarnCustomProfile: '自定义资料目录未包含', migrationWarnBrowserProfile: '浏览器运行资料未包含', migrationWarnAutonomous: '导入后不会自动启用主动行为', migrationUnsafePath: '个人资料中包含不支持的链接或特殊文件；请移除后重试。', migrationInvalidData: '资料内容无法通过校验，未导出或修改现有资料。', migrationTooLarge: '资料包超过大小限制。', migrationBusyError: '资料正在写入，请稍后重试。',
}
var MIGRATION_EN = {
  navSettings: 'Settings', settingsSubtitle: 'Manage ChonkyFish data and preferences', migrationTitle: 'Transfer data', migrationIntro: 'Carry ChonkyFish’s saved data to another computer.',
  migrationIncluded: 'Includes: identity and persona, wallet and ledger, diaries, skills, general preferences, and organized memories.', migrationExcluded: 'Excludes: chats, workspace, event memories, this computer’s session index, social connections and scheduled tasks.',
  migrationExport: 'Export data', migrationImport: 'Import data', migrationSelect: 'Choose a .fishpack file', migrationPrivacy: 'The archive contains private persona, ledger, diary, organized memories and profile data. Custom profile directories and this computer’s session index are not included automatically.',
  migrationReplace: 'Import replaces organized memories and the other included data. Existing data is backed up first; this computer’s session index and other excluded data stay unchanged. Activity collection and proactive delivery stay off.', migrationConfirm: 'Replace data', migrationCancel: 'Cancel', migrationWorking: 'Processing data…', migrationBusy: 'Preparing export…', migrationDone: 'Data restored.', migrationDownload: 'Download archive', migrationReady: 'Validation complete. Confirm to replace current data.', migrationError: 'Operation did not complete. Current data was not confirmed changed.', migrationRecovery: 'Automatic recovery failed. Keep the backup and contact support.', migrationCount: 'items', migrationBytes: 'bytes', migrationRestart: 'Some preferences require a DSH restart.', migrationWarnCustomProfile: 'Custom profile directory excluded', migrationWarnBrowserProfile: 'Browser runtime profile excluded', migrationWarnAutonomous: 'Autonomous actions stay off after import', migrationUnsafePath: 'The profile contains an unsupported link or special file. Remove it and try again.', migrationInvalidData: 'Data validation failed. No current data was changed.', migrationTooLarge: 'The data archive exceeds the size limit.', migrationBusyError: 'Data is being written. Try again shortly.',
}
Object.assign(zh, MIGRATION_ZH)
Object.assign(en, MIGRATION_EN)
var VOICE_SETTINGS_ZH = {
  settingsVoiceTab: '语音设置',
  voiceSettingsTitle: '语音服务', voiceSettingsIntro: '选择回复音色；生成试听只会在你点击后开始。',
  voiceProvider: '回复音色', voiceProviderWindows: 'Windows 系统语音', voiceProviderAliyun: '阿里云百炼',
  voiceProviderAvailability: '系统语音仅在本机 Windows Client 可用。', voiceLocalAvailable: '已检测到本机 Windows 系统音色。', voiceAliyunStreaming: '支持边生成边播放', voiceProviderAliyunDescription: '连接已配置的阿里云百炼语音服务。', voiceProviderWindowsDescription: '使用本机 Windows 系统语音；在其他平台可作为配置备选。', voiceModel: '云端音色模型', voiceModelFlash: '轻快自然', voiceModelPlus: '细腻表现',
  voiceRegion: '服务区域', voiceRegionBeijing: '中国（北京）', voiceRegionSingapore: '新加坡', voiceCredentialReady: '语音服务已连接', voiceCredentialMissing: '语音服务尚未配置，请联系维护人员。',
  voiceWorkspaceId: '阿里云业务空间 ID', voiceWorkspaceHint: '凭证由 DSH Host 环境提供；请勿在此输入密钥。', voiceWorkspaceInvalid: '请输入有效的业务空间 ID（3–128 位字母、数字、下划线或连字符）。', voiceSaveFirst: '草稿尚未保存；目录和试听针对当前草稿，保存后才影响对话。', voiceBoundProvider: '已保存的供应方', voiceOutputMode: '播放方式', voiceOutputStream: '边生成边播放', voiceOutputComplete: '生成完成后播放',
  voiceCatalogUnavailable: '音色目录暂不可用；设置表单仍可编辑。', voiceBrowseTitle: '浏览音色', voiceBrowseClose: '完成', voiceBrowseIntro: '按语言和名称查找当前模型可用音色。', voiceSearch: '搜索音色名称、ID 或特征', voiceLanguage: '语言', voiceAllLanguages: '全部语言', voiceNoMatches: '没有匹配音色。', voicePresetTitle: '提供方预设', voicePresetIntro: '选择要配置的语音服务。', voiceCloudCard: '云端服务', voiceLocalCard: '本机服务', voiceDraft: '正在编辑', voiceCurrent: '当前使用', voiceNotConfigured: '未配置', voicePreviewDraft: '试听使用当前配置草稿，不会启用或保存设置。', voiceLocalCheck: '检查本地配置', voiceLocalCheckDone: '本地配置项已检查；未向厂商发起连接或合成请求。', voiceLocalCheckMissing: '请补全工作空间并确认 Host 环境凭证后重试。', voiceCurrentTitle: '当前语音服务', voiceCurrentFallback: '沿用 Windows 系统语音', voicePreviewOpen: '生成试听',
  voiceOutputUnknown: '播放方式待确认', voiceConversationEmotionOn: '当前保存配置允许对话动态情绪表达。', voiceConfigureTitle: '提供方配置', voiceConfigureIntro: '配置当前选中的服务与音色。',
  voiceVoice: '音色', voiceNoVoices: '暂时没有可选音色。', voiceChoose: '选用', voiceSelected: '已选用', voiceManualVoice: '手动输入音色 ID', voiceManualVoiceHint: '输入当前服务和模型支持的音色 ID。', voiceEmotionSupported: '当前音色支持情绪表达。', voiceEmotionUnsupported: '当前音色使用默认表达。',
  voiceEmotionEnabled: '对话中已启用动态情绪表达。', voiceEmotionDisabled: '对话中未启用动态情绪表达。', voiceOfficialSample: '官方样音', voiceOfficialSource: '查看官方来源', voiceSampleUnavailable: '暂无可用官方样音',
  voicePreviewTitle: '试听', voicePreviewText: '试听内容', voicePreviewPlaceholder: '输入一小段文字试听音色', voicePreviewEmotion: '试听表达', voiceEmotionDefault: '默认',
  voiceEmotionExcited: '欣喜', voiceEmotionSad: '低落', voiceEmotionEmpathetic: '温柔', voiceEmotionSerious: '认真', voicePreviewRate: '语速',
  voicePreviewCost: '生成试听会使用云端语音服务并可能产生费用；只有点击生成后才会开始。', voicePreviewGenerate: '生成试听', voicePreviewStop: '停止试听', voicePreviewGenerating: '正在生成并播放…', voicePreviewDone: '试听播放完成。', voicePreviewCancelled: '试听已停止。',
  voiceSave: '保存语音设置', voiceSaved: '语音设置已保存。', voiceSaveFailed: '语音设置未保存，请重试。', voiceSettingsLoading: '正在读取语音设置…', voiceSettingsUnavailable: '语音设置暂不可用。', voiceSettingsCallActive: '请先结束语音通话，再保存设置。',
}
var VOICE_SETTINGS_EN = {
  settingsVoiceTab: 'Voice settings',
  voiceSettingsTitle: 'Voice services', voiceSettingsIntro: 'Choose a reply voice. A preview starts only when you request one.',
  voiceProvider: 'Reply voice', voiceProviderWindows: 'Windows system voice', voiceProviderAliyun: 'Alibaba Cloud Model Studio',
  voiceProviderAvailability: 'System speech is available only in the local Windows Client.', voiceLocalAvailable: 'Windows system voices are available on this device.', voiceAliyunStreaming: 'Streaming playback supported', voiceProviderAliyunDescription: 'Connect the configured Alibaba Cloud Model Studio speech service.', voiceProviderWindowsDescription: 'Use Windows system speech locally; it remains a fallback option on other platforms.', voiceModel: 'Cloud voice model', voiceModelFlash: 'Light and natural', voiceModelPlus: 'More expressive',
  voiceRegion: 'Service region', voiceRegionBeijing: 'China (Beijing)', voiceRegionSingapore: 'Singapore', voiceCredentialReady: 'Voice service is connected', voiceCredentialMissing: 'Voice service is not configured. Contact your administrator.',
  voiceWorkspaceId: 'Aliyun workspace ID', voiceWorkspaceHint: 'Credentials come from the DSH Host environment. Do not enter a secret here.', voiceWorkspaceInvalid: 'Enter a valid workspace ID (3–128 letters, numbers, underscores, or hyphens).', voiceSaveFirst: 'This draft is not saved. The catalog and preview use the draft; saving applies it to replies.', voiceBoundProvider: 'Saved provider', voiceOutputMode: 'Playback', voiceOutputStream: 'Stream while generating', voiceOutputComplete: 'Play after generation',
  voiceCatalogUnavailable: 'The voice catalog is unavailable. Settings can still be edited.', voiceBrowseTitle: 'Browse voices', voiceBrowseClose: 'Done', voiceBrowseIntro: 'Search voices available for the selected model.', voiceSearch: 'Search voice name, ID, or description', voiceLanguage: 'Language', voiceAllLanguages: 'All languages', voiceNoMatches: 'No voices match this search.', voicePresetTitle: 'Provider presets', voicePresetIntro: 'Choose a speech service to configure.', voiceCloudCard: 'Cloud service', voiceLocalCard: 'Local service', voiceDraft: 'Editing', voiceCurrent: 'In use', voiceNotConfigured: 'Not configured', voicePreviewDraft: 'Preview uses this configuration draft; it will not save or activate the settings.', voiceLocalCheck: 'Check local configuration', voiceLocalCheckDone: 'Local fields checked. No vendor connection or synthesis request was sent.', voiceLocalCheckMissing: 'Complete the workspace ID and confirm the Host environment credential.', voiceCurrentTitle: 'Current speech service', voiceCurrentFallback: 'Using Windows system voice', voicePreviewOpen: 'Generate preview',
  voiceOutputUnknown: 'Playback mode unconfirmed', voiceConversationEmotionOn: 'Dynamic conversation expression is enabled for the saved configuration.', voiceConfigureTitle: 'Provider configuration', voiceConfigureIntro: 'Configure the selected service and voice.',
  voiceVoice: 'Voice', voiceNoVoices: 'No voices are available yet.', voiceChoose: 'Select', voiceSelected: 'Selected', voiceManualVoice: 'Enter a voice ID manually', voiceManualVoiceHint: 'Enter a voice ID supported by the selected service and model.', voiceEmotionSupported: 'This voice supports expressive tags.', voiceEmotionUnsupported: 'This voice uses its default expression.',
  voiceEmotionEnabled: 'Dynamic expression is enabled in conversations.', voiceEmotionDisabled: 'Dynamic expression is not enabled in conversations.', voiceOfficialSample: 'Official sample', voiceOfficialSource: 'View official source', voiceSampleUnavailable: 'No official sample is available',
  voicePreviewTitle: 'Preview', voicePreviewText: 'Preview text', voicePreviewPlaceholder: 'Enter a short line to preview this voice', voicePreviewEmotion: 'Preview expression', voiceEmotionDefault: 'Default',
  voiceEmotionExcited: 'Excited', voiceEmotionSad: 'Sad', voiceEmotionEmpathetic: 'Gentle', voiceEmotionSerious: 'Serious', voicePreviewRate: 'Speaking rate',
  voicePreviewCost: 'A generated preview uses the cloud voice service and may incur charges. It starts only after you click Generate.', voicePreviewGenerate: 'Generate preview', voicePreviewStop: 'Stop preview', voicePreviewGenerating: 'Generating and playing…', voicePreviewDone: 'Preview playback finished.', voicePreviewCancelled: 'Preview stopped.',
  voiceSave: 'Save voice settings', voiceSaved: 'Voice settings saved.', voiceSaveFailed: 'Voice settings were not saved. Try again.', voiceSettingsLoading: 'Loading voice settings…', voiceSettingsUnavailable: 'Voice settings are unavailable.', voiceSettingsCallActive: 'End the voice call before saving settings.',
}
Object.assign(zh, VOICE_SETTINGS_ZH)
Object.assign(en, VOICE_SETTINGS_EN)

function createVoiceSettings(t) {
  return function VoiceSettings(props) {
    var controllerPair = React.useState(null), controller = controllerPair[0], setController = controllerPair[1]
    var dataPair = React.useState({ loading: true, settings: null, voices: [], error: false }), data = dataPair[0], setData = dataPair[1]
    var draftPair = React.useState(null), draft = draftPair[0], setDraft = draftPair[1]
    var busyPair = React.useState(false), busy = busyPair[0], setBusy = busyPair[1]
    var notePair = React.useState(''), note = notePair[0], setNote = notePair[1]
    var previewPair = React.useState({ active: false, text: '' }), preview = previewPair[0], setPreview = previewPair[1]
    var searchPair = React.useState(''), search = searchPair[0], setSearch = searchPair[1]
    var languagePair = React.useState('all'), language = languagePair[0], setLanguage = languagePair[1]
    var reloadPair = React.useState(0), catalogReload = reloadPair[0], setCatalogReload = reloadPair[1]
    var generationRef = React.useRef(0)
    var catalogGenerationRef = React.useRef(0)
    var dialogRef = React.useRef(null)
    var active = props?.active !== false
    React.useEffect(function () {
      if (typeof fishChat === 'undefined' || !fishChat || typeof fishChat.onVoiceController !== 'function') return undefined
      return fishChat.onVoiceController(setController)
    }, [])
    React.useEffect(function () {
      var alive = true
      setData({ loading: true, settings: null, voices: [], error: false })
      if (!controller) { setData({ loading: false, settings: null, voices: [], error: true }); return function () { alive = false } }
      controller.readVoiceSettings().then(function (settings) {
        if (!alive) return
        settings = settings || {}
        setData({ loading: false, settings: settings, voices: [], catalog: null, catalogLoading: false, catalogUnavailable: false, error: false })
        setDraft(JSON.parse(JSON.stringify(settings.tts || {})))
      }).catch(function () { if (alive) setData({ loading: false, settings: null, voices: [], error: true }) })
      return function () { alive = false; generationRef.current += 1; try { controller.stopVoicePreview() } catch (_) {} }
    }, [controller])
    React.useEffect(function () {
      if (!controller || !draft || !data.settings) return undefined
      var generation = ++catalogGenerationRef.current
      var requestKey = catalogKey(draft)
      setData(function (old) { return Object.assign({}, old, { voices: [], catalog: null, catalogKey: requestKey, catalogLoading: true, catalogUnavailable: false }) })
      loadCatalog(draft).then(function (catalog) {
        if (generation !== catalogGenerationRef.current) return
        setData(function (old) { return Object.assign({}, old, { voices: catalog.voices || [], catalog: catalog, catalogKey: requestKey, catalogLoading: false, catalogUnavailable: catalog.unavailable === true }) })
      }).catch(function () {
        if (generation === catalogGenerationRef.current) setData(function (old) { return Object.assign({}, old, { voices: [], catalog: null, catalogKey: requestKey, catalogLoading: false, catalogUnavailable: true }) })
      })
      return function () { if (generation === catalogGenerationRef.current) catalogGenerationRef.current += 1 }
    }, [controller, draft?.providerId, draft?.modelId, draft?.region, draft?.workspaceId, data.settings, catalogReload])
    React.useEffect(function () {
      if (active) return
      if (preview.active) stopPreview()
      if (dialogRef.current?.open) dialogRef.current.close()
    }, [active, controller, preview.active])
    function patch(next) {
      setDraft(function (old) { return Object.assign({}, old || {}, next) })
      setNote('')
    }
    function providerId() { return draft?.providerId || 'windows-system-speech' }
    function voiceId(voice) { return voice?.voiceId || voice?.id || '' }
    function chooseProvider(id) {
      if (id === providerId()) return
      if (preview.active) stopPreview()
      if (id === 'aliyun-qwen-tts') patch({ providerId: id, voiceId: null, credentialRef: 'DASHSCOPE_API_KEY', modelId: draft?.modelId || 'qwen-audio-3.1-tts-flash', region: draft?.region || 'cn-beijing' })
      else patch({ providerId: 'windows-system-speech', voiceId: null, credentialRef: null, workspaceId: '' })
    }
    function catalogKey(tts) { return [tts?.providerId || 'windows-system-speech', tts?.modelId || '', tts?.region || '', validWorkspace(tts) ? tts.workspaceId : ''].join('|') }
    function validWorkspace(tts) { return /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(String(tts?.workspaceId || '')) }
    function makeBinding(tts) {
      return { providerId: tts?.providerId || 'windows-system-speech', modelId: tts?.modelId || 'qwen-audio-3.1-tts-flash', region: tts?.region || 'cn-beijing', workspaceId: tts?.workspaceId || '', credentialRef: tts?.providerId === 'aliyun-qwen-tts' ? 'DASHSCOPE_API_KEY' : null }
    }
    async function loadCatalog(tts) {
      if (tts?.providerId === 'aliyun-qwen-tts') {
        var binding = makeBinding(tts)
        if (!validWorkspace(tts)) binding.workspaceId = ''
        var catalog = await controller.getVoicePreviewCatalog(binding)
        return Object.assign({}, catalog, { voices: Array.isArray(catalog?.voices) ? catalog.voices : [], unavailable: false })
      }
      var localVoices = controller.getVoiceVoices?.() || []
      return { providerId: 'windows-system-speech', voices: Array.isArray(localVoices) ? localVoices : [], audioOutput: 'complete', emotionTags: [], credentialConfigured: false, workspaceConfigured: true, localAvailable: Array.isArray(localVoices) && localVoices.length > 0, unavailable: false }
    }
    function isDirty() {
      if (!draft || !data.settings?.tts) return false
      var defaults = { providerId: 'windows-system-speech', modelId: 'qwen-audio-3.1-tts-flash', region: 'cn-beijing', workspaceId: '', credentialRef: null, voiceId: null, rate: 0 }
      return Object.keys(defaults).some(function (key) { return (draft[key] ?? defaults[key]) !== (data.settings.tts[key] ?? defaults[key]) })
    }
    function safeOfficialUrl(value) {
      try {
        var url = new URL(value)
        return url.protocol === 'https:' && /(^|\.)(aliyun\.com|alicdn\.com|aliyuncs\.com)$/i.test(url.hostname) ? url.href : ''
      } catch (_) { return '' }
    }
    function stopPreview() {
      generationRef.current += 1
      controller?.stopVoicePreview?.()
      setPreview(function (old) { return Object.assign({}, old, { active: false }) })
      setNote(t('voicePreviewCancelled'))
    }
    function openVoiceBrowser() {
      if (!catalogReady || !dialogRef.current) return
      setSearch('')
      setLanguage('all')
      dialogRef.current.showModal()
    }
    function closeVoiceBrowser() {
      if (preview.active) stopPreview()
      dialogRef.current?.close()
    }
    async function save() {
      if (!controller || !draft) return
      if (providerId() === 'aliyun-qwen-tts' && !validWorkspace(draft)) { setNote(t('voiceWorkspaceInvalid')); return }
      setBusy(true); setNote('')
      try {
        var payload = Object.assign({}, draft, { credentialRef: providerId() === 'aliyun-qwen-tts' ? 'DASHSCOPE_API_KEY' : null })
        var result = await controller.updateVoiceSettings(payload)
        setData(function (old) { return Object.assign({}, old, { loading: false, settings: result, voices: [], catalog: null, catalogLoading: true, catalogUnavailable: false, error: false }) })
        setDraft(JSON.parse(JSON.stringify(result.tts || payload)))
        setCatalogReload(function (old) { return old + 1 })
        setNote(t('voiceSaved'))
      } catch (error) { setNote(error?.code === 'VOICE_CONFIG_CALL_ACTIVE' ? t('voiceSettingsCallActive') : t('voiceSaveFailed')) }
      finally { setBusy(false) }
    }
    async function generatePreview() {
      if (!controller) return
      if (preview.active) { stopPreview(); return }
      if (providerId() !== 'aliyun-qwen-tts' || !validWorkspace(draft) || data.catalog?.credentialConfigured !== true || !draft.voiceId || !preview.text.trim()) return
      var generation = ++generationRef.current
      setPreview(function (old) { return Object.assign({}, old, { active: true }) }); setNote(t('voicePreviewGenerating'))
      try {
        await controller.playVoicePreview({ binding: makeBinding(draft), voiceId: draft.voiceId, text: preview.text.trim(), rate: preview.rate ?? draft.rate ?? 0, emotionTag: preview.emotionTag || undefined })
        if (generation === generationRef.current) { setPreview(function (old) { return Object.assign({}, old, { active: false }) }); setNote(t('voicePreviewDone')) }
      } catch (_) { if (generation === generationRef.current) { setPreview(function (old) { return Object.assign({}, old, { active: false }) }); setNote(t('voiceSettingsUnavailable')) } }
    }
    var settings = data.settings || {}, aliyun = providerId() === 'aliyun-qwen-tts'
    var voices = data.voices
    var dirty = isDirty(), catalogReady = catalogKey(draft) === data.catalogKey && !data.catalogLoading, catalogLoading = data.catalogLoading === true && !catalogReady, workspaceInvalid = aliyun && !validWorkspace(draft)
    var catalog = data.catalog || {}, emotionTags = Array.isArray(catalog.emotionTags) ? catalog.emotionTags : []
    var filteredVoices = voices.filter(function (voice) { var text = [voice.name, voice.id, voice.language, voice.description].filter(Boolean).join(' ').toLowerCase(); return (!search || text.includes(search.toLowerCase())) && (language === 'all' || voice.language === language) })
    function outputLabel(output) { return output === 'stream' ? t('voiceOutputStream') : output === 'complete' ? t('voiceOutputComplete') : t('voiceOutputUnknown') }
    function providerCard(id, title, description, kind) {
      var selected = providerId() === id
      var current = settings.tts?.providerId === id
      var capability = id === 'aliyun-qwen-tts' ? t('voiceAliyunStreaming') : ''
      return h('button', { type: 'button', className: 'voice-provider-card' + (selected ? ' selected' : ''), key: id, 'aria-pressed': selected, onClick: function () { chooseProvider(id) } },
        h('div', { className: 'voice-provider-top' }, h('span', { className: 'voice-provider-mark', 'aria-hidden': 'true' }, id === 'aliyun-qwen-tts' ? 'Q' : 'W'), h('span', { className: 'voice-provider-kind' }, t(kind)),
          h('span', { className: 'voice-provider-status' }, current ? t('voiceCurrent') : selected ? t('voiceDraft') : t('voiceNotConfigured'))),
        h('h3', null, t(title)), h('p', { className: 'voice-provider-description' }, t(description)),
        capability && h('span', { className: 'voice-capability-badge' }, capability),
        h('span', { className: 'voice-configure-label' }, selected ? t('voiceSelected') : t('voiceChoose')))
    }
    function renderVoice(voice) {
      var id = voiceId(voice), sampleUrl = safeOfficialUrl(voice.sample), sourceUrl = safeOfficialUrl(voice.source) || (aliyun ? officialVoiceUrl : '')
      return h('article', { className: 'voice-catalog-row' + (id === draft.voiceId ? ' chosen' : ''), key: id },
        h('div', { className: 'voice-catalog-heading' }, h('strong', null, voice.name || voice.label || id), voice.language && h('span', { className: 'voice-language-badge' }, voice.language)),
        h('p', null, voice.description || id),
        h('div', { className: 'voice-row-actions' },
          sampleUrl ? h('a', { href: sampleUrl, target: '_blank', rel: 'noopener noreferrer', onClick: function () { if (preview.active) stopPreview() } }, t('voiceOfficialSample')) : h('span', { className: 'voice-muted' }, t('voiceSampleUnavailable')),
          sourceUrl && h('a', { href: sourceUrl, target: '_blank', rel: 'noopener noreferrer', onClick: function () { if (preview.active) stopPreview() } }, t('voiceOfficialSource')),
          h('button', { type: 'button', disabled: id === draft.voiceId, onClick: function () { if (preview.active) stopPreview(); patch({ voiceId: id }) } }, id === draft.voiceId ? t('voiceSelected') : t('voiceChoose'))))
    }
    var officialVoiceUrl = 'https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list'
    var selectedVoice = voices.find(function (voice) { return voiceId(voice) === draft?.voiceId })
    var selectedSampleUrl = safeOfficialUrl(selectedVoice?.sample)
    var selectedSourceUrl = safeOfficialUrl(selectedVoice?.source) || (aliyun ? officialVoiceUrl : '')
    var currentProvider = settings.tts?.providerId === 'aliyun-qwen-tts' ? t('voiceProviderAliyun') : t('voiceProviderWindows')
    var currentModel = settings.tts?.providerId === 'aliyun-qwen-tts' ? (settings.tts?.modelId || 'Qwen TTS') : t('voiceProviderAvailability')
    var currentRegion = settings.tts?.providerId === 'aliyun-qwen-tts' ? (settings.tts?.region || '') : ''
    var providerMode = settings.capabilities?.audioOutput === 'stream' ? t('voiceOutputStream') : settings.capabilities?.audioOutput === 'complete' ? t('voiceOutputComplete') : t('voiceOutputUnknown')
    var previewDisabled = preview.active ? false : providerId() !== 'aliyun-qwen-tts' || !validWorkspace(draft) || catalog.credentialConfigured !== true || !draft?.voiceId || !preview.text.trim()
    var voiceSettingsCss = `
      .cf-voice-settings { margin: 28px 0 36px; color: var(--dsw-alias-label-primary, #243b5e); }
      .cf-voice-settings * { box-sizing: border-box; }
      .cf-voice-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
      .cf-voice-heading h2 { margin: 0 0 4px; font-size: 25px; line-height: 1.35; }
      .cf-voice-heading p { margin: 0; color: var(--dsw-alias-label-secondary, #71849a); }
      .cf-voice-eyebrow { margin-bottom: 5px !important; color: #7890a9; font-size: 10px; letter-spacing: 1.5px; }
      .cf-voice-current { display: flex; align-items: center; gap: 13px; margin-bottom: 20px; padding: 14px 17px; border: 1px solid #d5e5f5; border-radius: 12px; background: #eaf3fd; }
      .cf-voice-current-mark { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 11px; background: #fff; color: #316da9; font-size: 20px; }
      .cf-voice-current-main { flex: 1; min-width: 0; }
      .cf-voice-current-main strong { display: block; }
      .cf-voice-current-main p { margin: 2px 0 0; color: #62758c; font-size: 12px; }
      .cf-voice-current-badge, .voice-capability-badge, .voice-language-badge { border-radius: 6px; background: #fff; color: #456c93; font-size: 10px; padding: 3px 8px; white-space: nowrap; }
      .cf-voice-layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr); gap: 18px; align-items: start; }
      .cf-voice-left, .cf-voice-right { display: grid; min-width: 0; gap: 16px; }
      .cf-voice-panel { min-width: 0; padding: 17px; border: 1px solid var(--dsw-alias-border-l1, #dbe5ef); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }
      .cf-voice-section-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
      .cf-voice-section-head h3, .cf-voice-panel h3 { margin: 0 0 3px; font-size: 16px; }
      .cf-voice-section-head p, .cf-voice-panel .voice-muted { margin: 0; color: #71849a; font-size: 12px; }
      .cf-voice-provider-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .voice-provider-card { width: 100%; min-width: 0; padding: 13px; border: 1px solid #dfe9f3; border-radius: 11px; color: inherit; text-align: left; }
      .cf-voice-settings .voice-provider-card { white-space: normal; overflow-wrap: anywhere; }
      .voice-provider-card.selected { padding: 12px; border: 2px solid #5687b8; box-shadow: 0 2px 10px #316da90c; }
      .voice-provider-top { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: 9px; }
      .voice-provider-mark { display: grid; flex: none; width: 28px; height: 28px; place-items: center; border-radius: 8px; background: #eaf3fd; color: #3f75a9; font-weight: 700; }
      .voice-provider-kind, .voice-provider-status { min-width: 0; color: #62758c; font-size: 10px; }
      .voice-provider-status { margin-left: auto; color: #316da9; }
      .voice-provider-card h3 { margin: 0 0 4px; font-size: 14px; }
      .voice-provider-description { min-height: 32px; margin: 0 0 9px; color: #62758c; font-size: 11px; }
      .voice-provider-card .voice-capability-badge { display: inline-block; max-width: 100%; background: #eff6fd; white-space: normal; }
      .voice-configure-label { display: block; margin-top: 10px; padding-top: 9px; border-top: 1px solid #edf2f8; color: #316da9; font-size: 11px; font-weight: 600; }
      .cf-voice-catalog-tools { display: grid; grid-template-columns: minmax(0, 1fr) 130px; gap: 8px; margin-bottom: 12px; }
      .cf-voice-settings input, .cf-voice-settings select, .cf-voice-settings textarea { width: 100%; padding: 9px 11px; border: 1px solid #d7e3ee; border-radius: 8px; background: #fff; color: inherit; font: inherit; }
      .cf-voice-catalog-list { display: grid; max-height: 360px; overflow: auto; gap: 8px; }
      .voice-catalog-row { padding: 11px; border: 1px solid #dfe9f3; border-radius: 9px; }
      .voice-catalog-row.chosen { border-color: #83a9ce; background: #f4f8fd; }
      .voice-catalog-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .voice-catalog-heading strong { font-size: 12px; }
      .voice-language-badge { padding: 2px 6px; background: #eff6fd; }
      .voice-catalog-row p { margin: 4px 0 8px; color: #71849a; font-size: 11px; overflow-wrap: anywhere; }
      .voice-row-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11px; }
      .voice-row-actions a { color: #316da9; }
      .voice-row-actions button { min-height: 29px; margin-left: auto; padding: 4px 10px; font-size: 11px; }
      .cf-voice-config label, .cf-voice-audition label { display: grid; gap: 5px; margin: 11px 0; font-size: 12px; font-weight: 600; }
      .cf-voice-config .voice-help, .cf-voice-audition .voice-help { margin: 5px 0; color: #62758c; font-size: 11px; line-height: 1.7; }
      .cf-voice-config .voice-status { padding: 8px 10px; border-radius: 7px; background: #f3f7fc; color: #536e88; font-size: 11px; line-height: 1.6; }
      .cf-voice-config .voice-grid, .cf-voice-audition .voice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .cf-voice-selection { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 8px; }
      .cf-voice-selection button { margin-bottom: 0; }
      .cf-voice-selected-summary { display: grid; min-width: 0; gap: 4px; padding: 7px 0; }
      .cf-voice-selected-summary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cf-voice-manual { margin-top: 10px; color: #536e88; font-size: 11px; }
      .cf-voice-manual summary { cursor: pointer; }
      .cf-voice-manual label { margin-bottom: 4px; }
      .cf-voice-audition { background: #f3f7fc; }
      .cf-voice-audition textarea { min-height: 72px; resize: vertical; }
      .cf-voice-audition .voice-cost { margin: 9px 0; color: #546e89; font-size: 11px; line-height: 1.7; }
      .cf-voice-audition button.primary { width: 100%; }
      .cf-voice-savebar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 17px; padding-top: 14px; border-top: 1px solid #e7eff8; }
      .cf-voice-savebar p { margin: 0; color: #62758c; font-size: 11px; line-height: 1.6; }
      .cf-voice-savebar .voice-actions { display: flex; flex: none; gap: 8px; }
      .cf-voice-settings button { padding: 7px 11px; border: 1px solid #d7e3ee; border-radius: 8px; background: #fff; color: #315278; font: inherit; cursor: pointer; }
      .cf-voice-settings button:hover:not(:disabled), .cf-voice-settings a:hover { border-color: #a9c6e4; background: #f2f7fd; }
      .cf-voice-settings button.primary { border-color: #316da9; background: #316da9; color: #fff; }
      .cf-voice-settings button:disabled { opacity: .5; cursor: default; }
      .cf-voice-settings :focus-visible { outline: 3px solid #79a9d9; outline-offset: 2px; }
      .cf-voice-dialog { width: min(930px, calc(100vw - 32px)); max-width: 930px; max-height: 92dvh; overflow: auto; padding: 24px; border: 1px solid #dfe9f3; border-radius: 16px; color: #243b5e; box-shadow: 0 20px 80px #1c3e6230; }
      .cf-voice-dialog::backdrop { background: #18324d52; }
      .cf-voice-dialog-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 16px; }
      .cf-voice-dialog-head > button { flex: none; white-space: nowrap; }
      .cf-voice-dialog-head h3 { margin: 0 0 4px; font-size: 20px; }
      .cf-voice-dialog-context { display: flex; gap: 10px; margin-bottom: 14px; color: #62758c; font-size: 12px; }
      .cf-voice-dialog-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 18px; }
      .cf-voice-dialog-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
      .cf-voice-dialog-catalog { min-width: 0; }
      .cf-voice-selected { display: grid; gap: 6px; margin-bottom: 12px; padding: 11px; border: 1px solid #dfe9f3; border-radius: 9px; background: #fff; font-size: 12px; }
      .cf-voice-selected .voice-help { margin: 0; color: #62758c; }
      .cf-voice-selected a { color: #316da9; font-size: 11px; }
      .cf-voice-audition { align-self: start; padding: 16px; border: 1px solid #dfe9f3; border-radius: 11px; }
      @media (max-width: 900px) { .cf-voice-layout { grid-template-columns: 1fr; } .cf-voice-catalog-list { max-height: 280px; } }
      @media (max-width: 650px) { .cf-voice-heading { align-items: flex-start; flex-direction: column; } .cf-voice-heading h2 { font-size: 21px; } .cf-voice-provider-list { grid-template-columns: 1fr; } .cf-voice-catalog-tools { grid-template-columns: 1fr; } .cf-voice-panel { padding: 14px; } .cf-voice-current { padding: 11px; } .cf-voice-current-badge { display: none; } .cf-voice-savebar { align-items: flex-start; flex-direction: column; } .cf-voice-savebar .voice-actions { width: 100%; } .cf-voice-savebar .voice-actions button { flex: 1; } .cf-voice-config .voice-grid, .cf-voice-audition .voice-grid, .cf-voice-dialog-layout { grid-template-columns: 1fr; } }
    `
    var languageOptions = Array.from(new Set(voices.map(function (voice) { return voice.language }).filter(Boolean))).map(function (item) {
      return h('option', { key: item, value: item }, item)
    })
    var previewControls = h('div', { className: 'voice-grid' },
      h('label', null, t('voicePreviewEmotion'), h('select', {
        value: preview.emotionTag || '',
        onChange: function (event) { if (preview.active) stopPreview(); setPreview(function (old) { return Object.assign({}, old, { emotionTag: event.target.value }) }) },
      }, h('option', { value: '' }, t('voiceEmotionDefault')), emotionTags.map(function (tag) {
        var key = ({ excited: 'voiceEmotionExcited', sad: 'voiceEmotionSad', empathetic: 'voiceEmotionEmpathetic', serious: 'voiceEmotionSerious' })[tag]
        return h('option', { key: tag, value: tag }, key ? t(key) : tag)
      }))),
      h('label', null, t('voicePreviewRate'), h('input', {
        type: 'range', min: -10, max: 10, step: 1, value: preview.rate ?? draft?.rate ?? 0,
        onChange: function (event) { if (preview.active) stopPreview(); setPreview(function (old) { return Object.assign({}, old, { rate: Number(event.target.value) }) }) },
      })))
    var voiceDialog = h('dialog', {
      ref: dialogRef,
      className: 'cf-voice-dialog',
      'aria-labelledby': 'cf-voice-dialog-title',
      onCancel: function (event) { event.preventDefault(); closeVoiceBrowser() },
      onClose: function () { if (active && preview.active) stopPreview() },
    },
    h('div', { className: 'cf-voice-dialog-head' },
      h('div', null,
        h('h3', { id: 'cf-voice-dialog-title' }, t('voiceBrowseTitle')),
        h('p', { className: 'voice-muted' }, t('voiceBrowseIntro'))),
      h('button', { type: 'button', 'aria-label': t('migrationCancel'), onClick: closeVoiceBrowser }, t('migrationCancel'))),
    h('div', { className: 'cf-voice-dialog-context' },
      h('strong', null, aliyun ? t('voiceProviderAliyun') : t('voiceProviderWindows')),
      aliyun && h('span', null, draft?.modelId || 'qwen-audio-3.1-tts-flash')),
    h('div', { className: 'cf-voice-dialog-layout' },
      h('section', { className: 'cf-voice-dialog-catalog', 'aria-label': t('voiceBrowseTitle') },
        h('div', { className: 'cf-voice-catalog-tools' },
          h('input', { type: 'search', value: search, placeholder: t('voiceSearch'), 'aria-label': t('voiceSearch'), onChange: function (event) { setSearch(event.target.value) } }),
          h('select', { value: language, 'aria-label': t('voiceLanguage'), onChange: function (event) { setLanguage(event.target.value) } },
            h('option', { value: 'all' }, t('voiceAllLanguages')), languageOptions)),
        catalogLoading && h('p', { className: 'voice-muted', role: 'status' }, t('voiceSettingsLoading')),
        !catalogLoading && data.catalogUnavailable && h('p', { className: 'voice-muted', role: 'status' }, t('voiceCatalogUnavailable')),
        catalogReady && !data.catalogUnavailable && h('div', { className: 'cf-voice-catalog-list' },
          filteredVoices.length ? filteredVoices.map(renderVoice) : h('p', { className: 'voice-muted' }, t('voiceNoMatches')))),
      aliyun && h('section', { className: 'cf-voice-audition', 'aria-label': t('voicePreviewTitle') },
        h('div', { className: 'cf-voice-section-head' },
          h('div', null,
            h('h3', null, t('voicePreviewTitle')),
            h('p', null, t('voicePreviewDraft')))),
        h('div', { className: 'cf-voice-selected' },
          h('strong', null, selectedVoice?.name || draft?.voiceId || t('voiceNoVoices')),
          selectedVoice?.language && h('span', { className: 'voice-language-badge' }, selectedVoice.language),
          selectedVoice?.description && h('p', { className: 'voice-help' }, selectedVoice.description),
          selectedSampleUrl ? h('a', { href: selectedSampleUrl, target: '_blank', rel: 'noopener noreferrer', onClick: function () { if (preview.active) stopPreview() } }, t('voiceOfficialSample')) : h('span', { className: 'voice-help' }, t('voiceSampleUnavailable')),
          selectedSourceUrl && h('a', { href: selectedSourceUrl, target: '_blank', rel: 'noopener noreferrer', onClick: function () { if (preview.active) stopPreview() } }, t('voiceOfficialSource'))),
        h('label', null, t('voicePreviewText'), h('textarea', {
          maxLength: 120,
          value: preview.text,
          placeholder: t('voicePreviewPlaceholder'),
          onChange: function (event) { if (preview.active) stopPreview(); setPreview(function (old) { return Object.assign({}, old, { text: event.target.value }) }) },
        })),
        previewControls,
        h('p', { className: 'voice-cost' }, t('voicePreviewCost')),
        preview.active && h('p', { className: 'voice-status', role: 'status' }, t('voicePreviewGenerating')),
        h('button', { type: 'button', className: 'primary', disabled: previewDisabled, onClick: generatePreview }, preview.active ? t('voicePreviewStop') : t('voicePreviewOpen'))),
    h('div', { className: 'cf-voice-dialog-footer' },
      note && h('p', { className: 'voice-status', role: 'status' }, note),
      h('button', { type: 'button', onClick: closeVoiceBrowser }, t('voiceBrowseClose')))))

    return h('section', { className: 'cf-voice-settings' },
      h('style', null, voiceSettingsCss),
      data.loading ? h('p', { role: 'status' }, t('voiceSettingsLoading')) :
        data.error || !draft ? h('p', { role: 'status' }, t('voiceSettingsUnavailable')) :
          h(React.Fragment, null,
            h('header', { className: 'cf-voice-heading' },
              h('div', null,
                h('h2', null, t('voiceSettingsTitle')),
                h('p', null, t('voiceSettingsIntro')))),
            h('section', { className: 'cf-voice-current', 'aria-label': t('voiceCurrentTitle') },
              h('span', { className: 'cf-voice-current-mark', 'aria-hidden': 'true' }, '♫'),
              h('div', { className: 'cf-voice-current-main' },
                h('strong', null, t('voiceCurrentTitle') + ': ' + currentProvider),
                h('p', null, [currentModel, currentRegion, providerMode].filter(Boolean).join(' · ')),
                h('p', null, settings.tts?.providerId === 'aliyun-qwen-tts'
                  ? (settings.credentialConfigured ? t('voiceCredentialReady') : t('voiceCredentialMissing'))
                  : ((controller?.getVoiceVoices?.() || []).length ? t('voiceLocalAvailable') : t('voiceProviderAvailability')))),
              h('span', { className: 'cf-voice-current-badge' }, t('voiceCurrent'))),
            h('div', { className: 'cf-voice-layout' },
              h('section', { className: 'cf-voice-panel' },
                h('div', { className: 'cf-voice-section-head' },
                  h('div', null, h('h3', null, t('voicePresetTitle')), h('p', null, t('voicePresetIntro')))),
                h('div', { className: 'cf-voice-provider-list' },
                  providerCard('aliyun-qwen-tts', 'voiceProviderAliyun', 'voiceProviderAliyunDescription', 'voiceCloudCard'),
                  providerCard('windows-system-speech', 'voiceProviderWindows', 'voiceProviderWindowsDescription', 'voiceLocalCard'))),
              h('section', { className: 'cf-voice-panel cf-voice-config' },
                h('div', { className: 'cf-voice-section-head' },
                  h('div', null, h('h3', null, t('voiceConfigureTitle')), h('p', null, t('voiceConfigureIntro')))),
                aliyun && h('div', { className: 'voice-grid' },
                  h('label', null, t('voiceModel'), h('select', {
                    value: draft.modelId || 'qwen-audio-3.1-tts-flash',
                    onChange: function (event) { if (preview.active) stopPreview(); patch({ modelId: event.target.value, voiceId: null }) },
                  }, h('option', { value: 'qwen-audio-3.1-tts-flash' }, t('voiceModelFlash')), h('option', { value: 'qwen-audio-3.1-tts-plus' }, t('voiceModelPlus')))),
                  h('label', null, t('voiceRegion'), h('select', {
                    value: draft.region || 'cn-beijing',
                    onChange: function (event) { if (preview.active) stopPreview(); patch({ region: event.target.value, voiceId: null }) },
                  }, h('option', { value: 'cn-beijing' }, t('voiceRegionBeijing')), h('option', { value: 'ap-southeast-1' }, t('voiceRegionSingapore'))))),
                aliyun && h('label', null, t('voiceWorkspaceId'), h('input', {
                  type: 'text', autoComplete: 'off', maxLength: 128, 'aria-invalid': workspaceInvalid,
                  value: draft.workspaceId || '',
                  onChange: function (event) { if (preview.active) stopPreview(); patch({ workspaceId: event.target.value, credentialRef: 'DASHSCOPE_API_KEY' }) },
                })),
                aliyun && h('p', { className: 'voice-help' }, t('voiceWorkspaceHint')),
                workspaceInvalid && h('p', { className: 'voice-status', role: 'alert' }, t('voiceWorkspaceInvalid')),
                h('div', { className: 'cf-voice-selection' },
                  h('div', { className: 'cf-voice-selected-summary' },
                    h('span', { className: 'voice-muted' }, t('voiceVoice')),
                    h('strong', null, selectedVoice?.name || draft.voiceId || t('voiceNoVoices')),
                    selectedVoice?.language && h('span', { className: 'voice-language-badge' }, selectedVoice.language)),
                  h('button', { type: 'button', disabled: !catalogReady, onClick: openVoiceBrowser }, t('voiceBrowseTitle'))),
                aliyun && h('details', { className: 'cf-voice-manual' },
                  h('summary', null, t('voiceManualVoice')),
                  h('label', null, t('voiceManualVoice'), h('input', {
                    type: 'text', autoComplete: 'off', maxLength: 128, value: draft.voiceId || '',
                    onChange: function (event) { if (preview.active) stopPreview(); patch({ voiceId: event.target.value.trim() || null }) },
                  })),
                  h('p', { className: 'voice-help' }, t('voiceManualVoiceHint'))),
                catalogLoading && h('p', { className: 'voice-help', role: 'status' }, t('voiceSettingsLoading')),
                !catalogLoading && data.catalogUnavailable && h('p', { className: 'voice-status', role: 'status' }, t('voiceCatalogUnavailable')),
                catalogReady && h('p', { className: 'voice-status' }, aliyun
                  ? (catalog.credentialConfigured ? t('voiceCredentialReady') : t('voiceCredentialMissing')) + ' · ' + outputLabel(catalog.audioOutput)
                  : (catalog.localAvailable ? t('voiceLocalAvailable') : t('voiceProviderAvailability'))),
                catalogReady && aliyun && emotionTags.length > 0 && h('p', { className: 'voice-help' }, t('voiceEmotionSupported')),
                settings.capabilities?.conversationEmotionEnabled === true && !dirty && h('p', { className: 'voice-help' }, t('voiceConversationEmotionOn')),
                dirty && h('p', { className: 'voice-help', role: 'status' }, t('voicePreviewDraft')),
                note && h('p', { className: 'voice-status', role: 'status' }, note))),
            h('div', { className: 'cf-voice-savebar' },
              h('p', null, dirty ? t('voiceSaveFirst') : t('voiceSaved')),
              h('div', { className: 'voice-actions' },
                h('button', { type: 'button', disabled: busy || workspaceInvalid, onClick: function () {
                  if (providerId() === 'aliyun-qwen-tts' && (workspaceInvalid || catalog.credentialConfigured !== true)) { setNote(t('voiceLocalCheckMissing')); return }
                  setNote(t('voiceLocalCheckDone'))
                } }, t('voiceLocalCheck')),
                h('button', { type: 'button', className: 'primary', disabled: busy || workspaceInvalid, onClick: save }, t('voiceSave')))),
            voiceDialog))
  }
}
var SETTINGS_TABS_CSS = `
  .cf-migration .settings-heading { border-bottom: 0; padding-bottom: 0; margin-bottom: 16px; }
  .cf-migration .settings-tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #dbe5ef); }
  .cf-migration .settings-tabs button { padding: 8px 12px; min-width: 0; border-color: transparent; border-bottom-width: 2px; border-radius: 8px 8px 0 0; background: transparent; white-space: normal; }
  .cf-migration .settings-tabs button[aria-selected="true"] { border-bottom-color: var(--dsw-alias-brand-primary, #316da9); background: #edf5ff; color: var(--dsw-alias-brand-primary, #316da9); }
  .cf-migration .settings-tabpanel { padding-top: 24px; }
  .cf-migration .settings-tabpanel > :first-child { margin-top: 0; }
`
var settingsPageSerial = 0
function createMigrationSettings(t, options) {
  var importOnly = options?.importOnly === true
  var VoiceSettings = createVoiceSettings(t)
  var tabs = ['voice', 'transfer']
  var tabLabels = { voice: 'settingsVoiceTab', transfer: 'migrationTitle' }
  return function MigrationSettings(props) {
    var endpoint = (window.__CHONKYFISH_STATE__?.routes || RESOURCES.routes)
    var exportUrl = endpoint.migrationExport || RESOURCES.routes.migrationExport
    var inspectUrl = endpoint.migrationImportInspect || RESOURCES.routes.migrationImportInspect
    var commitUrl = endpoint.migrationImportCommit || RESOURCES.routes.migrationImportCommit
    var cancelUrl = endpoint.migrationImportCancel || RESOURCES.routes.migrationImportCancel
    var fileRef = React.useRef(null)
    var statePair = React.useState({ busy: false, exportId: null, preview: null, message: '', error: false })
    var state = statePair[0], setState = statePair[1]
    var tabPair = React.useState('voice'), selectedTab = tabPair[0], setSelectedTab = tabPair[1]
    var tabRefs = React.useRef({}), pageId = React.useRef(null)
    if (!importOnly && !pageId.current) pageId.current = 'cf-settings-' + (++settingsPageSerial)
    function tabId(tab) { return pageId.current + '-' + tab + '-tab' }
    function panelId(tab) { return pageId.current + '-' + tab + '-panel' }
    function tabKey(event, tab) {
      var next
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = tab === 'voice' ? 'transfer' : 'voice'
      if (event.key === 'Home') next = tabs[0]
      if (event.key === 'End') next = tabs[tabs.length - 1]
      if (next) {
        event.preventDefault()
        setSelectedTab(next)
        tabRefs.current[next]?.focus()
      }
    }
    function renderTab(tab) {
      var selected = tab === selectedTab
      return h('button', { key: tab, type: 'button', role: 'tab', id: tabId(tab),
        'aria-controls': panelId(tab), 'aria-selected': selected, tabIndex: selected ? 0 : -1,
        ref: function (node) { tabRefs.current[tab] = node },
        onClick: function () { setSelectedTab(tab) }, onKeyDown: function (event) { tabKey(event, tab) },
      }, t(tabLabels[tab]))
    }
    function renderPanel(tab, content) {
      return h('section', { className: 'settings-tabpanel', role: 'tabpanel', id: panelId(tab),
        'aria-labelledby': tabId(tab), hidden: tab !== selectedTab, tabIndex: 0,
      }, content)
    }
    function update(patch) { setState(function (old) { return Object.assign({}, old, patch) }) }
    function failureText(code) {
      if (code === 'UNSAFE_PATH') return t('migrationUnsafePath')
      if (code === 'INVALID_DATA' || code === 'INVALID_ARCHIVE') return t('migrationInvalidData')
      if (code === 'LIMIT_EXCEEDED') return t('migrationTooLarge')
      if (code === 'MIGRATION_BUSY' || code === 'STALE_TARGET') return t('migrationBusyError')
      if (code === 'RECOVERY_REQUIRED') return t('migrationRecovery')
      return t('migrationError')
    }
    async function exportData() {
      update({ busy: true, exportId: null, preview: null, error: false, message: t('migrationBusy') })
      try {
        var response = await fetch(exportUrl, { method: 'POST', cache: 'no-store' })
        var payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error?.code || 'migration')
        update({ busy: false, exportId: payload.data.exportId, preview: payload.data, message: '' })
      } catch (error) { update({ busy: false, error: true, message: failureText(error.message) }) }
    }
    async function selectFile(event) {
      var file = event.target.files && event.target.files[0]
      event.target.value = ''
      if (!file) return
      update({ busy: true, preview: null, exportId: null, error: false, message: t('migrationWorking') })
      try {
        var response = await fetch(inspectUrl, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file, cache: 'no-store' })
        var payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error?.code || 'migration')
        update({ busy: false, preview: payload.data, message: t('migrationReady') })
      } catch (error) { update({ busy: false, preview: null, error: true, message: failureText(error.message) }) }
    }
    async function commit() {
      if (!state.preview?.importId) return
      update({ busy: true, error: false, message: t('migrationWorking') })
      try {
        var response = await fetch(commitUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: state.preview.importId }), cache: 'no-store' })
        var payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error?.code || 'migration')
        update({ busy: false, preview: null, message: t('migrationDone') + (payload.data.restartRequired ? ' ' + t('migrationRestart') : '') })
        window.dispatchEvent(new CustomEvent('chonkyfish:migration-complete'))
      } catch (e) { update({ busy: false, error: true, message: e.message === 'RECOVERY_REQUIRED' ? t('migrationRecovery') : t('migrationError') }) }
    }
    async function cancelImport() {
      if (state.preview?.importId) {
        try { await fetch(cancelUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: state.preview.importId }) }) } catch (_) {}
      }
      update({ preview: null, message: '' })
    }
    async function download() {
      if (!state.exportId) return
      try {
        var response = await fetch(exportUrl + '?id=' + encodeURIComponent(state.exportId), { cache: 'no-store' })
        if (!response.ok) throw new Error()
        var blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a')
        a.href = url; a.download = 'chonkyfish.fishpack'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
      } catch (_) { update({ error: true, message: t('migrationError') }) }
    }
    var counts = state.preview?.sections
    var transfer = h(React.Fragment, null,
      h('h2', null, t('migrationTitle')), h('p', null, t('migrationIntro')),
      h('p', null, t('migrationIncluded')), h('p', null, t('migrationExcluded')),
      h('div', { className: 'notice' }, t('migrationPrivacy')),
      h('div', { className: 'actions' },
        !importOnly && h('button', { className: 'primary', disabled: state.busy, onClick: exportData }, t('migrationExport')),
        h('button', { disabled: state.busy, onClick: function () { fileRef.current?.click() } }, t('migrationImport')),
        h('input', { ref: fileRef, type: 'file', accept: '.fishpack,application/zip', hidden: true, onChange: selectFile, 'aria-label': t('migrationSelect') })),
      state.preview && h(React.Fragment, null,
        h('h2', null, state.exportId ? t('migrationExport') : t('migrationTitle')),
        !state.exportId && h('div', { className: 'notice' }, t('migrationReplace')),
        h('div', { className: 'counts' }, Object.keys(counts || {}).map(function (key) { return h('span', { key: key }, key + ': ' + counts[key] + ' ' + t('migrationCount')) })),
        state.preview.bytes && h('p', null, t('migrationBytes') + ': ' + state.preview.bytes),
        h('p', null, (state.preview.warnings || []).map(function (key) { var labels = { 'custom-profile-path-not-included': 'migrationWarnCustomProfile', 'browser-profile-excluded': 'migrationWarnBrowserProfile', 'autonomous-actions-disabled-on-import': 'migrationWarnAutonomous' }; return labels[key] ? t(labels[key]) : key }).join(' · ')),
        state.exportId ? h('button', { className: 'primary', onClick: download }, t('migrationDownload')) : h('div', { className: 'actions' }, h('button', { disabled: state.busy, onClick: cancelImport }, t('migrationCancel')), h('button', { className: 'primary', disabled: state.busy, onClick: commit }, t('migrationConfirm')))),
      importOnly && h('button', { disabled: state.busy, onClick: async function() { await cancelImport(); props?.onBack?.() } }, '返回首次设置'),
      state.message && h('p', { role: state.error ? 'alert' : 'status', className: state.error ? 'error' : '' }, state.message))
    return h('section', { className: 'cf-migration cf-module' }, h('style', null, MODULE_SURFACE + '\n.cf-migration{--mig-blue:#326fa8;--mig-blue-hover:#285d91;height:100%;overflow:auto;background:var(--dsw-alias-bg-base,#f7faff);color:var(--dsw-alias-label-primary,#213b55);font:14px/1.65 var(--dsw-font-family,system-ui)}.cf-migration .inner{max-width:900px;margin:auto;padding:42px 48px}.cf-migration header{border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:24px;margin-bottom:28px}.cf-migration h1{font-size:32px;margin:0 0 8px}.cf-migration h2{font-size:20px;margin:30px 0 8px}.cf-migration p{color:var(--dsw-alias-label-secondary,#71849a);margin:8px 0}.cf-migration .actions{display:flex;gap:12px;margin:24px 0}.cf-migration button{font:inherit;font-weight:600;color:var(--dsw-alias-label-primary,#213b55);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d7e3ee);border-radius:8px;padding:10px 16px;cursor:pointer;transition:background-color .16s ease,border-color .16s ease,color .16s ease,transform .16s ease}.cf-migration button:hover:not(:disabled){background:#edf4fa;border-color:#b8ccdf}.cf-migration button:active:not(:disabled){transform:translateY(1px)}.cf-migration button.primary{color:#fff;background:var(--dsw-alias-brand-primary,var(--mig-blue));border-color:var(--dsw-alias-brand-primary,var(--mig-blue));box-shadow:0 2px 5px rgb(33 79 121 / 16%)}.cf-migration button.primary:hover:not(:disabled){color:#fff;background:var(--mig-blue-hover);border-color:var(--mig-blue-hover)}.cf-migration button:disabled{opacity:.5;cursor:wait}.cf-migration .notice{padding:14px 16px;border-left:3px solid var(--dsw-alias-brand-primary,var(--mig-blue));background:var(--dsw-alias-bg-layer-1,#eef4f9);color:var(--dsw-alias-label-primary,#29435d);white-space:pre-line}.cf-migration .error{color:var(--dsw-alias-label-danger,#b42318)}.cf-migration .counts{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0}.cf-migration .counts span{padding:8px 12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#60768d);border:1px solid var(--dsw-alias-border-l1,#dbe5ef);border-radius:8px}.cf-migration :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}@container (max-width:650px){.cf-migration .inner{padding:26px 20px}.cf-migration .actions{flex-wrap:wrap}}'),
      !importOnly && h('style', null, SETTINGS_TABS_CSS),
      h('div', { className: 'inner' },
        h('header', { className: importOnly ? undefined : 'settings-heading' }, h('h1', null, importOnly ? '导入已有资料' : t('navSettings')), h('p', null, importOnly ? '选择在设置中导出的 .fishpack 资料包，继续之前的小鱼塘。' : t('settingsSubtitle'))),
        importOnly ? transfer : h(React.Fragment, null,
          h('div', { className: 'settings-tabs', role: 'tablist', 'aria-label': t('navSettings') }, tabs.map(renderTab)),
          renderPanel('voice', h(VoiceSettings, { active: selectedTab === 'voice' })),
          renderPanel('transfer', transfer))))
  }
}
