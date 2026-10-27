/**
 * 大肥鱼模块 0 · P0 契约测试（不需要 LLM、不需要 DSH 运行时）。
 *
 *   node src/event-engine/tests/run-fixtures.mjs
 *
 * 对每条 fixture 跑同一套流水线：
 *   modelOutput → JSON 解析 → Schema 校验 → 登记表/锚定/来源校验 → 归一化
 * 断言产出事件集合与期望一致，并额外检查几条全局不变量。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { EVIDENCE_STATUSES, SCHEMA_VERSION } from '../domain/event-types.js'
import { normalizeCandidates } from '../extraction/event-normalizer.js'
import { parseAndValidateOutput, validateCandidates } from '../extraction/validate.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, 'fixtures', 'v1-cases.json')
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'))

const CLASSIFIER = { model: 'fixture-stub', promptVersion: 'v1', runId: 'fixture-run' }

function runCase(testCase) {
  const parsed = parseAndValidateOutput(
    testCase.modelOutputRaw !== undefined ? testCase.modelOutputRaw : testCase.modelOutput,
  )
  if (!parsed.ok) {
    const codes = new Set([parsed.reason, ...parsed.rejects.map((entry) => entry.code)])
    return { events: [], codes, candidates: [] }
  }
  const { candidates, rejections } = validateCandidates(parsed.output, testCase.turn)
  const events = normalizeCandidates({ candidates, turn: testCase.turn, classifier: CLASSIFIER })
  const codes = new Set(rejections.map((entry) => entry.reason))
  return { events, codes, candidates }
}

function compareEvents(actual, expected, caseId, failures) {
  if (actual.length !== expected.length) {
    failures.push(caseId + ': 事件数量 ' + actual.length + ' ≠ 期望 ' + expected.length)
    return
  }
  expected.forEach((want, index) => {
    const got = actual[index]
    const fields = ['type', 'evidenceStatus', 'polarity', 'actorRef', 'quote']
    for (const field of fields) {
      const gotValue = field === 'quote' ? got.sourceRefs?.[0]?.quote : got[field]
      if (want[field] !== undefined && gotValue !== want[field]) {
        failures.push(caseId + '#' + index + ': ' + field + ' = ' + JSON.stringify(gotValue) + '，期望 ' + JSON.stringify(want[field]))
      }
    }
    if (want.target !== undefined) {
      const gotTarget = got.target ? got.target.value : undefined
      if (gotTarget !== want.target) {
        failures.push(caseId + '#' + index + ': target = ' + JSON.stringify(gotTarget) + '，期望 ' + JSON.stringify(want.target))
      }
    }
  })
}

function main() {
  const failures = []
  let passed = 0

  for (const testCase of fixtures.cases) {
    const before = failures.length
    const { events, codes } = runCase(testCase)
    compareEvents(events, testCase.expect.events ?? [], testCase.id, failures)
    for (const code of testCase.expect.rejectCodes ?? []) {
      if (!codes.has(code)) {
        failures.push(testCase.id + ': 缺少拒绝原因 ' + code + '（实际 ' + [...codes].join(',') + '）')
      }
    }
    if (failures.length === before) passed += 1
  }

  // ---- 全局不变量（跨所有 case 聚合） ----
  const allEvents = fixtures.cases.flatMap((testCase) => runCase(testCase).events)
  for (const event of allEvents) {
    if (event.schemaVersion !== SCHEMA_VERSION) failures.push('不变量: schemaVersion 不等于 ' + SCHEMA_VERSION)
    if (!EVIDENCE_STATUSES.includes(event.evidenceStatus)) failures.push('不变量: 非法 evidenceStatus ' + event.evidenceStatus)
    if (event.evidenceStatus === 'tool_verified' || event.evidenceStatus === 'system_observed') {
      failures.push('不变量: V1 不应产生工具验证/系统观测事实')
    }
    if (event.occurredAt !== null) failures.push('不变量: V1 不解析相对时间，occurredAt 必须为 null')
    if (!Array.isArray(event.sourceRefs) || event.sourceRefs.length === 0) failures.push('不变量: 事件必须有 sourceRefs')
    for (const ref of event.sourceRefs ?? []) {
      if (!ref.recordId.includes(':')) failures.push('不变量: recordId 必须是 <sessionId>:<seq> 形式')
      if (typeof ref.quote !== 'string' || ref.quote.length === 0) failures.push('不变量: 语言事件必须有原文 quote')
      if (typeof ref.spanStart !== 'number' || ref.spanEnd <= ref.spanStart) failures.push('不变量: span 非法')
    }
    if (typeof event.dedupeKey !== 'string' || event.dedupeKey.length !== 64) failures.push('不变量: dedupeKey 必须是 sha256')
    if (!event.classifier || event.classifier.promptVersion !== 'v1') failures.push('不变量: 事件必须带 classifier 溯源')
    if (event.actorRef !== 'owner' && event.actorRef !== 'persona:dafeiyu') failures.push('不变量: 主体越界 ' + event.actorRef)
  }

  // ---- 重放幂等：同一输入跑两次，dedupeKey 集合必须一致 ----
  for (const testCase of fixtures.cases) {
    const first = runCase(testCase).events.map((event) => event.dedupeKey).sort()
    const second = runCase(testCase).events.map((event) => event.dedupeKey).sort()
    if (first.length !== second.length || first.some((key, index) => key !== second[index])) {
      failures.push(testCase.id + ': 重放后 dedupeKey 不稳定')
    }
  }

  const total = fixtures.cases.length
  console.log('模块0 P0 契约测试 · ' + fixtures.name)
  console.log('用例: ' + total + ' · 通过: ' + passed + ' · 事件样本: ' + allEvents.length)
  if (failures.length === 0) {
    console.log('结果: PASS')
    return 0
  }
  console.log('结果: FAIL (' + failures.length + ')')
  for (const failure of failures) console.log('  - ' + failure)
  return 1
}

process.exitCode = main()
