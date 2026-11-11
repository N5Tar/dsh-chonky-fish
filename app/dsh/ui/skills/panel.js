// Embedded into the existing Client factory by build.mjs. No runtime imports.
var SKILLS_ZH = {
  navSkills: '技能', skillsSubtitle: '大肥鱼的方法与经验', skillsIntro: '查看她会做什么，以及在活动中学到了什么。这里仅查看，不会触发官网发布。',
  skillsRefresh: '刷新', skillsLoading: '正在读取技能…', skillsEmpty: '还没有可用技能。', skillsSelect: '从左侧选择一个技能',
  skillsGuide: '使用指南', skillsExperiences: '学习经验', skillsHistory: '版本历史', skillsPrevious: '上一页', skillsNext: '下一页',
  skillsVersion: '版本', skillsCurrent: '当前版本', skillsLatest: '回到最新版', skillsView: '查看此版', skillsObserved: '观察记录 · 不代表已验证',
  skillsNoExperiences: '还没有学习经验。大肥鱼记录新的经验后，会显示在这里。', skillsNoHistory: '还没有版本记录。',
  skillsSource: '来源', skillsNoSource: '未记录来源', skillsInitial: '内置初始版本', skillsReadOnly: '只读技能库',
  skillsDisabled: '技能工具已关闭；仍可查看已有内容。', skillsError: '读取失败，请重试。',
  skillsMissing: '技能服务尚未加载，请更新 Host 插件并刷新页面。', skillsCorrupt: '技能数据损坏或路径异常，未重置内容，请检查存储。',
  skillsPartial: '分页显示', skillsRetry: '重试', skillsCreate: '新建版本', skillsSeed: '内置', skillsRecord: '记录经验', skillsRevise: '修订指南', skillsRollback: '恢复版本',
}
var SKILLS_EN = {
  navSkills: 'Skills', skillsSubtitle: 'Methods and experience', skillsIntro: 'Explore what ChonkyFish can do and what she has learned. Viewing this page never publishes the website.',
  skillsRefresh: 'Refresh', skillsLoading: 'Loading skills…', skillsEmpty: 'No skills available.', skillsSelect: 'Select a skill',
  skillsGuide: 'Guide', skillsExperiences: 'Experience', skillsHistory: 'History', skillsPrevious: 'Previous', skillsNext: 'Next',
  skillsVersion: 'Version', skillsCurrent: 'Current version', skillsLatest: 'Back to latest', skillsView: 'View version', skillsObserved: 'Observation · not verified',
  skillsNoExperiences: 'No experience recorded yet. New observations will appear here.', skillsNoHistory: 'No version history yet.',
  skillsSource: 'Sources', skillsNoSource: 'No sources recorded', skillsInitial: 'Bundled initial version', skillsReadOnly: 'Read-only library',
  skillsDisabled: 'Skill tools are disabled; saved content remains readable.', skillsError: 'Unable to load. Please retry.',
  skillsMissing: 'Skills service is unavailable. Update the Host plugin and refresh.', skillsCorrupt: 'Skill data or storage path is invalid. Nothing was reset.',
  skillsPartial: 'Paged content', skillsRetry: 'Retry', skillsCreate: 'Created', skillsSeed: 'Bundled', skillsRecord: 'Observation', skillsRevise: 'Guide revision', skillsRollback: 'Restore version',
}
Object.assign(SKILLS_ZH, {
  skillsImport: '导入技能', skillsExport: '导出技能', skillsImportConfirm: '确认导入', skillsCancel: '取消', skillsTransferBusy: '正在处理…',
  skillsTransferHint: 'JSON 文件包含指南、学习经验和完整版本历史。同名技能不会被覆盖。', skillsImportPreview: '检查导入内容', skillsImportSuccess: '技能已导入，可在目录中查看。', skillsExportSuccess: '已生成下载文件。导出包含全部历史，请留意其中的私人信息。',
  skillsInvalidArchive: '文件不是有效的技能 JSON，或内容超过限制。', skillsConflict: '相同 ID 的技能已存在，未覆盖任何内容。', skillsFileLarge: '文件不能超过 1 MiB。', skillsLibrary: '技能目录', skillsCount: '个技能', skillsSaved: '已保存的指南与经验', skillsRecovery: '界面遇到异常，数据未改变。可以重新打开技能面板。', skillsReopen: '重新打开', skillsNoPublish: '导入与查看只改变技能库，不会发布官网内容。', skillsImportName: '技能名称', skillsImportId: '技能 ID', skillsImportRevisions: '历史版本数', skillsImportExperiences: '当前经验数', skillsInvalidResponse: '服务返回的数据不完整，请刷新重试。'
})
Object.assign(SKILLS_EN, {
  skillsImport: 'Import skill', skillsExport: 'Export skill', skillsImportConfirm: 'Confirm import', skillsCancel: 'Cancel', skillsTransferBusy: 'Processing…',
  skillsTransferHint: 'JSON includes the guide, observations and full history. Existing skill IDs are never overwritten.', skillsImportPreview: 'Review import', skillsImportSuccess: 'Skill imported. Find it in the library.', skillsExportSuccess: 'Download prepared. The archive includes all history; check it for private information.',
  skillsInvalidArchive: 'Invalid skill JSON or content exceeds the limits.', skillsConflict: 'This skill ID already exists. Nothing was overwritten.', skillsFileLarge: 'File must not exceed 1 MiB.', skillsLibrary: 'Skill library', skillsCount: 'skills', skillsSaved: 'Saved guides and observations', skillsRecovery: 'The panel encountered an error. Your data is unchanged. Reopen the panel to recover.', skillsReopen: 'Reopen panel', skillsNoPublish: 'Importing and viewing never publish website content.', skillsImportName: 'Skill name', skillsImportId: 'Skill ID', skillsImportRevisions: 'Revisions', skillsImportExperiences: 'Current observations', skillsInvalidResponse: 'Incomplete server response. Refresh and retry.'
})
Object.assign(SKILLS_ZH, {
  skillsSaved: '让每一次尝试，都留下可以复用的方法。', skillsLibraryNote: '技能来自大肥鱼自己的积累。\n阅读方法不等于已经执行，\n记录经验不代表已经验证。', skillsExperienceUnit: '条经验', skillsObservationUnit: '条观察记录', skillsVersionUnit: '个版本', skillsGuideBody: '指南正文', skillsFullHistory: '完整修订记录', skillsHistorical: '正在查看历史版本', skillsFootnote: '导出可备份完整积累；导入仅保存方法，不触发官网发布或其他活动。', skillsImportHint: '仅接受技能 JSON 存档。导入前可预览，已有相同 ID 不会被覆盖。', skillsEmptyExperienceTitle: '还没有学习经验', skillsEmptyExperienceHint: '大肥鱼记录新的观察后，会显示在这里。', skillsImportSuccess: '技能已导入并打开。', skillsTransferHint: 'JSON 文件包含指南、学习经验和完整版本历史。相同 ID 的技能不会被覆盖。'
})
Object.assign(SKILLS_EN, {
  skillsSaved: 'Turn every attempt into a reusable method.', skillsLibraryNote: 'Skills grow from ChonkyFish’s own experience.\nReading is not execution.\nObservations are not verified conclusions.', skillsExperienceUnit: 'observations', skillsObservationUnit: 'observations', skillsVersionUnit: 'versions', skillsGuideBody: 'Guide text', skillsFullHistory: 'Full revision history', skillsHistorical: 'Viewing historical version', skillsFootnote: 'Export backs up the full history. Import only saves knowledge; it never publishes or starts an activity.', skillsImportHint: 'Import a skill JSON archive. Preview before saving; existing IDs are never overwritten.', skillsEmptyExperienceTitle: 'No observations yet', skillsEmptyExperienceHint: 'New observations from ChonkyFish will appear here.', skillsImportSuccess: 'Skill imported and opened.'
})
var skillsPageSerial = 0
Object.assign(zh, SKILLS_ZH)
Object.assign(en, SKILLS_EN)
var SKILLS_CSS = ".cf-skills{height:100%;min-height:0;overflow:auto;container-type:inline-size;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,system-ui);font-size:14px;line-height:1.65}\n.cf-skills,.cf-skills *{box-sizing:border-box}.cf-skills [hidden]{display:none!important}\n.cf-skills .shell{max-width:1360px;margin:auto;padding:42px 52px;min-height:100%}\n.cf-skills header{display:flex;justify-content:space-between;align-items:center;gap:20px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:30px;margin-bottom:30px;flex-wrap:wrap}\n.cf-skills h1{font-size:34px;line-height:1.3;letter-spacing:-1px;margin:0 0 12px}.cf-skills h2{font-size:24px;line-height:1.4;margin:0 0 8px;letter-spacing:-.4px}.cf-skills h3{font-size:17px;margin:0 0 12px}.cf-skills p{margin:8px 0}\n.cf-skills .muted,.cf-skills .eyebrow{color:var(--dsw-alias-label-secondary)}.cf-skills .eyebrow{font-size:12px;letter-spacing:.06em;margin-bottom:10px}\n.cf-skills button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 15px;cursor:pointer;white-space:nowrap}.cf-skills button:hover{background:var(--dsw-alias-bg-layer-2)}.cf-skills button:active{transform:translateY(1px)}.cf-skills button:disabled{opacity:.5;cursor:default}.cf-skills :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.cf-skills .primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}\n.cf-skills .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cf-skills .layout{display:grid;grid-template-columns:242px minmax(0,1fr);gap:36px}.cf-skills aside{border-right:1px solid var(--dsw-alias-border-l1);padding-right:24px}\n.cf-skills .skill-row{display:block;width:100%;text-align:left;padding:18px 16px;border-color:transparent;background:transparent;margin:10px 0;white-space:normal;overflow-wrap:anywhere}.cf-skills .skill-row[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}.cf-skills .skill-row strong{display:block;font-size:15px;margin-bottom:6px}.cf-skills .skill-row .desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}.cf-skills .skill-row .meta{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:18px}\n.cf-skills .library-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:32px;line-height:1.9;white-space:pre-line}.cf-skills .content{min-width:0;padding-top:4px}.cf-skills .section-head{display:flex;justify-content:space-between;align-items:start;gap:20px}.cf-skills .section-head>div{min-width:0;overflow-wrap:anywhere}.cf-skills .skill-id{font:12px/1.7 var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-secondary);margin-top:12px;overflow-wrap:anywhere}\n.cf-skills .tabs{display:flex;gap:30px;border-bottom:1px solid var(--dsw-alias-border-l1);margin:24px 0}.cf-skills .tabs button{background:transparent;padding:12px 0;border:0;border-bottom:2px solid transparent;border-radius:0}.cf-skills .tabs button[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}\n.cf-skills .guide-text{max-width:76ch;padding:12px 0 24px;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.95;margin:0}.cf-skills .meta-row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:22px}\n.cf-skills article{padding:22px 0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}.cf-skills article:first-child{padding-top:0}.cf-skills article p{margin:10px 0 16px;font-size:15px;line-height:1.9}.cf-skills .source{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.cf-skills .label{font-size:12px;color:var(--dsw-alias-brand-primary)}\n.cf-skills .footnote{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:32px;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l1)}.cf-skills .notice{border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);padding:14px 18px;margin-bottom:24px;overflow-wrap:anywhere}.cf-skills .error{color:var(--dsw-alias-state-error-primary)}.cf-skills .notice.error{border-color:var(--dsw-alias-state-error-primary)}\n.cf-skills .transfer{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:24px;margin-bottom:28px}.cf-skills .transfer h2{font-size:19px}.cf-skills .transfer dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:10px 26px}.cf-skills .transfer dt{color:var(--dsw-alias-label-secondary)}.cf-skills .transfer dd{margin:0;overflow-wrap:anywhere}\n.cf-skills .empty{padding:44px 0;color:var(--dsw-alias-label-secondary)}.cf-skills .empty strong{display:block;font-size:18px;color:var(--dsw-alias-label-primary);margin-bottom:8px}.cf-skills .note{padding:12px 16px;background:var(--dsw-alias-bg-layer-2);margin-bottom:20px;border-radius:8px}.cf-skills .version-note{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.cf-skills .pagination{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:18px 0;font-size:12px}.cf-skills .skeleton{height:14px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;margin:18px 0;width:85%}.cf-skills .skeleton:last-child{width:65%}\n@container(max-width:850px){.cf-skills .shell{padding:26px 24px}.cf-skills .layout{grid-template-columns:200px minmax(0,1fr);gap:24px}.cf-skills aside{padding-right:18px}.cf-skills .section-head{flex-wrap:wrap}}\n@container(max-width:640px){.cf-skills .shell{padding:24px 18px}.cf-skills header{align-items:start}.cf-skills .layout{grid-template-columns:1fr}.cf-skills .skill-row{margin-bottom:0}.cf-skills aside{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 0 20px}.cf-skills .library-note{margin-top:12px}.cf-skills h1{font-size:28px}.cf-skills .tabs{gap:24px}.cf-skills .transfer dl{grid-template-columns:1fr;gap:3px}.cf-skills .transfer dd{margin-bottom:10px}}\n"

async function requestSkills(params, signal, body) {
  var bootstrap = window.__CHONKYFISH_STATE__ || {}
  var endpoint = (bootstrap.routes || {}).skills || RESOURCES.routes.skills
  if (!endpoint) throw new Error('skillsMissing')
  var response = await fetch(endpoint + (body ? '' : '?' + new URLSearchParams(params)), { signal: signal, cache: 'no-store', method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  if (response.status === 404) throw new Error('skillsMissing')
  var payload
  try { payload = await response.json() } catch (error) { throw new Error('skillsError') }
  if (!response.ok || !payload || payload.ok !== true || !payload.data) {
    var code = payload && payload.error && payload.error.code
    throw new Error(code === 'CONFLICT' ? 'skillsConflict' : code === 'INVALID_ARGUMENT' || code === 'INVALID_ARCHIVE' || code === 'LIMIT_EXCEEDED' ? 'skillsInvalidArchive' : code === 'CORRUPT_STATE' || code === 'UNSAFE_PATH' ? 'skillsCorrupt' : 'skillsError')
  }
  return payload
}
// The service keeps chronological history; the workbench presents latest first.
// History is bounded to 64 metadata entries and never contains full guide bodies.
async function requestSkillsHistory(skillId, offset, signal) {
  var first = await requestSkills({ action: 'history', skillId: skillId, offset: 0, limit: 50 }, signal)
  var data = validateSkillsDetail(first.data, 'history'), items = data.items.slice()
  if (!Number.isSafeInteger(data.total) || data.total < 0 || data.total > 64) throw new Error('skillsInvalidResponse')
  if (data.nextOffset !== null) {
    var rest = await requestSkills({ action: 'history', skillId: skillId, offset: data.nextOffset, limit: 50 }, signal)
    validateSkillsDetail(rest.data, 'history')
    if (rest.data.revision !== data.revision || rest.data.nextOffset !== null) throw new Error('skillsError')
    items = items.concat(rest.data.items)
  }
  if (items.length !== data.total) throw new Error('skillsInvalidResponse')
  return { ok: true, data: Object.assign({}, data, { items: items.reverse().slice(offset, offset + 10), offset: offset, limit: 10, nextOffset: offset + 10 < data.total ? offset + 10 : null }) }
}
function validateSkillsDetail(data, tab) {
  if (!data || !Number.isSafeInteger(data.revision)) throw new Error('skillsInvalidResponse')
  if (tab === 'guide' ? typeof data.content !== 'string' : !Array.isArray(data.items)) throw new Error('skillsInvalidResponse')
  if (tab === 'experiences' && data.items.some(function (item) { return !item || typeof item.claim !== 'string' || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.some(function (ref) { return typeof ref !== 'string' }) })) throw new Error('skillsInvalidResponse')
  return data
}
function createSafeSkillsPage(t) {
  var Page = createSkillsPage(t)
  class SkillsBoundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false, generation: 0 } }
    static getDerivedStateFromError() { return { failed: true } }
    render() {
      var self = this
      return this.state.failed ? h('section', { className: 'cf-skills cf-module', role: 'alert' }, h('style', null, SKILLS_CSS + MODULE_SURFACE), h('h1', null, t('navSkills')), h('p', null, t('skillsRecovery')), h('button', { onClick: function () { self.setState({ failed: false, generation: self.state.generation + 1 }) } }, t('skillsReopen'))) : h(Page, { key: this.state.generation })
    }
  }
  return SkillsBoundary
}
function createSkillsPage(t) {
  return function SkillsPage() {
    var refreshState = React.useState(0), refresh = refreshState[0], setRefresh = refreshState[1]
    var listState = React.useState(null), list = listState[0], setList = listState[1]
    var listOffsetState = React.useState(0), listOffset = listOffsetState[0], setListOffset = listOffsetState[1]
    var selectionState = React.useState(''), selected = selectionState[0], setSelected = selectionState[1]
    var viewState = React.useState({ tab: 'guide', offset: 0 }), view = viewState[0], setView = viewState[1]
    var detailState = React.useState(null), loadedDetail = detailState[0], setDetail = detailState[1]
    // A tab change renders before its effect runs: never render the previous tab's payload.
    var detail = loadedDetail && loadedDetail.selected === selected && loadedDetail.view === view ? loadedDetail.data : null
    var listErrorState = React.useState(''), listError = listErrorState[0], setListError = listErrorState[1]
    var detailErrorState = React.useState(''), detailError = detailErrorState[0], setDetailError = detailErrorState[1]
    var listBusyState = React.useState(true), listBusy = listBusyState[0], setListBusy = listBusyState[1]
    var detailBusyState = React.useState(false), detailBusy = detailBusyState[0], setDetailBusy = detailBusyState[1]
    var transferState = React.useState(null), transfer = transferState[0], setTransfer = transferState[1]
    var transferBusyState = React.useState(false), transferBusy = transferBusyState[0], setTransferBusy = transferBusyState[1]
    var noticeState = React.useState(null), notice = noticeState[0], setNotice = noticeState[1]
    var fileInput = React.useRef(null), transferController = React.useRef(null), mounted = React.useRef(true), transferLock = React.useRef(false)
    var pageId = React.useRef(null), tabRefs = React.useRef({}), confirmButton = React.useRef(null), importButton = React.useRef(null), preferredSkill = React.useRef('')
    if (!pageId.current) pageId.current = 'cf-skills-' + (++skillsPageSerial)
    React.useEffect(function () { if (transfer && confirmButton.current) confirmButton.current.focus() }, [transfer])
    React.useEffect(function () { mounted.current = true; return function () { mounted.current = false; if (transferController.current) transferController.current.abort() } }, [])
    function transferError(error) { if (mounted.current) setNotice({ error: true, key: Object.hasOwn(SKILLS_ZH, error.message) ? error.message : 'skillsError' }) }
    async function pickFile(event) {
      var file = event.target.files && event.target.files[0]; event.target.value = ''
      if (!file || transferLock.current) return
      transferLock.current = true; setTransferBusy(true); setNotice(null); setTransfer(null)
      try {
        if (file.size > 1048576) throw new Error('skillsFileLarge')
        var archive
        try { archive = JSON.parse(await file.text()) } catch (error) { throw new Error('skillsInvalidArchive') }
        if (!archive || typeof archive.title !== 'string' || typeof archive.skillId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(archive.skillId) || !Array.isArray(archive.snapshots) || !archive.snapshots.length) throw new Error('skillsInvalidArchive')
        var latest = archive.snapshots[archive.snapshots.length - 1]
        if (archive.format !== 1 || !latest || !Array.isArray(latest.experiences)) throw new Error('skillsInvalidArchive')
        if (mounted.current) setTransfer({ archive: archive, name: file.name, experienceCount: latest.experiences.length })
      } catch (error) { transferError(error) }
      finally { transferLock.current = false; if (mounted.current) setTransferBusy(false) }
    }
    async function runTransfer(action) {
      if (transferLock.current) return
      transferLock.current = true; setTransferBusy(true); setNotice(null)
      var controller = new AbortController(); transferController.current = controller
      try {
        var payload = await requestSkills({ action: 'export', skillId: selected }, controller.signal, action === 'import' ? { action: 'import', archive: transfer.archive } : undefined)
        if (!mounted.current) return
        if (action === 'export') {
          var url = URL.createObjectURL(new Blob([JSON.stringify(payload.data)], { type: 'application/json' }))
          var anchor = document.createElement('a'); anchor.href = url; anchor.download = selected + '.skill.json'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
        } else { preferredSkill.current = payload.data.skillId; setSelected(payload.data.skillId); setTransfer(null); setListOffset(0); setView({ tab: 'guide', offset: 0 }); setRefresh(function (n) { return n + 1 }) }
        setNotice({ key: action === 'import' ? 'skillsImportSuccess' : 'skillsExportSuccess' })
      } catch (error) { transferError(error) }
      finally { transferLock.current = false; if (mounted.current) setTransferBusy(false) }
    }
    React.useEffect(function () {
      var controller = new AbortController(), active = true
      setListBusy(true); setListError('')
      requestSkills({ action: 'list', offset: listOffset, limit: 10 }, controller.signal).then(function (payload) {
        if (!active) return
        if (!payload.data || !Array.isArray(payload.data.items)) throw new Error('skillsInvalidResponse')
        if (preferredSkill.current && !payload.data.items.some(function (s) { return s.skillId === preferredSkill.current }) && Number.isSafeInteger(payload.data.nextOffset) && payload.data.nextOffset > listOffset) { setListOffset(payload.data.nextOffset); return }
        var preferred = preferredSkill.current; preferredSkill.current = ''
        setList(payload)
        if (preferred && payload.data.items.some(function (s) { return s.skillId === preferred })) { setSelected(preferred); return }
        setSelected(function (previous) { return payload.data.items.some(function (s) { return s.skillId === previous }) ? previous : ((payload.data.items[0] || {}).skillId || '') })
      }).catch(function (error) { if (active) { setListError(error.message); setList(null); setSelected('') } }).finally(function () { if (active) setListBusy(false) })
      return function () { active = false; controller.abort() }
    }, [refresh, listOffset])
    React.useEffect(function () {
      if (!selected) { setDetail(null); setDetailBusy(false); return }
      var controller = new AbortController(), active = true
      setDetailBusy(true); setDetail(null); setDetailError('')
      var params = { action: view.tab === 'history' ? 'history' : 'read', skillId: selected, offset: view.offset, limit: view.tab === 'guide' ? 8000 : 10 }
      if (view.tab !== 'history') { params.section = view.tab; if (view.revision) params.revision = view.revision }
      ;(view.tab === 'history' ? requestSkillsHistory(selected, view.offset, controller.signal) : requestSkills(params, controller.signal)).then(function (payload) { if (active) setDetail({ selected: selected, view: view, data: validateSkillsDetail(payload.data, view.tab) }) })
        .catch(function (error) { if (active) setDetailError(error.message) }).finally(function () { if (active) setDetailBusy(false) })
      return function () { active = false; controller.abort() }
    }, [selected, view, refresh])
    function reset() { setView({ tab: view.tab, offset: 0 }); setRefresh(function (n) { return n + 1 }) }
    function errorBox(key) { return h('div', { role: 'alert', className: 'error' }, h('p', null, t(Object.hasOwn(SKILLS_ZH, key) ? key : 'skillsError')), h('button', { onClick: reset }, t('skillsRetry'))) }
    var skill = list && list.data.items.find(function (s) { return s.skillId === selected })
    var words = { create: 'skillsCreate', seed: 'skillsSeed', record: 'skillsRecord', revise: 'skillsRevise', rollback: 'skillsRollback' }
    var tabs = ['guide', 'experiences', 'history']
    function changeTab(tab) { setView({ tab: tab, offset: 0 }) }
    function tabKey(event, tab) {
      var index = tabs.indexOf(tab), next
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = tabs.length - 1
      if (next !== undefined) { event.preventDefault(); changeTab(tabs[next]); if (tabRefs.current[tabs[next]]) tabRefs.current[tabs[next]].focus() }
    }
    function loading() { return h('div', { role: 'status', 'aria-label': t('skillsLoading') }, h('p', { className: 'muted' }, t('skillsLoading')), h('div', { className: 'skeleton', 'aria-hidden': true }), h('div', { className: 'skeleton', 'aria-hidden': true })) }
    function date(value) { return typeof value === 'string' ? value.slice(0, 10) : '' }
    var content = null
    if (detail && view.tab === 'guide') content = h('pre', { className: 'guide-text' }, detail.content)
    if (detail && view.tab === 'experiences') content = detail.items.length ? detail.items.map(function (item) {
      return h('article', { key: item.id, className: 'observation' }, h('div', { className: 'label' }, t('skillsObserved')), h('p', null, item.claim), h('div', { className: 'source' }, t('skillsSource') + ': ' + (item.evidenceRefs.length ? item.evidenceRefs.join('; ') : t('skillsNoSource'))), h('time', { className: 'source', dateTime: item.createdAt, title: item.createdAt }, date(item.createdAt)))
    }) : h('div', { className: 'empty' }, h('strong', null, t('skillsEmptyExperienceTitle')), h('p', null, t('skillsEmptyExperienceHint')))
    if (detail && view.tab === 'history') content = detail.items.length ? detail.items.map(function (item) {
      return h('article', { key: item.revision }, h('h3', null, t('skillsVersion') + ' ' + item.revision + ' · ' + (words[item.action] ? t(words[item.action]) : item.action)), h('p', null, item.action === 'seed' ? t('skillsInitial') : item.reason), h('p', { className: 'source' }, h('time', { dateTime: item.createdAt, title: item.createdAt }, date(item.createdAt))), h('button', { onClick: function () { setView({ tab: 'guide', offset: 0, revision: item.revision }) } }, t('skillsView')))
    }) : h('p', { className: 'empty' }, t('skillsNoHistory'))
    return h('section', { className: 'cf-skills cf-module', 'aria-label': t('navSkills') }, h('style', null, SKILLS_CSS + MODULE_SURFACE), h('div', { className: 'shell module-shell' },
      h('header', { className: 'module-head' }, h('div', { className: 'module-heading' }, h('span', { className: 'module-icon', 'aria-hidden': true }, h(ICON_SKILLS)), h('div', null, h('h1', null, t('navSkills')), h('p', { className: 'module-sub' }, t('skillsSubtitle')))), h('div', { className: 'actions' }, h('button', { onClick: reset, disabled: listBusy || detailBusy }, t('skillsRefresh')), h('button', { ref: importButton, className: 'primary', onClick: function () { fileInput.current.click() }, disabled: transferBusy }, t('skillsImport')), h('input', { ref: fileInput, type: 'file', accept: '.json,application/json', hidden: true, onChange: pickFile, 'aria-label': t('skillsImport') }))),
      notice && h('div', { className: 'notice' + (notice.error ? ' error' : ''), role: notice.error ? 'alert' : 'status' }, t(notice.key)),
      transferBusy && h('p', { role: 'status' }, t('skillsTransferBusy')),
      transfer && h('section', { className: 'transfer', 'aria-label': t('skillsImportPreview') }, h('h2', null, t('skillsImportPreview')), h('p', { className: 'muted' }, transfer.name), h('dl', null,
        h('dt', null, t('skillsImportName')), h('dd', null, transfer.archive.title), h('dt', null, t('skillsImportId')), h('dd', null, transfer.archive.skillId), h('dt', null, t('skillsImportRevisions')), h('dd', null, transfer.archive.snapshots.length), h('dt', null, t('skillsImportExperiences')), h('dd', null, transfer.experienceCount)),
        h('p', { className: 'muted' }, t('skillsTransferHint')), h('div', { className: 'actions' }, h('button', { ref: confirmButton, className: 'primary', disabled: transferBusy, onClick: function () { runTransfer('import') } }, t('skillsImportConfirm')), h('button', { disabled: transferBusy, onClick: function () { setTransfer(null); setNotice(null); if (importButton.current) importButton.current.focus() } }, t('skillsCancel')))),
      list && !list.enabled && h('p', { className: 'note' }, t('skillsDisabled')),
      h('div', { className: 'layout module-card' }, h('aside', { 'aria-busy': listBusy }, h('div', { className: 'eyebrow' }, t('skillsLibrary') + (list && Number.isSafeInteger(list.data.total) ? ' · ' + list.data.total : '')),
        listError && errorBox(listError), listBusy && loading(),
        !listBusy && list && list.data.items.map(function (item) { return h('button', { key: item.skillId, className: 'skill-row', 'aria-pressed': item.skillId === selected, onClick: function () { preferredSkill.current = ''; changeTab('guide'); setSelected(item.skillId) } }, h('strong', null, item.title), h('span', { className: 'desc' }, item.description), h('span', { className: 'meta' }, t('skillsVersion') + ' ' + item.revision + ' · ' + (item.experienceCount || 0) + ' ' + t('skillsExperienceUnit'))) }),
        !listBusy && list && !list.data.items.length && h('div', { className: 'empty' }, h('strong', null, t('skillsEmpty')), h('p', null, t('skillsImportHint'))),
        list && (listOffset > 0 || list.data.nextOffset !== null) && h('div', { className: 'pagination' }, listOffset > 0 && h('button', { disabled: listBusy, onClick: function () { setListOffset(Math.max(0, listOffset - 10)) } }, t('skillsPrevious')), list.data.nextOffset !== null && h('button', { disabled: listBusy, onClick: function () { setListOffset(list.data.nextOffset) } }, t('skillsNext'))),
        h('p', { className: 'library-note' }, t('skillsLibraryNote'))),
      h('div', { className: 'content' }, !selected ? h('p', { className: 'empty' }, t('skillsSelect')) : h(React.Fragment, null,
        h('div', { className: 'section-head' }, h('div', null, h('h2', null, skill ? skill.title : selected), h('p', { className: 'muted' }, skill ? skill.description : ''), h('div', { className: 'skill-id' }, selected)), h('button', { disabled: transferBusy, onClick: function () { runTransfer('export') } }, t('skillsExport'))),
        h('div', { className: 'tabs', role: 'tablist', 'aria-label': t('navSkills') }, tabs.map(function (tab) { return h('button', { key: tab, ref: function (node) { tabRefs.current[tab] = node }, role: 'tab', id: pageId.current + '-' + tab, 'aria-controls': pageId.current + '-detail', 'aria-selected': tab === view.tab, tabIndex: tab === view.tab ? 0 : -1, onClick: function () { changeTab(tab) }, onKeyDown: function (event) { tabKey(event, tab) } }, t({ guide: 'skillsGuide', experiences: 'skillsExperiences', history: 'skillsHistory' }[tab])) })),
        h('div', { role: 'tabpanel', id: pageId.current + '-detail', 'aria-labelledby': pageId.current + '-' + view.tab, tabIndex: 0, 'aria-busy': detailBusy },
          view.revision && h('div', { className: 'note version-note' }, h('span', null, t('skillsHistorical') + ' ' + view.revision), h('button', { onClick: function () { changeTab(view.tab) } }, t('skillsLatest'))),
          detailBusy && loading(), detailError && errorBox(detailError),
          !detailBusy && detail && h(React.Fragment, null,
            h('div', { className: 'meta-row' }, h('span', null, view.tab === 'history' ? t('skillsFullHistory') : t('skillsVersion') + ' ' + detail.revision + (view.revision ? '' : ' · ' + t('skillsCurrent'))), h('span', null, view.tab === 'guide' ? t('skillsGuideBody') : detail.total + ' ' + t(view.tab === 'history' ? 'skillsVersionUnit' : 'skillsObservationUnit'))), content,
            (detail.offset > 0 || detail.nextOffset !== null) && h('div', { className: 'pagination' }, h('span', { className: 'muted' }, t('skillsPartial') + ' · ' + (detail.total ? detail.offset + 1 : 0) + '–' + Math.min(detail.offset + detail.limit, detail.total) + ' / ' + detail.total),
              detail.offset > 0 && h('button', { onClick: function () { setView({ tab: view.tab, offset: Math.max(0, detail.offset - detail.limit), revision: view.tab === 'history' ? undefined : detail.revision }) } }, t('skillsPrevious')),
              detail.nextOffset !== null && h('button', { onClick: function () { setView({ tab: view.tab, offset: detail.nextOffset, revision: view.tab === 'history' ? undefined : detail.revision }) } }, t('skillsNext'))))),
        h('p', { className: 'footnote' }, t('skillsFootnote')))))))
  }
}
