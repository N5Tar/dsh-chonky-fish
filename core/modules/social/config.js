import { readJson, writeJson, keys, text, fail, serial } from './core.js'
import { providerFor } from './providers.js'

/** 配置里只有连接本身：OneBot 保留凭证引用，钉钉密钥值只保存在本机私有配置。
 * 没有模块/连接开关，也没有接收范围或允许名单——配置好一条连接就接收它的消息。 */
export const EMPTY_CONFIG = Object.freeze({ version: 1, connections: [] })
export function validateConfig(raw) {
  keys(raw, ['version', 'connections'])
  if (raw.version !== 1 || !Array.isArray(raw.connections) || raw.connections.length > 16) fail('SOCIAL_INVALID_CONFIG')
  const seen = new Set()
  const connections = raw.connections.map(input => {
    const isDingTalk = input?.provider === 'dingtalk-stream'
    keys(input, isDingTalk
      ? ['id', 'platform', 'provider', 'clientId', 'clientSecret', 'clientSecretEnv', 'robotCode']
      : ['id', 'platform', 'provider', 'endpoint', 'tokenEnv'])
    if (!text(input.id, 80) || !/^[a-zA-Z0-9_-]+$/.test(input.id) || seen.has(input.id)) fail('SOCIAL_INVALID_CONNECTION')
    seen.add(input.id)
    providerFor(input)
    if (isDingTalk) {
      if (!text(input.clientId, 256) || !/^[A-Za-z0-9_-]+$/.test(input.clientId)) fail('SOCIAL_DINGTALK_INVALID_CLIENT_ID')
      if (!text(input.robotCode, 256) || !/^[A-Za-z0-9_-]+$/.test(input.robotCode)) fail('SOCIAL_DINGTALK_INVALID_ROBOT_CODE')
      if (input.clientSecret !== undefined) {
        if (!text(input.clientSecret, 8192) || input.clientSecretEnv !== undefined) fail('SOCIAL_DINGTALK_SECRET_INVALID')
      } else {
        // Read compatibility only: old files remain readable, but the service no longer
        // resolves DingTalk secrets from the process environment. UI asks for a value.
        if (typeof input.clientSecretEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.clientSecretEnv)) fail('SOCIAL_DINGTALK_SECRET_MISSING')
      }
      return { id: input.id, platform: input.platform, provider: input.provider, clientId: input.clientId,
        ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : { clientSecretEnv: input.clientSecretEnv }), robotCode: input.robotCode }
    }
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
/** Public management projection: never send a stored DingTalk secret back to the browser. */
export function publicConfig(config) {
  return { version: config.version, connections: config.connections.map(value => {
    if (value.provider !== 'dingtalk-stream') return { ...value }
    const { clientSecret, clientSecretEnv, ...visible } = value
    return { ...visible, clientSecretSet: text(clientSecret, 8192) }
  }) }
}

/** An omitted/empty secret retains only the same connection AND application binding. */
export function mergeConfigSecrets(input, previous) {
  keys(input, ['version', 'connections'])
  if (!Array.isArray(input.connections)) fail('SOCIAL_INVALID_CONFIG')
  return { ...input, connections: input.connections.map(value => {
    if (value?.provider !== 'dingtalk-stream') return value
    keys(value, ['id', 'platform', 'provider', 'clientId', 'robotCode', 'clientSecret', 'clientSecretSet'])
    if (value.clientSecretSet !== undefined && typeof value.clientSecretSet !== 'boolean') fail('SOCIAL_INVALID_INPUT')
    const { clientSecretSet, ...next } = value
    if (next.clientSecret !== undefined && next.clientSecret !== '') return next
    const old = previous.connections.find(row => row.id === next.id && row.platform === next.platform && row.provider === next.provider && row.clientId === next.clientId && row.robotCode === next.robotCode)
    if (old?.clientSecret !== undefined) next.clientSecret = old.clientSecret
    else if (old?.clientSecretEnv !== undefined) { delete next.clientSecret; next.clientSecretEnv = old.clientSecretEnv }
    else fail('SOCIAL_DINGTALK_SECRET_MISSING')
    return next
  }) }
}

export function createConfigStore(file, { syncDirectory = async () => {} } = {}) {
  const run = serial()
  return {
    read: () => run(async () => validateConfig(await readJson(file, EMPTY_CONFIG))),
    write: raw => run(async () => { const value = validateConfig(raw); try { validateConfig(await readJson(file, EMPTY_CONFIG)) } catch { fail('SOCIAL_CONFIG_RECOVERY_REQUIRED') } await writeJson(file, value, { syncDirectory }); return value }),
  }
}
