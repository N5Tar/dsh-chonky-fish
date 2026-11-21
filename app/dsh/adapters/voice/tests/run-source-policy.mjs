import assert from 'node:assert/strict'
import { createVoiceSourcePolicy } from '../source-policy.js'

const listeners = new Map(), agents = new Map()
const ctx = {
  agents: { get: id => agents.get(id) },
  on(type, callback) { const rows = listeners.get(type) || new Set(); rows.add(callback); listeners.set(type, rows); return () => rows.delete(callback) },
}
const emit = (type, ...args) => { for (const callback of listeners.get(type) || []) callback(...args) }
const sessionId = 'agent-session-1'
const agent = { id: sessionId, status: 'running', phase: { kind: 'running', turn: 7, step: 2 }, session: { sessionId, header: { agentPreset: 'chonkyfish', cwd: '/workspace/fish' } } }
agents.set(sessionId, agent)
const saved = []
const repository = { modelHistoryProjectionVerified: false, saveLabelRule(row) { saved.push(row); return true } }
const provider = { providerId: 'aliyun-qwen-tts', modelId: 'qwen3-tts', voiceId: 'longxiaochun', credentialConfigured: true, emotion: { supported: true }, capabilities: { emotionTags: ['sad', 'excited'] } }
let now = 1000
const policy = createVoiceSourcePolicy({ ctx, repository, getProvider: () => provider, namespaceId: 'host-space', ownerPath: '/workspace/fish', now: () => now })
const ref = { conversationId: sessionId }
const context = { agent: { id: sessionId, session: { sessionId } } }
const claim = (rpcId, text, turn = 7) => emit('agent/inbox/claimed', { agent, turn, message: { source: { kind: 'user', ...(rpcId ? { rpcId } : {}) }, content: [{ type: 'text', text }] } })

assert.deepEqual(policy.register({ conversationRef: ref, inputId: 'input-1', submissionId: 'request-1', text: '语音你好', callRef: { callId: 'call-1' } }), { registered: true })
now += 120_000
assert.equal(policy.inspect().registrations, 1, 'a queued voice registration stays available beyond a fixed TTL')
claim('request-1', '语音你好')
assert.equal(policy.render(context), '', 'automatic prompt injection stays closed until model-history projection has a verified persistence hook')
repository.modelHistoryProjectionVerified = true
const prompt = policy.render(context)
assert.match(prompt, /\[sad\]/)
assert.equal(saved.length, 1, 'the request rule is persisted synchronously before prompt text is returned')
assert.equal(saved[0].owner.namespaceId, 'host-space')
assert.deepEqual(saved[0].rule.tags, ['sad', 'excited'])
assert.equal(saved[0].rule.inputId, 'input-1')
assert.equal(saved[0].rule.submissionId, 'request-1')
assert.equal(saved[0].rule.turn, 7)
assert.equal(saved[0].rule.step, 3, 'prompt assembly before step/start uses the next observed step')

emit('session/event', agent.session, { type: 'step/start', seq: 1, data: { turn: 7, step: 3 } })
assert.equal(policy.render(context), prompt)
assert.equal(saved.at(-1).rule.step, 4)
claim('typed-request', '键盘输入')
assert.equal(policy.render(context), '', 'a newly claimed typed user message overrides the prior voice source')
claim(undefined, 'source id unavailable')
assert.equal(policy.render(context), '', 'a user claim without an rpcId is unknown and never inherits voice')
claim('request-1', '正文摘要不匹配')
assert.equal(policy.render(context), '', 'a matching id with a different body digest is not trusted as voice')
claim('background-1', '后台内容')
assert.equal(policy.render(context), '', 'independent background work does not inherit a voice source')
claim('request-1', '语音你好')
emit('agent/inbox/claimed', { agent, turn: 7, message: { source: { kind: 'tool-call', rpcId: 'tool-step' }, content: [{ type: 'text', text: 'tool' }] } })
assert.match(policy.render(context), /\[sad\]/, 'a tool step in the same turn inherits the consumed voice source')
emit('session/event', agent.session, { type: 'user/message', seq: 2, data: { source: { kind: 'user', rpcId: 'request-1' }, content: [{ type: 'text', text: '语音你好' }] } })
assert.equal(policy.inspect().registrations, 0, 'the source registration is released only after the persisted user/message consumption event')
policy.register({ conversationRef: ref, inputId: 'input-release', submissionId: 'request-release', text: 'release me', callRef: { callId: 'call-1' } })

const replyEvent = { type: 'assistant/message', seq: 40, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'reply' }] } } }
emit('session/event', agent.session, replyEvent)
assert.equal(policy.assertReply({ conversationRef: ref, source: { sessionId, seq: 40 }, event: replyEvent }), true)
const replacement = { type: 'assistant/message', seq: 41, surfaceOp: { op: 'replace', startSeq: 40, endSeq: 40 }, data: { message: { content: [{ type: 'text', text: 'replacement' }] } } }
emit('session/event', agent.session, replacement)
assert.equal(policy.assertReply({ conversationRef: ref, source: { sessionId, seq: 40 }, event: replyEvent }), false, 'replaced assistant messages cannot authorize audio')
assert.equal(policy.release({ conversationRef: ref, submissionId: 'request-release', callRef: { callId: 'other-call' } }), false)
assert.equal(policy.release({ conversationRef: ref, submissionId: 'request-release', callRef: { callId: 'call-1' } }), true)
assert.equal(policy.inspect().registrations, 0)
policy.close()
assert.equal(listeners.get('agent/inbox/claimed').size, 0)
console.log('voice source policy: 1 group passed')
