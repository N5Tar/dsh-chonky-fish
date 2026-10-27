# 大肥鱼模块 0 · LLM 事件结构化引擎（P0–P3 完成，已接线）

把**和小鱼塘里大肥鱼的对话**抽取成可追溯、可审计、可重放的语义事件流。

模块 0 只回答「信息里记录了什么」，不回答「该不该、喜不喜欢、人格是否成长」——
后者属于模块 ①②③④⑤。每条事件都必须能回链到某条 DSH 会话日志记录并附原文引用。

> 状态：**P0–P3 全部完成并已接入 index.js**（44 条用例，全部用 stub，不花 token）。
> 面板右上角「✨ 感知」按钮可查看事件；事件库 `$DSH_HOME/chonkyfish/events.db`。
> 生效方式：重启 DSH（Host 半）→ 刷新页面（客户端半）。

## 会话识别规则（重要）

**联合判断**：鱼鱼会话的身份是一个配对，两半必须同时成立。

```text
fish identity = ( $DSH_HOME/小鱼塘 , 'chonkyfish' )     ← 项目 与 preset 的配对
session.header.cwd ∈ 项目根           且
session.header.agentPreset === preset
且 不是 subagent 子会话（origin !== 'subagent'、delegationDepth === 0）
```

| 项目 | preset | 结论 |
|---|---|---|
| 对 | 对 | ✅ 鱼鱼会话 |
| 对 | 错 | ❌ 同项目里跑的是别的 agent |
| 错 | 对 | ❌ 别的项目里恰好选了鱼鱼 preset |
| 错 | 错 | ❌ |

- 没有任何「单项放行」开关，也不能关闭校验（`pondDir` 缺失直接拒绝启动）。
- 只看 preset 会误收：实测 `workspace/chonky-fish-site`、`workspace/chonkyFish`、
  `workspace/homeSite` 等工作区也出现过 chonkyfish 会话。
- 只看项目会误收：同一个项目里换成别的 preset 跑的是别的 agent。
- subagent 孩子会话继承父会话 cwd，但它们不是和主人的对话，一律排除。

## V1 收窄后的范围

| 决定 | 后果 |
|---|---|
| **删除 `raw_records` 表**，原始内容以 DSH 会话日志 + `(sessionId, seq)` 引用为准 | `recordId` 表达为 `<sessionId>:<seq>`；不存 content / payloadHash / sensitivity |
| **不做确定性工具事件**（不产出 `page_opened` / `tool_action_verified`） | `evidenceStatus` 只剩 `reported / intent / hypothetical / negated / uncertain` |
| **不做隐私外发分级**，直接用 DSH 配置的模型 | 无白名单无脱敏；抽取调用走 `ctx.llm.stream` |
| **不回补历史**，只跟活着的会话 | 重启时缺 `turn/start` 的 turn 直接跳过（`turn_not_buffered`） |
| **联合判断：只收 (小鱼塘项目, chonkyfish) 这个配对的会话** | 单项不满足即不收，无放宽开关 |
| **提取模型 = 该鱼鱼会话自己用的模型**（由 preset 决定，与聊天同一个模型） | 入队时从 `session.requestContext()` 取 provider/model 落 `job.model_id`，失败再退 `agentDefaultModel`；不新增配置项 |
| **词表收紧到 12 类**：邀请/感谢必须带 target | `interaction.invitation_expressed` / `thanks_expressed` 的 `targetRequired: true` |
| **state 三类合并成 `state.self_state_expressed`** | 疲惫/情绪/可用性不再各占一个 type；具体状态放 `target`（如「累」「开心」「没空」） |
| **面板要展示事件** | P3 增加只读「感知」区（事件卡片：时间 / 类型 / 谁 / 事实地位 / 原文引用） |
| 提取按 **turn 聚合**（一个 turn 一个 job） | `extraction_jobs` 唯一键 `(session_id, turn, prompt_version)` |
| 分发用 **消费者游标** 而不是 outbox | 消费者记 `consumer_cursor.last_event_seq`；出现进程外消费者时再加回 outbox |

## 文件地图

```text
src/event-engine/
  domain/event-types.js            事件词表 V1（12 个 type · 单一事实源）
  domain/contracts.js              数据契约 typedef + 纯函数（recordId/文本/去重键/锚定）
  extraction/schema.js             模型输出 JSON Schema（严格，禁多余键）
  extraction/validate.js           迷你 Schema 校验器 + 语义校验
  extraction/event-normalizer.js   候选 → 语义事件（元数据全部程序赋值）
  extraction/prompt.js             系统提示词（类型清单由注册表生成）+ 输入打包
  extraction/payload.js            按 (sessionId, fromSeq..toSeq) 从 DSH 读回 turn 原文
  extraction/extractor.js          ctx.llm.stream 调用 + 一次格式修复重试 + 解析
  extraction/runner.js             任务执行器：领取 → 提取 → 落库 → 结算 → 审计
  delivery/query.js                查询契约（参数/鉴权/传输投影），HTTP 外壳在 index.js
  delivery/consumer.js             游标消费者 + 演示消费者（可订阅 / 可重放）
  adapters/dsh-source.js           `session/event` → turn 收集器（含排除规则）
  engine.js                        引擎：会话识别 + turn→job + 游标 + 租约回收
  persistence/schema.sql           5 表 DDL
  persistence/sqlite.js            node:sqlite 读写层
  tests/fixtures/v1-cases.json     13 条契约样本（P0）
  tests/run-fixtures.mjs           P0 契约测试
  tests/run-pipeline.mjs           P1 采集测试
  tests/run-extraction.mjs         P2 提取测试
  tests/run-delivery.mjs           P3 分发测试
```

## 采集（P1）行为

监听 `session/event`（post-commit、fire-and-forget、监听器抛错被吞不会拖慢聊天）。
`turn/start` 开 buffer，`user/message` / `assistant/message` 收集，`turn/end` 落一个 job。

**排除**：`assistant/attempt`（重试中间流）、`system/message`、`developer/message`、
`request/*`、`step/*`、以及非 `append` 的 surface 事件（compaction/replace 换掉的旧内容）。
**工具事件不进 job**（V1 不做工具事实），但游标照常推进。

审计里会看到的观测/跳过原因：`empty_turn`、`turn_not_buffered`、`duplicate_turn`、
`seq_gap`、`turn_truncated`。

## 契约要点（P0）

- I1 来源不可伪造：`actorRef` / `observedAt` / `span` / `evidenceStatus` / `dedupeKey` 全部程序赋值；
  模型夹带 `toolVerified` / `eventId` 会被 `additionalProperties: false` 拒绝。
- I2 原文锚定：`sourceQuote` 必须逐字出现在**指定** `sourceRecordId` 的文本里。
- I3 `modality`（模型给的语言形态）与 `evidenceStatus`（程序裁定）分离。
- I4 `events: []` 合法；不确定就 `modality: uncertain`。
- 模型只给短 type（`like_expressed`），全限定名由 `qualifyType()` 补全并与 `category` 交叉校验。

拒绝原因码：`invalid_json`、`schema_invalid`、`schema_version_mismatch`、`unknown_type`、
`type_category_mismatch`、`type_not_allowed`、`action_mismatch`、`polarity_not_allowed`、
`modality_not_allowed`、`target_required`、`unknown_record`、`actor_mismatch`、`quote_not_found`。

## 持久化（5 张表）

| 表 | 职责 |
|---|---|
| `ingest_cursor` | 每会话 `last_seq`（只前进），重启后从断点继续观察 |
| `extraction_jobs` | turn 级任务状态机 + `lease_until`（重启回收孤儿任务） |
| `semantic_events` | 唯一产出；`event_seq` 单调给消费者做游标；`UNIQUE(dedupe_key, schema_version)` |
| `consumer_cursor` | 消费者幂等游标 |
| `extraction_audit` | 只追加的拒绝/跳过/观测原因 |

DSH 已提供、我们不再重复的部分：不可改写追加日志、seq 连续性、torn tail 截断、格式
fail-closed、按 seq/类型/时间/全文检索、`readEvent` 上下文窗口、`traceEvent` 替换链、
`readSession` 回放校验。

## 跑测试

```bash
npm run test:event-engine              # P0 契约 13/13
npm run test:event-engine:pipeline     # P1 采集 13/13
npm run test:event-engine:extraction   # P2 提取 12/12
npm run test:event-engine:delivery     # P3 分发 6/6
npm run test:event-engine:all
```

P1 覆盖：识别（配对联合判断 / 单项不满足即忽略 / subagent 排除 / 不可关闭）、turn 聚合、
空 turn、重启不补采、同一 turn 重放幂等、跨进程重启不漏不补、租约回收、游标单调、
seq 空洞只记一次审计。

## 下一步

- **P2 提取**：`extraction/prompt.js` + `extractor.js`，用 `ctx.llm.stream`；模型取该鱼鱼会话
  自己的 `session.requestContext()`（preset 决定，与聊天同模型），不新增配置项。
  只发当前 turn 的原文记录，不回灌人格上下文；提示词的 type 清单由注册表生成，不手写。
  `engine.takeJobs()` / `engine.storeEvents()` / `engine.settleJob()` 已就位。
- **P3 分发**：`/chonkyfish/events` 查询路由 + 演示消费者。
- **接线**：`index.js` 里 `createEventEngine({ file: $DSH_HOME/chonkyfish/events.db, pondDir: $DSH_HOME/小鱼塘 })`
  （pondDir 优先用 `workspaceRegistry` 里「小鱼塘」工作区的实际路径，避免改名后失配）
  + `ctx.on('session/event', (session, event) => engine.feed(session, event))`，约 6 行。
