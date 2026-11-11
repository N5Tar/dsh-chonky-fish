export function createFakeDriver(config, { protocolUserId = '10001', sendResult = { status: 'accepted', messageId: 'fake-send' } } = {}) {
  let callbacks = null, running = false
  const sent = []
  const identity = { connectionId: config.id, platform: config.platform, provider: config.provider, protocolUserId, verifiedAt: new Date().toISOString() }
  return {
    connectionId: config.id, sent,
    async start(value) { callbacks = value; running = true; callbacks.onStatus('connected') },
    async stop() { running = false },
    async getSelfIdentity() { return structuredClone(identity) },
    async sendText(input) { if (!running) return { status: 'failed', errorCode: 'SOCIAL_NOT_CONNECTED' }; sent.push(structuredClone(input)); return structuredClone(sendResult) },
    async emit(message) { if (!running) throw new Error('fake driver stopped'); return callbacks.onMessage({ ...message, connectionId: config.id, platform: config.platform, provider: config.provider, self: structuredClone(identity) }) },
  }
}
