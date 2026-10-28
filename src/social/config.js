import { readJson, writeJson, keys, text, fail, serial } from './core.js'
import { providerFor } from './providers.js'

/** 配置里只有连接本身：平台、接入方式、地址、凭证引用。
 * 没有模块/连接开关，也没有接收范围或允许名单——配置好一条连接就接收它的消息。 */
export const EMPTY_CONFIG = Object.freeze({ version: 1, connections: [] })
export function validateConfig(raw) {
  keys(raw, ['version', 'connections'])
  if (raw.version !== 1 || !Array.isArray(raw.connections) || raw.connections.length > 16) fail('SOCIAL_INVALID_CONFIG')
  const seen = new Set()
  const connections = raw.connections.map(input => {
    keys(input, ['id', 'platform', 'provider', 'endpoint', 'tokenEnv'])
    if (!text(input.id, 80) || !/^[a-zA-Z0-9_-]+$/.test(input.id) || seen.has(input.id)) fail('SOCIAL_INVALID_CONNECTION')
    seen.add(input.id)
    providerFor(input)
    if (!text(input.endpoint, 2048)) fail('SOCIAL_INVALID_ENDPOINT')
    let url
    try { url = new URL(input.endpoint) } catch { fail('SOCIAL_INVALID_ENDPOINT') }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('SOCIAL_INVALID_ENDPOINT')
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'wss:' && !local) fail('SOCIAL_INSECURE_ENDPOINT')
    if (input.tokenEnv !== undefined && (typeof input.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.tokenEnv))) fail('SOCIAL_INVALID_TOKEN_REFERENCE')
    if (!local && !input.tokenEnv) fail('SOCIAL_TOKEN_REQUIRED')
    return { id: input.id, platform: input.platform, provider: input.provider, endpoint: url.toString(), ...(input.tokenEnv ? { tokenEnv: input.tokenEnv } : {}) }
  })
  return { version: 1, connections }
}
export function createConfigStore(file) {
  const run = serial()
  return {
    read: () => run(async () => validateConfig(await readJson(file, EMPTY_CONFIG))),
    write: raw => run(async () => { const value = validateConfig(raw); await writeJson(file, value); return value }),
  }
}
