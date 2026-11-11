var MIGRATION_ZH = {
  navSettings: '设置', settingsSubtitle: '管理大肥鱼的资料与运行偏好', migrationTitle: '资料导入 / 导出', migrationIntro: '在另一台电脑上继续保留大肥鱼的养成资料。',
  migrationIncluded: '包含：身份与人格、钱包与账本、日记、活动技能库、通用偏好。', migrationExcluded: '不包含：聊天、工作区、事件记忆、社交连接和定时任务。',
  migrationExport: '导出资料', migrationImport: '导入资料', migrationSelect: '选择 .fishpack 文件', migrationPrivacy: '资料包含有人格、账本、日记和个人资料，请妥善保管。自定义个人资料目录不会自动打包。',
  migrationReplace: '导入会整体替换上述五类资料。现有资料会先备份；其他数据保持不变。电脑活动采集与主动投递不会自动开启。', migrationConfirm: '确认替换', migrationCancel: '取消', migrationWorking: '正在处理资料…', migrationBusy: '正在准备导出…', migrationDone: '资料已恢复。', migrationDownload: '下载资料包', migrationReady: '检查完成，请确认要替换当前资料。', migrationError: '操作未完成，当前资料未确认改变。', migrationRecovery: '恢复未能自动完成。请保留备份并联系维护人员。', migrationCount: '项', migrationBytes: '字节', migrationRestart: '部分偏好需要重启 DSH 后生效。', migrationWarnCustomProfile: '自定义资料目录未包含', migrationWarnBrowserProfile: '浏览器运行资料未包含', migrationWarnAutonomous: '导入后不会自动启用主动行为', migrationUnsafePath: '个人资料中包含不支持的链接或特殊文件；请移除后重试。', migrationInvalidData: '资料内容无法通过校验，未导出或修改现有资料。', migrationTooLarge: '资料包超过大小限制。', migrationBusyError: '资料正在写入，请稍后重试。',
}
var MIGRATION_EN = {
  navSettings: 'Settings', settingsSubtitle: 'Manage ChonkyFish data and preferences', migrationTitle: 'Transfer data', migrationIntro: 'Carry ChonkyFish’s saved data to another computer.',
  migrationIncluded: 'Includes: identity and persona, wallet and ledger, diaries, skills, general preferences.', migrationExcluded: 'Excludes: chats, workspace, event memories, social connections and scheduled tasks.',
  migrationExport: 'Export data', migrationImport: 'Import data', migrationSelect: 'Choose a .fishpack file', migrationPrivacy: 'The archive contains private persona, ledger, diary and profile data. Custom profile directories are not included automatically.',
  migrationReplace: 'Import replaces these five data groups. Existing data is backed up first; other data remains unchanged. Activity collection and proactive delivery stay off.', migrationConfirm: 'Replace data', migrationCancel: 'Cancel', migrationWorking: 'Processing data…', migrationBusy: 'Preparing export…', migrationDone: 'Data restored.', migrationDownload: 'Download archive', migrationReady: 'Validation complete. Confirm to replace current data.', migrationError: 'Operation did not complete. Current data was not confirmed changed.', migrationRecovery: 'Automatic recovery failed. Keep the backup and contact support.', migrationCount: 'items', migrationBytes: 'bytes', migrationRestart: 'Some preferences require a DSH restart.', migrationWarnCustomProfile: 'Custom profile directory excluded', migrationWarnBrowserProfile: 'Browser runtime profile excluded', migrationWarnAutonomous: 'Autonomous actions stay off after import', migrationUnsafePath: 'The profile contains an unsupported link or special file. Remove it and try again.', migrationInvalidData: 'Data validation failed. No current data was changed.', migrationTooLarge: 'The data archive exceeds the size limit.', migrationBusyError: 'Data is being written. Try again shortly.',
}
Object.assign(zh, MIGRATION_ZH)
Object.assign(en, MIGRATION_EN)
function createMigrationSettings(t) {
  return function MigrationSettings() {
    var endpoint = (window.__CHONKYFISH_STATE__?.routes || RESOURCES.routes)
    var exportUrl = endpoint.migrationExport || RESOURCES.routes.migrationExport
    var inspectUrl = endpoint.migrationImportInspect || RESOURCES.routes.migrationImportInspect
    var commitUrl = endpoint.migrationImportCommit || RESOURCES.routes.migrationImportCommit
    var cancelUrl = endpoint.migrationImportCancel || RESOURCES.routes.migrationImportCancel
    var fileRef = React.useRef(null)
    var statePair = React.useState({ busy: false, exportId: null, preview: null, message: '', error: false })
    var state = statePair[0], setState = statePair[1]
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
    return h('section', { className: 'cf-migration cf-module' }, h('style', null, MODULE_SURFACE + '\n.cf-migration{--mig-blue:#326fa8;--mig-blue-hover:#285d91;height:100%;overflow:auto;background:var(--dsw-alias-bg-base,#f7faff);color:var(--dsw-alias-label-primary,#213b55);font:14px/1.65 var(--dsw-font-family,system-ui)}.cf-migration .inner{max-width:900px;margin:auto;padding:42px 48px}.cf-migration header{border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:24px;margin-bottom:28px}.cf-migration h1{font-size:32px;margin:0 0 8px}.cf-migration h2{font-size:20px;margin:30px 0 8px}.cf-migration p{color:var(--dsw-alias-label-secondary,#71849a);margin:8px 0}.cf-migration .actions{display:flex;gap:12px;margin:24px 0}.cf-migration button{font:inherit;font-weight:600;color:var(--dsw-alias-label-primary,#213b55);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d7e3ee);border-radius:8px;padding:10px 16px;cursor:pointer;transition:background-color .16s ease,border-color .16s ease,color .16s ease,transform .16s ease}.cf-migration button:hover:not(:disabled){background:#edf4fa;border-color:#b8ccdf}.cf-migration button:active:not(:disabled){transform:translateY(1px)}.cf-migration button.primary{color:#fff;background:var(--dsw-alias-brand-primary,var(--mig-blue));border-color:var(--dsw-alias-brand-primary,var(--mig-blue));box-shadow:0 2px 5px rgb(33 79 121 / 16%)}.cf-migration button.primary:hover:not(:disabled){color:#fff;background:var(--mig-blue-hover);border-color:var(--mig-blue-hover)}.cf-migration button:disabled{opacity:.5;cursor:wait}.cf-migration .notice{padding:14px 16px;border-left:3px solid var(--dsw-alias-brand-primary,var(--mig-blue));background:var(--dsw-alias-bg-layer-1,#eef4f9);color:var(--dsw-alias-label-primary,#29435d);white-space:pre-line}.cf-migration .error{color:var(--dsw-alias-label-danger,#b42318)}.cf-migration .counts{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0}.cf-migration .counts span{padding:8px 12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#60768d);border:1px solid var(--dsw-alias-border-l1,#dbe5ef);border-radius:8px}.cf-migration :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}@container (max-width:650px){.cf-migration .inner{padding:26px 20px}.cf-migration .actions{flex-wrap:wrap}}'),
      h('div', { className: 'inner' },
        h('header', null, h('h1', null, t('navSettings')), h('p', null, t('settingsSubtitle'))),
        h('h2', null, t('migrationTitle')), h('p', null, t('migrationIntro')),
        h('p', null, t('migrationIncluded')), h('p', null, t('migrationExcluded')),
        h('div', { className: 'notice' }, t('migrationPrivacy')),
        h('div', { className: 'actions' },
          h('button', { className: 'primary', disabled: state.busy, onClick: exportData }, t('migrationExport')),
          h('button', { disabled: state.busy, onClick: function () { fileRef.current?.click() } }, t('migrationImport')),
          h('input', { ref: fileRef, type: 'file', accept: '.fishpack,application/zip', hidden: true, onChange: selectFile, 'aria-label': t('migrationSelect') })),
        state.preview && h(React.Fragment, null,
          h('h2', null, state.exportId ? t('migrationExport') : t('migrationTitle')),
          !state.exportId && h('div', { className: 'notice' }, t('migrationReplace')),
          h('div', { className: 'counts' }, Object.keys(counts || {}).map(function (key) { return h('span', { key: key }, key + ': ' + counts[key] + ' ' + t('migrationCount')) })),
          state.preview.bytes && h('p', null, t('migrationBytes') + ': ' + state.preview.bytes),
          h('p', null, (state.preview.warnings || []).map(function (key) { var labels = { 'custom-profile-path-not-included': 'migrationWarnCustomProfile', 'browser-profile-excluded': 'migrationWarnBrowserProfile', 'autonomous-actions-disabled-on-import': 'migrationWarnAutonomous' }; return labels[key] ? t(labels[key]) : key }).join(' · ')),
          state.exportId ? h('button', { className: 'primary', onClick: download }, t('migrationDownload')) : h('div', { className: 'actions' }, h('button', { disabled: state.busy, onClick: cancelImport }, t('migrationCancel')), h('button', { className: 'primary', disabled: state.busy, onClick: commit }, t('migrationConfirm')))),
        state.message && h('p', { role: state.error ? 'alert' : 'status', className: state.error ? 'error' : '' }, state.message)))
  }
}
