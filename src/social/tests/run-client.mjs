import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const client = await readFile(join(root, 'client.js'), 'utf8')
const spec = await readFile(join(root, 'src/resources/spec.js'), 'utf8')

// The built bundle must actually ship the panel entry, not only the Host route.
for (const marker of ['social-button', 'social-panel', 'function socialApi', 'function socialView', 'function socialSaveConfig', 'SOCIAL_ERROR_LABELS']) {
  assert.ok(client.includes(marker), `client.js 缺少 ${marker}（先运行 node build.mjs）`)
}
// Existing panels must survive the rebuild.
for (const marker of ['diary-panel', 'sense-panel', 'wallet-panel']) {
  assert.ok(client.includes(marker), `client.js 丢失 ${marker}`)
}
// The route comes from the shared resource spec, not a hardcoded string in the page.
assert.ok(spec.includes("social: '/chonkyfish/social'"), '资源规格缺少社交路由')
assert.ok(client.includes('/chonkyfish/social'), 'client.js 未包含社交路由投影')
// The panel must not offer an implicit auto-reply switch or a direct send action.
// The panel keeps only connection essentials: no switches, scope pickers or allowlists.
for (const removed of ['social-module-enabled', 'social-enabled', 'social-direct', 'social-group', 'social-channel', 'social-allowlist', 'allowedConversations', 'inbound']) {
  assert.equal(client.includes(removed), false, `client.js 不应再有 ${removed}`)
}

// Every static id the page controller looks up must exist in the shipped markup
// (client.js holds the final PAGE_HTML, including the confirm dialog appended by build.mjs).
const runtime = await readFile(join(root, 'src/runtime.js'), 'utf8')
const lookedUp = new Set([...runtime.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(match => match[1]))
const missing = [...lookedUp].filter(id => !client.includes(`id=\\"${id}\\"`))
assert.deepEqual(missing, [], `runtime.js 引用了 markup 中不存在的 id：${missing.join(', ')}`)
console.log('social-client: PASS (panel entry, panels preserved, no implicit reply/send surface)')
