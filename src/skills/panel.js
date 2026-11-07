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
  skillsPartial: '分页显示', skillsRetry: '重试', skillsSeed: '内置', skillsRecord: '记录经验', skillsRevise: '修订指南', skillsRollback: '恢复版本',
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
  skillsPartial: 'Paged content', skillsRetry: 'Retry', skillsSeed: 'Bundled', skillsRecord: 'Observation', skillsRevise: 'Guide revision', skillsRollback: 'Restore version',
}
Object.assign(zh, SKILLS_ZH)
Object.assign(en, SKILLS_EN)
var SKILLS_CSS = '.cf-skills{height:100%;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;padding:28px;box-sizing:border-box}' +
  '.cf-skills header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}.cf-skills h1{font-size:26px;margin:4px 0}.cf-skills h2{font-size:19px;margin:0 0 8px}.cf-skills p{line-height:1.7;margin:8px 0}.cf-skills .muted{color:var(--dsw-alias-label-secondary);font-size:13px}' +
  '.cf-skills .layout{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);gap:28px}.cf-skills aside{border-right:1px solid var(--dsw-alias-border-l1);padding-right:20px}.cf-skills button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px}.cf-skills button:hover{background:var(--dsw-alias-bg-layer-2)}.cf-skills button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.cf-skills button:disabled{opacity:.5;cursor:default}.cf-skills .skill-row{display:block;text-align:left;width:100%;margin-bottom:10px;padding:14px}.cf-skills .skill-row strong{display:block;margin-bottom:6px}.cf-skills button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}' +
  '.cf-skills .tabs,.cf-skills .pagination{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:18px 0}.cf-skills .content{min-width:0}.cf-skills pre{font:inherit;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.cf-skills article{border-bottom:1px solid var(--dsw-alias-border-l1);padding:16px 0;overflow-wrap:anywhere}.cf-skills article:first-child{padding-top:0}.cf-skills .error{color:var(--dsw-alias-state-error-primary)}.cf-skills .note{padding:12px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;margin-bottom:16px}.cf-skills ul{padding-left:20px}.cf-skills .empty{padding:24px 0;color:var(--dsw-alias-label-secondary)}' +
  '@media(max-width:700px){.cf-skills{padding:18px}.cf-skills .layout{grid-template-columns:1fr;gap:18px}.cf-skills aside{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 0 12px}}'

async function requestSkills(params, signal) {
  var bootstrap = window.__CHONKYFISH_STATE__ || {}
  var endpoint = (bootstrap.routes || {}).skills || RESOURCES.routes.skills
  if (!endpoint) throw new Error('skillsMissing')
  var response = await fetch(endpoint + '?' + new URLSearchParams(params), { signal: signal, cache: 'no-store' })
  if (response.status === 404) throw new Error('skillsMissing')
  var payload
  try { payload = await response.json() } catch (error) { throw new Error('skillsError') }
  if (!response.ok || !payload || payload.ok !== true || !payload.data) {
    var code = payload && payload.error && payload.error.code
    throw new Error(code === 'CORRUPT_STATE' || code === 'UNSAFE_PATH' ? 'skillsCorrupt' : 'skillsError')
  }
  return payload
}
function createSkillsPage(t) {
  return function SkillsPage() {
    var refreshState = React.useState(0), refresh = refreshState[0], setRefresh = refreshState[1]
    var listState = React.useState(null), list = listState[0], setList = listState[1]
    var listOffsetState = React.useState(0), listOffset = listOffsetState[0], setListOffset = listOffsetState[1]
    var selectionState = React.useState(''), selected = selectionState[0], setSelected = selectionState[1]
    var viewState = React.useState({ tab: 'guide', offset: 0 }), view = viewState[0], setView = viewState[1]
    var detailState = React.useState(null), detail = detailState[0], setDetail = detailState[1]
    var listErrorState = React.useState(''), listError = listErrorState[0], setListError = listErrorState[1]
    var detailErrorState = React.useState(''), detailError = detailErrorState[0], setDetailError = detailErrorState[1]
    var listBusyState = React.useState(true), listBusy = listBusyState[0], setListBusy = listBusyState[1]
    var detailBusyState = React.useState(false), detailBusy = detailBusyState[0], setDetailBusy = detailBusyState[1]
    React.useEffect(function () {
      var controller = new AbortController(), active = true
      setListBusy(true); setListError('')
      requestSkills({ action: 'list', offset: listOffset, limit: 10 }, controller.signal).then(function (payload) {
        if (!active) return
        setList(payload)
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
      requestSkills(params, controller.signal).then(function (payload) { if (active) setDetail(payload.data) })
        .catch(function (error) { if (active) setDetailError(error.message) }).finally(function () { if (active) setDetailBusy(false) })
      return function () { active = false; controller.abort() }
    }, [selected, view, refresh])
    function reset() { setView({ tab: view.tab, offset: 0 }); setRefresh(function (n) { return n + 1 }) }
    function errorBox(key) { return h('div', { role: 'alert', className: 'error' }, h('p', null, t(Object.hasOwn(SKILLS_ZH, key) ? key : 'skillsError')), h('button', { onClick: reset }, t('skillsRetry'))) }
    var skill = list && list.data.items.find(function (s) { return s.skillId === selected })
    var words = { seed: 'skillsSeed', record: 'skillsRecord', revise: 'skillsRevise', rollback: 'skillsRollback' }
    var content = null
    if (detail && view.tab === 'guide') content = h('pre', null, detail.content)
    if (detail && view.tab === 'experiences') content = detail.items.length ? detail.items.map(function (item) {
      return h('article', { key: item.id }, h('div', { className: 'muted' }, t('skillsObserved') + ' · ' + item.createdAt), h('p', null, item.claim), h('strong', null, t('skillsSource')), item.evidenceRefs.length ? h('ul', null, item.evidenceRefs.map(function (ref, i) { return h('li', { key: i }, ref) })) : h('p', { className: 'muted' }, t('skillsNoSource')))
    }) : h('p', { className: 'empty' }, t('skillsNoExperiences'))
    if (detail && view.tab === 'history') content = detail.items.length ? detail.items.map(function (item) {
      return h('article', { key: item.revision }, h('strong', null, t('skillsVersion') + ' ' + item.revision + ' · ' + (words[item.action] ? t(words[item.action]) : item.action)), h('p', null, item.action === 'seed' ? t('skillsInitial') : item.reason), item.action !== 'seed' && h('p', { className: 'muted' }, item.createdAt), h('button', { onClick: function () { setView({ tab: 'guide', offset: 0, revision: item.revision }) } }, t('skillsView')))
    }) : h('p', { className: 'empty' }, t('skillsNoHistory'))
    return h('section', { className: 'cf-skills', 'aria-label': t('navSkills') }, h('style', null, SKILLS_CSS),
      h('header', null, h('div', null, h('div', { className: 'muted' }, t('skillsSubtitle')), h('h1', null, t('navSkills')), h('p', { className: 'muted' }, t('skillsIntro'))), h('button', { onClick: reset, disabled: listBusy || detailBusy }, t('skillsRefresh'))),
      list && !list.enabled && h('p', { className: 'note' }, t('skillsDisabled')),
      h('div', { className: 'layout' }, h('aside', { 'aria-busy': listBusy },
        listError && errorBox(listError), listBusy && h('p', { role: 'status' }, t('skillsLoading')),
        !listBusy && list && list.data.items.map(function (item) { return h('button', { key: item.skillId, className: 'skill-row', 'aria-pressed': item.skillId === selected, onClick: function () { setView({ tab: 'guide', offset: 0 }); setSelected(item.skillId) } }, h('strong', null, item.title), h('span', { className: 'muted' }, item.description), h('p', { className: 'muted' }, t('skillsVersion') + ' ' + item.revision)) }),
        !listBusy && list && !list.data.items.length && h('p', null, t('skillsEmpty')),
        list && h('div', { className: 'pagination' }, listOffset > 0 && h('button', { disabled: listBusy, onClick: function () { setListOffset(Math.max(0, listOffset - 10)) } }, t('skillsPrevious')), list.data.nextOffset !== null && h('button', { disabled: listBusy, onClick: function () { setListOffset(list.data.nextOffset) } }, t('skillsNext')))),
      h('div', { className: 'content', 'aria-busy': detailBusy }, !selected ? h('p', { className: 'empty' }, t('skillsSelect')) : h(React.Fragment, null,
        h('h2', null, skill ? skill.title : selected), h('p', { className: 'muted' }, t('skillsReadOnly')),
        h('div', { className: 'tabs', role: 'group', 'aria-label': t('navSkills') }, ['guide', 'experiences', 'history'].map(function (tab) { return h('button', { key: tab, 'aria-pressed': tab === view.tab, onClick: function () { setView({ tab: tab, offset: 0 }) } }, t({ guide: 'skillsGuide', experiences: 'skillsExperiences', history: 'skillsHistory' }[tab])) })),
        view.revision && h('p', { className: 'note' }, t('skillsVersion') + ' ' + view.revision + ' ', h('button', { onClick: function () { setView({ tab: view.tab, offset: 0 }) } }, t('skillsLatest'))),
        detailBusy && h('p', { role: 'status' }, t('skillsLoading')), detailError && errorBox(detailError),
        !detailBusy && detail && h(React.Fragment, null, h('p', { className: 'muted' }, t('skillsVersion') + ' ' + detail.revision), content,
          h('div', { className: 'pagination' }, h('span', { className: 'muted' }, t('skillsPartial') + ' · ' + (detail.total ? detail.offset + 1 : 0) + '–' + Math.min(detail.offset + detail.limit, detail.total) + ' / ' + detail.total),
            detail.offset > 0 && h('button', { onClick: function () { setView({ tab: view.tab, offset: Math.max(0, detail.offset - detail.limit), revision: view.tab === 'history' ? undefined : detail.revision }) } }, t('skillsPrevious')),
            detail.nextOffset !== null && h('button', { onClick: function () { setView({ tab: view.tab, offset: detail.nextOffset, revision: view.tab === 'history' ? undefined : detail.revision }) } }, t('skillsNext'))))))) )
  }
}
