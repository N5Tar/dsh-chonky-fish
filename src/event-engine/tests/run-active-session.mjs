import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEventEngine } from '../engine.js'

const root = await mkdtemp(join(tmpdir(), 'chonkyfish-active-session-'))
try {
  const engine = createEventEngine({
    file: join(root, 'events.db'),
    workspaceRoot: join(root, 'pond'),
    preset: 'chonkyfish',
    activeSessionId: () => 'session-x',
  })
  const session = {
    id: 'session-x',
    header: { id: 'session-x', agentPreset: 'chonkyfish', cwd: join(root, 'default-workspace') },
  }
  for (const event of [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', seq: 2, data: { role: 'assistant', content: [{ type: 'text', text: '你好呀' }] } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]) {
    assert.equal(engine.feed(session, event), true)
  }
  assert.equal(engine.takeJobs(1).length, 1, '主面板会话即使 cwd 不在小鱼塘也应被采集')

  const other = {
    id: 'session-y',
    header: { id: 'session-y', agentPreset: 'chonkyfish', cwd: join(root, 'default-workspace') },
  }
  assert.equal(engine.feed(other, { type: 'turn/start', seq: 0, data: { turn: 1 } }), false, '不应放宽成任意 chonkyfish 会话')
  engine.close()
  console.log('event-engine active-session: PASS (active panel session captured without pond cwd)')
} finally {
  await rm(root, { recursive: true, force: true })
}
