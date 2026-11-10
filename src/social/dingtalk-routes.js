import { fail, keys, readJson, serial, text, writeJson } from './core.js'

const EMPTY = { version: 1, routes: [] }
const LIMIT = 1024, PER_CONNECTION = 256
const INVALID = 'SOCIAL_DINGTALK_ROUTES_INVALID'

// These URLs are credentials. This module must never project them into public state.
export function validateDingTalkWebhook(value) {
  try {
    if (!text(value, 4096)) fail(INVALID)
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' || url.port || url.username || url.password || url.hash || url.pathname !== '/robot/sendBySession' || [...url.searchParams.keys()].some(k => k !== 'session') || url.searchParams.getAll('session').length !== 1 || !text(url.searchParams.get('session'), 2048)) fail(INVALID)
    return url.href
  } catch { fail(INVALID) }
}
function binding(config) {
  if (!text(config?.id, 80) || !text(config?.clientId, 256) || !text(config?.robotCode, 256)) fail(INVALID)
  return { connectionId: config.id, clientId: config.clientId, robotCode: config.robotCode }
}
function bindingKey(value) { return JSON.stringify([value.connectionId, value.clientId, value.robotCode]) }
function targetKey(value) { return JSON.stringify([value.type, value.id]) }
export function validateDingTalkRoute(value) {
  try {
    keys(value, ['conversation', 'url', 'expires', 'staffId', 'updatedAt'])
    keys(value.conversation, ['type', 'id'])
    if (!['direct', 'group'].includes(value.conversation.type) || !text(value.conversation.id, 256) || !Number.isSafeInteger(value.expires) || value.expires <= 0) fail(INVALID)
    if (value.staffId !== undefined && (value.conversation.type !== 'direct' || !text(value.staffId, 256))) fail(INVALID)
    if (value.updatedAt !== undefined && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) fail(INVALID)
    return { conversation: { type: value.conversation.type, id: value.conversation.id }, url: validateDingTalkWebhook(value.url), expires: value.expires, ...(value.staffId !== undefined ? { staffId: value.staffId } : {}), ...(value.updatedAt !== undefined ? { updatedAt: value.updatedAt } : {}) }
  } catch { fail(INVALID) }
}
export function retainDingTalkRoute(route, at) {
  return route.expires > at || (route.conversation.type === 'direct' && (route.staffId !== undefined || route.updatedAt !== undefined))
}
export function mergeDingTalkRoutes(previous, next) {
  if (!previous) return next
  const newer = (next.updatedAt ?? 0) >= (previous.updatedAt ?? 0) ? next : previous
  const older = newer === next ? previous : next
  const chosen = next.expires >= previous.expires ? next : previous
  const staffId = newer.staffId ?? older.staffId
  const updatedAt = newer.updatedAt ?? older.updatedAt
  return { conversation: next.conversation, url: chosen.url, expires: chosen.expires,
    ...(staffId !== undefined ? { staffId } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) }
}
function validate(value) {
  try {
    keys(value, ['version', 'routes'])
    if (value.version !== 1 || !Array.isArray(value.routes) || value.routes.length > LIMIT) fail(INVALID)
    const counts = new Map(), seen = new Set()
    const routes = value.routes.map(row => {
      keys(row, ['binding', 'conversation', 'url', 'expires', 'staffId', 'updatedAt'])
      keys(row.binding, ['connectionId', 'clientId', 'robotCode'])
      const owner = binding({ id: row.binding.connectionId, clientId: row.binding.clientId, robotCode: row.binding.robotCode })
      const { binding: _binding, ...input } = row
      const route = validateDingTalkRoute(input)
      const key = bindingKey(owner), unique = JSON.stringify([key, targetKey(route.conversation)])
      if (seen.has(unique) || (counts.get(owner.connectionId) || 0) >= PER_CONNECTION) fail(INVALID)
      seen.add(unique); counts.set(owner.connectionId, (counts.get(owner.connectionId) || 0) + 1)
      return { binding: owner, ...route }
    })
    return { version: 1, routes }
  } catch { fail(INVALID) }
}

export function createDingTalkRouteStore(file, { now = Date.now } = {}) {
  const run = serial()
  async function read() {
    try { return validate(await readJson(file, EMPTY)) } catch { fail(INVALID) }
  }
  async function save(value) {
    try { await writeJson(file, value) } catch { fail('SOCIAL_DINGTALK_ROUTES_WRITE_FAILED') }
  }
  return {
    load: config => run(async () => {
      const owner = bindingKey(binding(config)), stored = await read()
      const routes = stored.routes.filter(row => retainDingTalkRoute(row, now()))
      if (routes.length !== stored.routes.length) await save({ version: 1, routes })
      return routes.filter(row => bindingKey(row.binding) === owner).map(({ binding: _, ...route }) => structuredClone(route))
    }),
    remember: (config, input) => run(async () => {
      const owner = binding(config), ownerKey = bindingKey(owner), route = validateDingTalkRoute(input)
      const stored = await read() // A malformed file must never be overwritten, even for an expired input.
      let routes = stored.routes.filter(row => retainDingTalkRoute(row, now()))
      if (retainDingTalkRoute(route, now())) {
        const same = row => bindingKey(row.binding) === ownerKey && targetKey(row.conversation) === targetKey(route.conversation)
        const previous = routes.find(same)
        routes = routes.filter(row => !same(row))
        routes.push({ binding: owner, ...mergeDingTalkRoutes(previous, route) })
        let count = routes.filter(row => row.binding.connectionId === owner.connectionId).length
        routes = routes.filter(row => row.binding.connectionId !== owner.connectionId || count-- <= PER_CONNECTION)
        if (routes.length > LIMIT) routes = routes.slice(-LIMIT)
      }
      await save({ version: 1, routes })
    }),
  }
}
