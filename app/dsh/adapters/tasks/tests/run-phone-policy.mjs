import assert from 'node:assert/strict'
import { createPhoneTaskPolicy } from '../phone-policy.js'
const owner = { id: 'owner' }, other = { id: 'social' }
let active = true
const policy = createPhoneTaskPolicy({ isOwnerAgent: agent => agent === owner, isPhoneActive: () => active })
assert.equal(policy(), '')
assert.equal(policy({ agent: other }), '')
const text = policy({ scope: owner })
assert.ok(text.includes('fish_task_start'))
assert.ok(text.includes('wait:false'))
assert.ok(text.includes('不等待后台任务'))
assert.ok(text.includes('不适用'))
active = false
assert.equal(policy({ agent: owner }), '')
console.log('phone task policy: scoped to the active owner and replaces foreground collection rules')
