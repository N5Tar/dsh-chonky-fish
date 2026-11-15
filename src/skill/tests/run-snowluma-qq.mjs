import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKILL_NAME, SKILL_DESCRIPTION, SKILL_WHEN_TO_USE, apply, lumaConnectionIds, readSkillContent } from '../snowluma-qq.js'
import { createResources } from '../../resources/index.js'

assert.equal(SKILL_NAME, 'snowluma-qq')
assert.ok(SKILL_DESCRIPTION.includes('social_account'))
assert.ok(SKILL_WHEN_TO_USE.includes('QQ'))
const content = readSkillContent()
assert.equal(typeof content, 'string')
for (const marker of ['social_account', 'get_self_profile', 'get_qzone_msg_list', 'send_qzone_msg', '写操作只在主人明确要求时做', 'SOCIAL_ACCOUNT_WRITE_UNKNOWN']) {
  assert.ok(content.includes(marker), `SKILL.md 缺少 ${marker}`)
}

const home = await mkdtemp(join(tmpdir(), 'snowluma-skill-'))
const resources = createResources({ homeRoot: home })
await mkdir(resources.paths.social, { recursive: true })
assert.deepEqual(await lumaConnectionIds(resources), [])

let provider
let invalidated = 0
const controller = new AbortController()
const dispose = apply({
  logger: { warn() {} },
  skills: {
    registerProvider(factory) {
      provider = factory({ signal: controller.signal, invalidate() { invalidated += 1 } })
      return () => controller.abort()
    },
  },
}, { resources })
assert.ok(provider)
assert.equal(typeof provider.list, 'function')
assert.equal(typeof provider.get, 'function')
assert.deepEqual(await provider.list(), [], '没有 LumaQQ 连接时技能不应出现')

const config = { version: 1, connections: [{ id: 'qq-main', platform: 'qq', provider: 'snowluma', endpoint: 'ws://127.0.0.1:3001/', token: 't' }] }
await writeFile(resources.paths.socialConfig, JSON.stringify(config, null, 2) + '\n', 'utf8')
assert.deepEqual(await provider.list(), [], '只有配置、还没成功核验身份时技能不应出现')

await writeFile(resources.paths.socialIdentities, JSON.stringify({
  version: 1,
  identities: [{ identity: { connectionId: 'qq-main', platform: 'qq', provider: 'snowluma', protocolUserId: '10001' }, identityRevision: 'r1' }],
}, null, 2) + '\n', 'utf8')
const candidates = await provider.list()
assert.equal(candidates.length, 1)
assert.equal(candidates[0].name, 'snowluma-qq')
assert.equal(candidates[0].provider, 'chonkyfish-snowluma-qq')
assert.equal(candidates[0].invocation.modelInvocable, true)
const loaded = await provider.get(candidates[0])
assert.equal(loaded.content, content)

await writeFile(resources.paths.socialIdentities, JSON.stringify({
  version: 1,
  identities: [{ identity: { connectionId: 'qq-main', platform: 'qq', provider: 'snowluma', protocolUserId: '10001' }, identityRevision: 'r2', pending: { protocolUserId: '10002' } }],
}, null, 2) + '\n', 'utf8')
assert.deepEqual(await provider.list(), [], '待确认新账号时技能不应出现')

dispose()
const patch = await readFile(new URL('../../../cordis.patch.yml', import.meta.url), 'utf8')
assert.ok(patch.includes('chonkyfish-snowluma-qq-skill'), 'cordis.patch.yml 未挂载 snowluma-qq 技能')
assert.ok(patch.includes('skill-snowluma-qq'), 'cordis.patch.yml 未引用 skill-snowluma-qq 导出')
console.log('snowluma-qq skill: PASS (conditional provider, identity gate, content, preset wiring)')
