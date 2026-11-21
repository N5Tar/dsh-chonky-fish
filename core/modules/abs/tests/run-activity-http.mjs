import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { createAbsActivitiesHttpHandler } from '../../../../app/dsh/adapters/abs/http.js'

const calls = []
const service = {
  activities: query => { calls.push(query); return { window: { from: query.from, to: query.to, timeZone: 'Asia/Shanghai', complete: false, runtimeWindows: [], gaps: [] }, summary: { opportunities: 0 }, episodes: [], interests: [], page: { limit: query.limit, total: 0, hasMore: false, nextCursor: null } } },
  async annotateActivity(value) { calls.push(value); return { activityId: value.episodeId, label: value.label, active: value.active, at: '2026-11-18T10:00:00.000Z' } },
}
const handler = createAbsActivitiesHttpHandler({ service, maxBodyBytes: 256, now: () => Date.parse('2026-11-18T10:00:00.000Z') })
async function request(method, url, body = '') {
  const input = Readable.from(body ? [Buffer.from(body)] : [])
  Object.assign(input, { method, url, headers: {} })
  let result = {}
  await handler(input, { writeHead(status, headers) { result.status = status; result.headers = headers }, end(raw) { result.body = raw === undefined ? undefined : JSON.parse(raw) } })
  return result
}

let result = await request('GET', '/chonkyfish/abs/activities?date=2026-11-18&limit=20&beforeWakeAt=2026-11-18T09%3A00%3A00.000Z&beforeEpisodeId=episode-7&snapshotSeq=50')
assert.equal(result.status, 200)
assert.equal(calls[0].from, '2026-11-17T16:00:00.000Z')
assert.equal(calls[0].to, '2026-11-18T16:00:00.000Z')
assert.equal(calls[0].beforeWakeAt, '2026-11-18T09:00:00.000Z')
assert.equal(calls[0].beforeEpisodeId, 'episode-7')
assert.equal(calls[0].snapshotSeq, 50)
result = await request('HEAD', '/chonkyfish/abs/activities')
assert.equal(result.status, 200)
assert.equal(result.body, undefined)
assert.equal(calls[1].from, '2026-11-17T16:00:00.000Z', 'default date is the current Asia/Shanghai day')
for (const url of [
  '/?date=2026-02-30', '/?limit=101', '/?offset=4', '/?beforeWakeAt=2026-11-18T09%3A00%3A00.000Z', '/?date=2026-11-18&date=2026-11-18',
  '/?from=2026-11-18T00:00:00Z', '/?unknown=x', '/?outcome=nope', '/?snapshotSeq=-1',
]) assert.equal((await request('GET', url)).status, 400, url)
result = await request('GET', '/?outcome=deferred&snapshotAt=2026-11-18T10:00:00.000Z&snapshotSeq=4')
assert.equal(result.status, 200)
assert.equal(calls.at(-1).outcome, 'deferred')
assert.equal(calls.at(-1).snapshotSeq, 4)
result = await request('POST', '/', JSON.stringify({ action: 'annotate', activityId: 'a1', label: 'interesting', active: true }))
assert.equal(result.status, 200)
assert.deepEqual(result.body.result, { activityId: 'a1', label: 'interesting', active: true, at: '2026-11-18T10:00:00.000Z' })
for (const body of ['{"action":"annotate","activityId":"a","label":"bad","active":true}', '{"action":"annotate","activityId":"a","label":"interesting","active":true,"extra":1}', 'x'.repeat(257)]) {
  assert.ok([400,413].includes((await request('POST', '/', body)).status), body.slice(0,30))
}
console.log('ABS activity HTTP: route contract and validation passed')
