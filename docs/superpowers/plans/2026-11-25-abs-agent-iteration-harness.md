# ABS Agent 迭代台本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do not git commit unless the user explicitly asks.**

**Goal:** 落地 Agent 编排的 ABS 迭代基建（协议文档、评分表、只读快照/汇总脚本、轮次模板），使首轮 `chat_owner` 内容实验可复现开跑。

**Architecture:** 纯文档 + 仓库内 Node ESM 脚本。脚本只读 DSH 本机 HTTP（`/chonkyfish/abs`、`/chonkyfish/abs/activities`），把脱敏摘要写到 `docs/abs-iteration/cycles/`；统计逻辑抽成可单测的纯函数，用 fixtures 离线测，不依赖真实 DSH。不改 ABS 运行时策略，不改 `review.js` 文案（留给 Cycle R01）。

**Tech Stack:** Node.js ESM、`node:assert/strict`、本机 `fetch`、现有 ABS HTTP 契约。

**Spec:** [docs/superpowers/specs/2026-11-25-abs-agent-iteration-loop-design.md](../specs/2026-11-25-abs-agent-iteration-loop-design.md)

---

## File structure

| Path | Responsibility |
|---|---|
| `docs/abs-iteration/protocol.md` | 操作清单（PDCA、门禁、倍速/1× 窗） |
| `docs/abs-iteration/scorecard.md` | 内容评分表与过关线 |
| `docs/abs-iteration/cycles/_template.md` | 轮次记录模板 |
| `docs/abs-iteration/cycles/.gitkeep` | 保留目录 |
| `docs/abs-iteration/snapshots/.gitignore` | 忽略原始 JSON 快照 |
| `scripts/abs-iteration/lib/summarize-chat-owner.mjs` | 纯函数：从 activities 页统计 `chat_owner` |
| `scripts/abs-iteration/lib/format-cycle-fragment.mjs` | 纯函数：把 inspect+汇总打成 Markdown 片段 |
| `scripts/abs-iteration/snapshot.mjs` | CLI：拉 HTTP → 写 JSON（gitignore）+ 打印/写出 MD 片段 |
| `scripts/abs-iteration/summarize.mjs` | CLI：读已有 JSON 快照 → 打印汇总 |
| `scripts/abs-iteration/tests/fixtures/activities-page.json` | 离线 fixture |
| `scripts/abs-iteration/tests/run-summarize.mjs` | 汇总单测 |
| `scripts/abs-iteration/tests/run-format.mjs` | MD 片段单测 |
| `.gitignore` | 追加 snapshots 规则（若根 ignore 未覆盖） |
| `package.json` | 可选：`test:abs-iteration` 脚本 |

**Out of scope for this plan:** 修改 `core/modules/abs/review.js`、selector 阈值、本机 ABS mode/timeScale（那是用户确认后的 Cycle 步骤，不是台本基建）。

---

### Task 1: 协议与评分文档

**Files:**
- Create: `docs/abs-iteration/protocol.md`
- Create: `docs/abs-iteration/scorecard.md`
- Create: `docs/abs-iteration/cycles/_template.md`
- Create: `docs/abs-iteration/cycles/.gitkeep`
- Create: `docs/abs-iteration/snapshots/.gitignore`

- [ ] **Step 1: 写 `scorecard.md`**

内容必须与 spec §5.2 一致，可直接复制为操作版：

```markdown
# ABS 迭代 · 内容评分表（chat_owner）

## 样本
主样本：`actionSelection.intent === 'chat_owner'` 且 `dispatchStatus === 'enqueued'`。

评分材料：ABS 行动提示摘要 + 鱼可见回复短摘录（≤80 字）+ 用户标注。
**禁止**把私人对话全文写入 cycles。

## 维度（每条 0–2）

| 维度 | 0 | 1 | 2 |
|---|---|---|---|
| 由头 | 只有「想聊天」/空泛 | 弱由头（时间戳、泛情绪） | 具体可接话由头 |
| 自然度 | 状态报告/机械催促 | 可读但模板感重 | 像角色随口想到 |
| 打扰感 | 催促或重复逼问 | 可接受 | 轻松、允许不回 |

用户标签：有意思 / 一般 / 重复 / 打扰。

## 内容窗过关
- 同窗 ≥3 条有效样本
- 「有意思或一般」≥2/3
- 无「打扰」
- 由头均分 ≥1.5

## 禁止误读
倍速次数 ≠ 1× 日频次；ReviewDelivered ≠ 找过主人；可见回复 ≠ 主人已读；模型自报 ≠ 已执行。
```

- [ ] **Step 2: 写 `protocol.md`**

必须包含：角色（Agent 跑、用户验收）、单行动锁定 `chat_owner`、PDCA 五步、内容窗（60× / 60–90 分钟墙钟）、频次窗（1×）、单旋钮门禁、旋钮顺序 1–6（与 spec §6 一字不差的优先级）、rest 临时修改必须还原、T3 `schedule_task` 唤醒复盘、命令入口：

```bash
# 需要本机 DSH 已加载插件且 HTTP 可达
export CHONKYFISH_HTTP_BASE='http://127.0.0.1:<dsh-port>'
node scripts/abs-iteration/snapshot.mjs --date YYYY-MM-DD --out docs/abs-iteration/snapshots/Rnn.json
node scripts/abs-iteration/summarize.mjs docs/abs-iteration/snapshots/Rnn.json
```

- [ ] **Step 3: 写 `_template.md`**

固定章节：`Meta`（日期、轮次、旋钮、timeScale、假设）、`Baseline`（粘贴 summarize 输出）、`Samples`（每条：episodeId、提示摘要、回复摘录、三维分、标签）、`Decision`（保留/回滚/下一旋钮）、`Rest/config restore checklist`。

- [ ] **Step 4: snapshots ignore**

`docs/abs-iteration/snapshots/.gitignore`:

```gitignore
*
!.gitignore
```

- [ ] **Step 5: 自检文档**

确认三份 md 无 TBD；protocol 明确「本基建不含改 review.js」。不 commit。

---

### Task 2: `summarizeChatOwner` 纯函数（TDD）

**Files:**
- Create: `scripts/abs-iteration/lib/summarize-chat-owner.mjs`
- Create: `scripts/abs-iteration/tests/fixtures/activities-page.json`
- Create: `scripts/abs-iteration/tests/run-summarize.mjs`

- [ ] **Step 1: 写 fixture**

`scripts/abs-iteration/tests/fixtures/activities-page.json`（最小合法 activities 页形状）：

```json
{
  "ok": true,
  "summary": {
    "opportunities": 4,
    "actionSelections": {
      "total": 3,
      "byIntent": { "chat_owner": 2, "continue_interest": 1 },
      "byStatus": { "enqueued": 2, "preview": 1 }
    }
  },
  "episodes": [
    {
      "id": "ep-chat-1",
      "wakeAt": "2026-11-25T02:00:00.000Z",
      "actionSelection": {
        "intent": "chat_owner",
        "reason": "selected",
        "score": 0.8,
        "dispatchStatus": "enqueued",
        "selectedAt": "2026-11-25T02:00:01.000Z",
        "visibleAt": "2026-11-25T02:00:20.000Z",
        "resolvedAt": "2026-11-25T02:00:21.000Z",
        "resolutionReason": "visible_reply_committed"
      },
      "choice": { "kind": "continue", "summary": "想跟主人打个招呼" },
      "result": "no_action"
    },
    {
      "id": "ep-chat-2",
      "wakeAt": "2026-11-25T03:00:00.000Z",
      "actionSelection": {
        "intent": "chat_owner",
        "reason": "selected",
        "score": 0.7,
        "dispatchStatus": "enqueued",
        "selectedAt": "2026-11-25T03:00:01.000Z",
        "visibleAt": null,
        "resolvedAt": "2026-11-25T03:01:00.000Z",
        "resolutionReason": "completed_without_output"
      },
      "choice": null,
      "result": "no_action"
    },
    {
      "id": "ep-blocked",
      "wakeAt": "2026-11-25T04:00:00.000Z",
      "actionSelection": {
        "intent": null,
        "reason": "no_candidate",
        "score": null,
        "dispatchStatus": "suppressed",
        "selectedAt": "2026-11-25T04:00:01.000Z",
        "visibleAt": null,
        "resolvedAt": null,
        "resolutionReason": null
      },
      "choice": null,
      "result": "deferred"
    },
    {
      "id": "ep-explore",
      "wakeAt": "2026-11-25T05:00:00.000Z",
      "actionSelection": {
        "intent": "continue_interest",
        "reason": "selected",
        "score": 0.6,
        "dispatchStatus": "enqueued",
        "selectedAt": "2026-11-25T05:00:01.000Z",
        "visibleAt": null,
        "resolvedAt": null,
        "resolutionReason": null
      },
      "choice": null,
      "result": "verified"
    }
  ]
}
```

- [ ] **Step 2: 写失败测试**

`scripts/abs-iteration/tests/run-summarize.mjs`:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { summarizeChatOwner } from '../lib/summarize-chat-owner.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
const page = JSON.parse(readFileSync(join(dir, 'fixtures/activities-page.json'), 'utf8'))
const summary = summarizeChatOwner(page)

assert.equal(summary.chatOwner.enqueued, 2)
assert.equal(summary.chatOwner.withVisibleReply, 1)
assert.equal(summary.chatOwner.withoutVisibleReply, 1)
assert.equal(summary.chatOwner.samples.length, 2)
assert.equal(summary.chatOwner.samples[0].episodeId, 'ep-chat-1')
assert.equal(summary.chatOwner.samples[0].choiceSummary, '想跟主人打个招呼')
assert.equal(summary.otherIntents.continue_interest?.enqueued, 1)
assert.equal(summary.blockedOrSuppressed, 1)
console.log('abs-iteration summarize: ok')
```

- [ ] **Step 3: 跑测试确认失败**

```bash
node scripts/abs-iteration/tests/run-summarize.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` 或类似（库文件尚不存在）。

- [ ] **Step 4: 实现纯函数**

`scripts/abs-iteration/lib/summarize-chat-owner.mjs`:

```js
/**
 * @param {{ episodes?: any[], summary?: any }} page activities HTTP 页（可带 ok 包装）
 */
export function summarizeChatOwner(page) {
  if (!page || typeof page !== 'object') throw new TypeError('activities page required')
  const episodes = Array.isArray(page.episodes) ? page.episodes : []
  const chatSamples = []
  const otherIntents = {}
  let blockedOrSuppressed = 0

  for (const episode of episodes) {
    const selection = episode?.actionSelection
    if (!selection) continue
    const intent = selection.intent
    const status = selection.dispatchStatus
    if (intent == null || status === 'suppressed') {
      blockedOrSuppressed += 1
      continue
    }
    if (intent !== 'chat_owner') {
      const bucket = otherIntents[intent] ?? { enqueued: 0, other: 0 }
      if (status === 'enqueued') bucket.enqueued += 1
      else bucket.other += 1
      otherIntents[intent] = bucket
      continue
    }
    if (status !== 'enqueued') continue
    chatSamples.push({
      episodeId: episode.id,
      wakeAt: episode.wakeAt ?? null,
      score: selection.score ?? null,
      reason: selection.reason ?? null,
      visibleAt: selection.visibleAt ?? null,
      resolutionReason: selection.resolutionReason ?? null,
      choiceSummary: typeof episode.choice?.summary === 'string' ? episode.choice.summary.slice(0, 80) : null,
      result: episode.result ?? episode.outcome ?? null,
    })
  }

  const withVisibleReply = chatSamples.filter((row) => row.visibleAt).length
  return {
    chatOwner: {
      enqueued: chatSamples.length,
      withVisibleReply,
      withoutVisibleReply: chatSamples.length - withVisibleReply,
      samples: chatSamples,
    },
    otherIntents,
    blockedOrSuppressed,
    pageSummary: page.summary ?? null,
  }
}
```

- [ ] **Step 5: 再跑测试**

```bash
node scripts/abs-iteration/tests/run-summarize.mjs
```

Expected: 打印 `abs-iteration summarize: ok`，exit 0。

---

### Task 3: Markdown 片段格式化（TDD）

**Files:**
- Create: `scripts/abs-iteration/lib/format-cycle-fragment.mjs`
- Create: `scripts/abs-iteration/tests/run-format.mjs`

- [ ] **Step 1: 写失败测试**

```js
import assert from 'node:assert/strict'
import { formatCycleFragment } from '../lib/format-cycle-fragment.mjs'
import { summarizeChatOwner } from '../lib/summarize-chat-owner.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const page = JSON.parse(readFileSync(join(dir, 'fixtures/activities-page.json'), 'utf8'))
const absInspect = {
  state: {
    config: {
      mode: 'active',
      timeScale: 1,
      reviewIntervalMinutes: 120,
      reviewMinRealGapMinutes: 10,
      restHours: { enabled: true, start: '23:00', end: '08:00' },
      drives: { social: { satisfaction: 0.4, setpoint: 0.75, decayPerHour: 0.008 } },
      feedback: { ownerMessageGain: 0.05, explorationGain: 0.15 },
    },
  },
}
const md = formatCycleFragment({
  cycleId: '2026-11-25-R00',
  capturedAt: '2026-11-25T06:00:00.000Z',
  abs: absInspect,
  chatSummary: summarizeChatOwner(page),
})
assert.match(md, /2026-11-25-R00/)
assert.match(md, /timeScale:\s*1/)
assert.match(md, /chat_owner enqueued:\s*2/)
assert.match(md, /ep-chat-1/)
assert.doesNotMatch(md, /私人|password|token/i)
console.log('abs-iteration format: ok')
```

- [ ] **Step 2: 跑测确认失败** → 实现 `formatCycleFragment`

实现要求：

- 只输出 config 标量与 social drive 数字、chat_owner 计数、每条 sample 的 `episodeId / wakeAt / choiceSummary / visibleAt / result`。
- **不**输出完整 `records`、工具参数、会话正文。
- `choiceSummary` 已在 summarize 截断到 80 字。

示例实现骨架：

```js
export function formatCycleFragment({ cycleId, capturedAt, abs, chatSummary }) {
  const cfg = abs?.state?.config ?? abs?.config ?? {}
  const social = cfg.drives?.social ?? {}
  const lines = [
    `## Baseline fragment · ${cycleId}`,
    `- capturedAt: ${capturedAt}`,
    `- mode: ${cfg.mode ?? 'unknown'}`,
    `- timeScale: ${cfg.timeScale ?? 'unknown'}`,
    `- reviewIntervalMinutes: ${cfg.reviewIntervalMinutes ?? 'unknown'}`,
    `- reviewMinRealGapMinutes: ${cfg.reviewMinRealGapMinutes ?? 'unknown'}`,
    `- restHours: ${cfg.restHours ? `${cfg.restHours.enabled} ${cfg.restHours.start}-${cfg.restHours.end}` : 'unknown'}`,
    `- social: sat=${social.satisfaction ?? '?'} set=${social.setpoint ?? '?'} decay/h=${social.decayPerHour ?? '?'}`,
    `- chat_owner enqueued: ${chatSummary.chatOwner.enqueued}`,
    `- chat_owner visibleReply: ${chatSummary.chatOwner.withVisibleReply}`,
    `- blockedOrSuppressed: ${chatSummary.blockedOrSuppressed}`,
    '',
    '### Samples (desensitized)',
  ]
  for (const sample of chatSummary.chatOwner.samples) {
    lines.push(`- ${sample.episodeId} @ ${sample.wakeAt}: choice="${sample.choiceSummary ?? ''}" visibleAt=${sample.visibleAt ?? 'null'} result=${sample.result ?? 'null'}`)
  }
  lines.push('', '_Reply excerpts ≤80 chars: fill manually in cycle md; not present in ABS activities API._')
  return lines.join('\n')
}
```

- [ ] **Step 3: 测试通过**

```bash
node scripts/abs-iteration/tests/run-format.mjs
```

Expected: `abs-iteration format: ok`。

---

### Task 4: CLI `snapshot.mjs` / `summarize.mjs`

**Files:**
- Create: `scripts/abs-iteration/snapshot.mjs`
- Create: `scripts/abs-iteration/summarize.mjs`
- Modify: `package.json`（增加 `test:abs-iteration`）

- [ ] **Step 1: 实现 `summarize.mjs` CLI**

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { summarizeChatOwner } from './lib/summarize-chat-owner.mjs'
import { formatCycleFragment } from './lib/format-cycle-fragment.mjs'

const path = process.argv[2]
if (!path) {
  console.error('Usage: node scripts/abs-iteration/summarize.mjs <snapshot.json>')
  process.exit(2)
}
const snap = JSON.parse(readFileSync(path, 'utf8'))
const chatSummary = summarizeChatOwner(snap.activities)
const md = formatCycleFragment({
  cycleId: snap.cycleId ?? 'unknown',
  capturedAt: snap.capturedAt ?? '',
  abs: snap.abs,
  chatSummary,
})
process.stdout.write(md + '\n')
```

- [ ] **Step 2: 实现 `snapshot.mjs` CLI**

行为：

1. 读取 `CHONKYFISH_HTTP_BASE`（必填，无默认端口猜测）；缺省则 exit 2 并打印用法。
2. 参数：`--date YYYY-MM-DD`（Asia/Shanghai 日，传给 activities）、`--cycle 2026-11-25-R00`、`--out path.json`（默认 `docs/abs-iteration/snapshots/<cycle>.json`）。
3. `GET ${base}/chonkyfish/abs` 与 `GET ${base}/chonkyfish/abs/activities?date=...&limit=100`。
4. 若 `page.hasMore`，按 `nextCursor.beforeWakeAt` + `beforeEpisodeId` + `snapshotSeq` 继续翻页，合并 `episodes`（最多 5 页，防失控）。
5. 写入 JSON：`{ cycleId, capturedAt, httpBaseHostOnly, abs: { state: inspect.state, environment: inspect.environment }, activities: { summary, episodes, window } }`——**不要**写入 `records` 全量审计、不要写 `export` 原文。
6. 同时 stdout 打印 `formatCycleFragment(...)`。
7. HTTP 非 2xx：exit 1，stderr 短错误，不写半文件（先写 `.tmp` 再 rename）。

`httpBaseHostOnly` 只存 hostname:port，便于复现，避免把 query token 写进文件（当前 ABS 无 token，仍保持习惯）。

- [ ] **Step 3: 用 fixture 冒烟 summarize CLI**

```bash
node -e "
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('docs/abs-iteration/snapshots',{recursive:true});
writeFileSync('docs/abs-iteration/snapshots/_fixture.json', JSON.stringify({
  cycleId:'fixture', capturedAt:'2026-11-25T06:00:00.000Z',
  abs:{ state:{ config:{ mode:'shadow', timeScale:1, reviewIntervalMinutes:120, reviewMinRealGapMinutes:10,
    restHours:{enabled:true,start:'23:00',end:'08:00'},
    drives:{social:{satisfaction:0.5,setpoint:0.75,decayPerHour:0.008}} } } },
  activities: JSON.parse(await import('node:fs').then(fs=>fs.readFileSync('scripts/abs-iteration/tests/fixtures/activities-page.json','utf8')))
}, null, 2));
"
node scripts/abs-iteration/summarize.mjs docs/abs-iteration/snapshots/_fixture.json
rm docs/abs-iteration/snapshots/_fixture.json
```

Expected: stdout 含 `chat_owner enqueued: 2`。

- [ ] **Step 4: package.json 脚本**

在 `package.json` 的 `scripts` 中增加：

```json
"test:abs-iteration": "node scripts/abs-iteration/tests/run-summarize.mjs && node scripts/abs-iteration/tests/run-format.mjs"
```

- [ ] **Step 5: 跑测试**

```bash
npm run test:abs-iteration
```

Expected: 两行 ok，exit 0。

---

### Task 5: 验收清单与 R00 骨架（不停本机 ABS）

**Files:**
- Create: `docs/abs-iteration/cycles/2026-11-25-R00.md`（仅当本机 HTTP 可达时填真实 baseline；否则创建标注 `pending-live-snapshot` 的骨架）

- [ ] **Step 1: 根 `.gitignore` 双保险**

若根 `.gitignore` 没有 snapshots 规则，追加：

```gitignore
docs/abs-iteration/snapshots/*
!docs/abs-iteration/snapshots/.gitignore
```

- [ ] **Step 2: 尝试 live snapshot（只读）**

仅当用户提供 `CHONKYFISH_HTTP_BASE` 且 DSH 在跑：

```bash
export CHONKYFISH_HTTP_BASE='...'
node scripts/abs-iteration/snapshot.mjs --date 2026-11-25 --cycle 2026-11-25-R00
```

把 stdout 片段粘进 `docs/abs-iteration/cycles/2026-11-25-R00.md`。  
**禁止**在本任务里改 timeScale / mode / review.js。

若 HTTP 不可达：R00 写明 `pending-live-snapshot`，仍保留模板字段；不算失败——基建以离线测试为准。

- [ ] **Step 3: Spec 对照自检**

| Spec 要求 | 任务 |
|---|---|
| protocol.md / scorecard.md | Task 1 |
| snapshot / summarize 脚本 | Task 2–4 |
| cycles 可写轮次 | Task 1 模板 + Task 5 R00 |
| 不改 review 文案 | 全计划 Out of scope |
| 原始 JSON 不提交 | snapshots gitignore |
| 倍速只验内容 / 单旋钮 | protocol.md 门禁 |

- [ ] **Step 4: 交付说明（写在 PR/回复里，不 commit）**

告知用户：基建已就绪；下一动作是 **Cycle R01**（用户确认后只改 `review.js` 的 `chat_owner` 模板）→ 设 60× 内容窗 → `schedule_task` 复盘。

---

## Self-review (plan vs spec)

1. **Spec coverage:** §4 协议 → Task 1 protocol；§5 度量 → scorecard + summarize；§6 旋钮顺序 → protocol（本计划不实施旋钮变更）；§7 落点 → 全部文件表；§9 验收 → Task 5。  
2. **Placeholders:** 无 TBD；HTTP base 用必填 env，不伪造端口。  
3. **Consistency:** `summarizeChatOwner` / `formatCycleFragment` 签名在 Task 2–4 一致；样本字段与 activities SQLite/HTTP 形状对齐（`visibleAt`、`choice.summary`）。  
4. **已知产品缺口（写入 protocol，不假装脚本已解决）：** activities API **不含**会话回复正文与 ABS 提示全文；提示可对照当前 `renderActionPrompt`；回复摘录须人工填 cycles。

---

## Execution handoff

Plan complete and saved to [`docs/superpowers/plans/2026-11-25-abs-agent-iteration-harness.md`](/Users/jinyan/workspace/chonkyFish/docs/superpowers/plans/2026-11-25-abs-agent-iteration-harness.md).

**Two execution options:**

1. **Subagent-Driven (recommended)** — 每个 Task 派生子代理，任务间审查  
2. **Inline Execution** — 本会话按 executing-plans 连续做完

Which approach?
