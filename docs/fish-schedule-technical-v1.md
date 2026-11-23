# 大肥鱼内部日程 · 技术方案 V1

- 日期：2026-11-23
- 状态：技术方案（三轮评审缺口已锁死），尚未实现；下文「新增/拟议」路径与接口均不存在于当前交付
- 产品依据：[大肥鱼内部日程设计 V1](./fish-schedule-design-v1.md)
- 本次仅技术文档，不改功能代码、不提交推送

## 1. 核心决策

1. 独立模块名 `schedule`（磁盘文件 `schedule.json`；工具名 `fish_schedule`，避免与 DSH `schedule_*` 混淆）。
2. 到点行为唯一：复用 proactive 投递端口（`resolveAgent` → idle → `followup` → `flush`）；`source.kind = 'chonkyfish-schedule'`，并带 `form: 'notice'`（对齐 nudge，标准 UI 按 notice 渲染）。
3. Host 侧单一装甲循环：`setTimeout` 对准最近可唤醒时刻；扫描带 `scanGeneration`；dispose 清定时器。
4. 持久化：原子 JSON（tmp + rename + syncDirectory）；条目 `version` 乐观锁在 **service**（进程内写队列下校验）；体量 ≤50，不上 SQLite。
5. 时钟：真实墙钟 + IANA `timezone`（默认 `Asia/Shanghai`）；**不**读 ABS `timeScale`；计算用 **`Intl.DateTimeFormat`（与 memory 同模式）**，禁止 `Date#getTimezoneOffset`，不引入 luxon/Temporal 新依赖。
6. 硬切换：`chonkyfish` preset 去掉 `@deepseek-ai/dsh-tool-schedule`；不迁移 DSH 旧提醒；**不进** `.fishpack`（实现时确认 migration 白名单不新增 schedule）。
7. 控制面：工具可写；HTTP 仅 `GET`；面板只读。
8. 投递幂等：同文件有界 **fires** 痕迹；键 `(scheduleId, fireId)`；已 `delivered` 禁止再投。

## 2. 现状与接入点

| 现有位置 | 当前职责 | 本方案如何接入 |
|---|---|---|
| [Host 入口](../app/dsh/host/index.js) | 模块 install、layoutReady、dispose | `installSchedule`：ready 后 hydrate → miss-scan → arm；dispose 停表 |
| [资源规格](../core/contracts/spec.js) | 路径/路由/限额单一事实源 | 增 `FILES.schedule`、`ROUTES.schedule`、`LIMITS.schedule`、`SCHEMA_VERSION.schedule = 1` |
| [资源管理器](../app/shared/resources/index.js) | home 布局、paths、config | `paths.schedule`；ensureLayout 可不预建文件（缺则 hydrate 空文档） |
| [投递](../app/dsh/adapters/proactive/delivery.js) | 会话 followup + flush | **复用** `createDeliverer`；扩展可选 `source`（见 §6） |
| [proactive 状态](../app/shared/resources) `proactive.json` | `activeSessionId` | 与 ABS 相同：只读该字段；无会话 → `skipped_no_session` + 退避 |
| [memory 时区](../core/modules/memory/core.js) | `Intl` + `Asia/Shanghai` | `next-fire` 复用同一模式，按条目 `timezone` 参数化 |
| [日记工具](../core/modules/diary/tools.js) | 文案引用 `schedule_create` | 改为 `fish_schedule` |
| [cordis 补丁](../app/dsh/packaging/cordis.patch.yml) | preset 挂 DSH schedule | 删除两处 `@deepseek-ai/dsh-tool-schedule` |
| [客户端构建](../app/dsh/build.mjs) | 面板拼装 | 设置页加「鱼鱼的日程」只读区块；不手改生成产物 |
| [migration](../core/modules/migration) | 资料包白名单 | **确认不加入** schedule.json |
| [tasks / ABS](../core/modules/tasks) | 外部作业 / 内在时钟 | **不**复用、不合并队列 |

投递约束与 proactive 相同：只允许鱼鱼身份会话；失败路径记 fires outcome，不抛未捕获异常打断 Host。

## 3. 架构与模块归属

```text
鱼鱼工具 fish_schedule          只读面板 GET /chonkyfish/schedule
            │                              │
            ▼                              ▼
     app/dsh/adapters/schedule
       index.js · host.js · http.js（注册工具，不二次定义）
            │
            ▼
     core/modules/schedule
       schema · next-fire · backoff · service · tools
            │
            ▼
     app/shared/storage/schedule/repository.js
            │
            ▼
     delivery（proactive createDeliverer + schedule source）
```

### 3.1 建议文件结构（拟新增）

```text
core/modules/schedule/
  schema.js          # 文档/条目/fires 校验、常量、错误码
  next-fire.js       # once/daily/weekly → nextFireAt（纯函数，可注入「现在」）
  backoff.js         # 阶梯、跨槽判定、once 放弃（纯函数）
  service.js         # CRUD；missSkip；scan 决策；mark*；fires 追加/裁剪与幂等查询
  tools.js           # fish_schedule 工具对象定义（对齐 diary：定义在 core）
  index.js           # 正文即 item.prompt，不另建 narration.js
  tests/

app/shared/storage/schedule/
  repository.js      # load / saveAtomic / 进程内写队列（不做 version 业务判断）

app/dsh/adapters/schedule/
  index.js           # installSchedule；register(tools.createFishScheduleTool(...))
  host.js            # arm / scan / scanGeneration / dispose
  http.js            # GET only

app/dsh/ui/settings/ # 或既有 preferences 页内嵌
  schedule-panel.js  # 只读列表 + 脚注
```

**工具位置锁定：** 只在 `core/modules/schedule/tools.js` 定义；adapter 只 `register`，不复制一份 `tools.js`。

### 3.2 职责约束

| 层 | 可以 | 不可以 |
|---|---|---|
| `next-fire` / `backoff` | 纯计算、可单测 | 读文件、碰 ctx、设定时器 |
| `service` | 编排、**条目 version CAS**、fires 幂等/裁剪、miss/退避语义；`mark*` 在写队列内 reload 后条件更新 | 直接 `setTimeout`、直接 followup |
| `repository` | 整文档原子读写、写队列串行化 | 解释 `version`、跨槽、recurrence |
| `host` | 定时器、扫描上限、续扫间隔、调 deliverer；**CRUD/`rearm` 递增 `scanGeneration`** | 自己算 nextFire / 退避公式副本；用扫描开始时的旧快照覆盖新文档 |
| `tools` / `http` | 参数映射、错误码外露 | 第二套持久化路径 |
| 面板 | 展示 GET 结果 | 任何写操作 |

## 4. 数据契约

### 4.1 文件

- 路径：`$DSH_HOME/chonkyfish/schedule.json`（`FILES.schedule = 'schedule.json'`）
- 编码：UTF-8；写入 2 空格缩进 + 尾换行
- 原子写：`*.tmp` → `rename` → `platform.syncDirectory(dirname)`
- **坏 JSON**：fail-closed——打日志、**不**静默覆盖为空文档；模块不 arm；工具/HTTP 返回 `INTERNAL` / 503 类直至人工修复或显式 reset 工具/运维手段（v1 可不做 reset API，文档说明即可）

### 4.2 根文档

```ts
type ScheduleDoc = {
  schemaVersion: 1
  timezoneDefault: string        // "Asia/Shanghai"
  items: ScheduleItem[]          // ≤ maxItems（enabled+disabled 合计）
  fires: FireRecord[]            // 有界痕迹；裁剪规则见 §4.3.1
}

type FireRecord = {
  fireId: string
  scheduleId: string
  attemptedAt: string            // ISO UTC
  outcome:
    | 'delivered'
    | 'skipped_busy'
    | 'skipped_no_session'
    | 'flush_failed'
    | 'skipped_missed_on_boot'
    | 'dropped_crossed_slot'
}
```

缺文件 / 空文件：hydrate 为  
`{ schemaVersion: 1, timezoneDefault: 'Asia/Shanghai', items: [], fires: [] }`（可懒落盘）。

### 4.3 条目（无独立 `onceAt` 字段）

```ts
type ScheduleItem = {
  id: string
  version: number                // 从 1 起；每次成功写 +1（service 校验）
  enabled: boolean
  title: string                  // ≤ maxTitleChars
  prompt: string                 // ≤ maxPromptChars；到点 content 即此字段
  delivery: 'session'            // 写死；其它值校验失败
  recurrence: 'once' | 'daily' | 'weekly'
  /** once：可解析为唯一 UTC 的 ISO 瞬时；daily/weekly：本地 "HH:mm"（24h） */
  at: string
  timezone: string               // IANA；默认取 timezoneDefault
  daysOfWeek?: number[]          // weekly 必填；∈ 0–6；去重升序
  nextFireAt: string | null
  lastFiredAt: string | null
  activeFireId: string | null
  backoffUntil: string | null
  backoffStep: number            // 无退避为 0
  /** 本逻辑 due 首次 transient skip 的 UTC ISO；无退避为 null。用于累计 30m 上限 */
  backoffOriginAt: string | null
  createdAt: string
  updatedAt: string
}
```

**`at` 锁定（与产品设计一致）：**

| recurrence | `at` 含义 | 工具入参 |
|---|---|---|
| `once` | UTC ISO 瞬时（创建时把主人给的本地墙钟/`YYYY-MM-DDTHH:mm`+timezone 规范化后写入） | 可收本地墙钟串，**落盘恒为 ISO UTC** |
| `daily` / `weekly` | 本地 `HH:mm` | 同左 |

不新增 `onceAt` 字段。list/面板对 once 可再格式化为本地展示，但不双写存储。

### 4.3.1 fires 裁剪与幂等（锁定）

- 追加后若 `fires.length > maxFireRecords`：从**最旧**删起；**凡 `(scheduleId, fireId)` 仍等于任一条目当前 `activeFireId` 的记录一律不裁**（含在途 skip 与「已 delivered 尚未清 fire」的撕裂窗）。
- 受保护项过多时允许短暂超过上限，打 warn；优先幂等。
- **`markDelivered` 原子性：** `fires` 追加 `delivered`、清该条 `activeFireId`/退避字段、推进 `nextFireAt`（或 once disable）、`version++` —— **同一次** `saveAtomic`。

### 4.4 投递 source

```js
{
  kind: 'chonkyfish-schedule',
  form: 'notice',
  scheduleId: item.id,
  fireId: item.activeFireId,
  title: item.title,
}
```

面板过滤：`source.kind !== 'user'` 即隐藏为主发言（现逻辑已覆盖）。  
memory / 事件引擎：按非 `user` 跳过；若某处是 kind 白名单，实现时把 `chonkyfish-schedule` 列入。

### 4.5 限额（写入 spec `LIMITS.schedule`）

| 键 | 值 |
|---|---|
| `maxItems` | 50 |
| `maxTitleChars` | 80 |
| `maxPromptChars` | 2000 |
| `maxScanDeliveries` | 5 |
| `scanContinueMs` | 5000 |
| `maxFireRecords` | 200 |
| `maxBackoffAccumMs` | 30 * 60 * 1000 |
| `backoffStepsMs` | `[60e3, 120e3, 300e3, 600e3, 900e3]` |
| `maxTimerMs` | `2 ** 31 - 1` |

## 5. 核心算法（纯函数契约）

### 5.1 `computeNextFireAt(item, fromInstant)`

- 使用条目自身 `timezone`（及 `at` / `daysOfWeek`）。
- **once**：若 `at`（ISO）`> from` → 该瞬时；否则 `null`（调用方 `enabled=false`）。
- **daily**：`timezone` 下严格晚于 `from` 的下一个本地 `HH:mm`。
- **weekly**：下一个本地日 ∈ `daysOfWeek` 且时刻为 `HH:mm`、严格晚于 `from`。
- **时区实现锁定**：`Intl.DateTimeFormat('en-US', { timeZone, ... }).formatToParts`（参照 `memory/core.js` 的 `shanghaiStamp`），可注入 `now`；单测固定 Shanghai 样例。禁止猜系统本地 offset。

### 5.2 启动漏点 `missSkip`（与产品设计对齐）

**仅进程 boot 后的第一次扫描**执行一次（`install`/`ready` 后首轮）；运行中再次 hydrate、CRUD、续扫、休眠醒来**都不再**跑 missSkip。

对每条 `enabled && nextFireAt != null && nextFireAt < now`：

→ **一律不投递**（含「崩溃前正在退避」的条目）：

- 记 `fires`：`skipped_missed_on_boot`（若当时有 `activeFireId` 则写入该 id，否则新分配仅用于痕迹的一次性 id，**不**保留为 active）
- 清 `activeFireId`、`backoffUntil`、`backoffStep`、`backoffOriginAt`
- `once` → `enabled=false`，`nextFireAt=null`
- `daily`/`weekly` → `nextFireAt = computeNextFireAt(item, now)`

**取舍说明：** 与设计不变量「启动凡过点不投」一致；重启等于放弃当前枪。见 §13。

### 5.3 退避与跨槽

```text
阶梯: 1m → 2m → 5m → 10m → 15m（之后停在 15m）
累计上限: 30m = now - backoffOriginAt（见字段）

onTransientSkip(item, now, logicalSlotEnd, outcome):
  追加 fires(outcome)
  if backoffOriginAt == null: backoffOriginAt = now
  accum = now - backoffOriginAt
  nextBackoff = now + steps[min(backoffStep, last)]
  if nextBackoff >= logicalSlotEnd OR accum >= maxBackoffAccumMs:
    → dropCurrentSlot + fires(dropped_crossed_slot)
       once: enabled=false；清 fire/backoff/backoffOriginAt
       else: nextFireAt = computeNextFireAt(item, 丢槽锚点)；清 fire/backoff/backoffOriginAt
  else:
    → backoffUntil = nextBackoff; backoffStep++

logicalSlotEnd:
  once: 宽限终点 = backoffOriginAt + maxBackoffAccumMs（与阶梯终点较早者触发放弃）
  daily/weekly: 当前槽应到点 T（本 due 的 nextFireAt）之「下一 recurrence 点」
```

清退避时（delivered / drop / missSkip / update 改调度）：`backoffUntil`、`backoffStep`、`backoffOriginAt`、`activeFireId` 一并清空。

**fireId：**

- 进入 due 且 `activeFireId == null` → 新 UUID 并写入。
- 退避重试：**不**换 id。
- 投递前：若 `fires` 已有同 `(scheduleId, fireId)` 且 `outcome === 'delivered'` → **禁止再投**；在写队列内 `repairAdvance`（推进/disable + 清 fire），不双发 followup。

### 5.4 扫描（Host）与并发写

**单条尝试锁定顺序（唯一写法）：**

```text
1) 写队列内：reload → 若条目仍 due → ensure activeFireId（若 null 则分配并 saveAtomic）
             → 若 alreadyDelivered(scheduleId, fireId)：repairAdvance + saveAtomic；结束本条
2) 记下 fireId、prompt、source；若 gen != scanGeneration：不再发起新的 deliver（本条放弃尝试）
2b) sessionId = getActiveSessionId()；若无会话：不 deliver，直接步骤 4 的 onTransientSkip(skipped_no_session)
3) 锁外：result = await deliver(sessionId, prompt, source)   # 仅当步骤 2/2b 通过
4) 写队列内（不论 gen 是否已变）：
     reload → 按 id + activeFireId === fireId 条件更新
     if result.ok: markDelivered（§4.3.1 同次原子 save）     # 禁止因 gen 变化而跳过
     else: onTransientSkip(skipped_busy | skipped_no_session | flush_failed)
```

整轮扫描：

```text
onTimer / onWake:
  gen = ++scanGeneration
  若尚未做过 bootMissSkip：missSkip 一次并打标（仅此一次）
  snapshot = load()                    # 只枚举 due，不作写回底稿
  due = sort(snapshot due candidates)
  delivered = 0
  hitCap = false
  for itemRef in due:
    if gen != scanGeneration: break    # 不再启动新的 ensure/deliver；已在途的步骤 4 仍要跑完
    if delivered >= maxScanDeliveries:
      hitCap = true
      break
    执行「单条尝试」步骤 1–4
    if 本条 markDelivered 成功: delivered++
  if hitCap: arm(now + scanContinueMs)
  else if gen == scanGeneration: arm(nextWakeFromDoc())
  else: # CRUD 已 rearm，本轮不再二次 arm
```

**并发锁定：**

1. **CRUD / enable / disable / `rearm()`** → **`scanGeneration++`**：取消后续**新的** ensure/deliver；**不得**用扫描开始时的旧整本 `doc` 写回。
2. **`deliver` 已返回之后的 `markDelivered` / 对应的 `onTransientSkip`：不得因 `scanGeneration` 变化而跳过**；只按 `id` + `activeFireId === 本条 fireId` 条件更新，不匹配则 no-op（避免双投与错改）。
3. generation 升高只影响「是否还开新枪」；已成功进 inbox 的枪必须落盘推进或由条件更新确认条目已变。
4. `dispose`：`scanGeneration++`、`clearTimeout`；在途步骤 4 仍应尽量跑完（host closing 时可 best-effort）。

**装甲延迟：** `delay = target - now` 夹紧到 `[0, maxTimerMs]`（`2^31-1`）。更远的 once 先睡到上限再 `arm` 重算。

**休眠：** 不补历史；触顶 5 条则 `scanContinueMs`（5s）续扫。

## 6. 投递复用

**锁定方案 A：** 扩展 `createDeliverer`：

```ts
deliver(sessionId: string, text: string, options?: { source?: object })
```

- 缺省 `source` → 仍为 `NUDGE_SOURCE`（proactive 回归不变）。
- schedule 传入 §4.4。
- **禁止**在 schedule adapter 复制 followup 四步。

**正文锁定：** `content` 文本 = `item.prompt`（无 narration 包装层；`title` 只在 `source` 与面板）。  
工具 description 写明：不是主人指令；到点只是旁白；行动自定。

## 7. 工具 `fish_schedule`

| action | 入参要点 | 行为 |
|---|---|---|
| `create` | title, prompt, recurrence, at, timezone?, daysOfWeek? | once：入参可本地墙钟，校验「规范化后的 UTC > now」，否则 `ONCE_IN_PAST`；落盘 `at` 为 ISO；delivery=`session` |
| `list` | 可选 enabledOnly | 含 next/last/backoff |
| `update` | id, version, 补丁 | 版本不符 → `VERSION_CONFLICT`；改 recurrence/at/timezone/daysOfWeek → 重算 next + **清 fire/backoff** |
| `delete` | id | 删除 |
| `enable` / `disable` | id, version | **disable**：`enabled=false`，清 `activeFireId`/退避/`backoffOriginAt`，**`nextFireAt = null`**；**enable 已过期 once** → 保持关，返回 `ONCE_IN_PAST`；enable 周期项：重算 `nextFireAt` 后 arm |

注册：`ctx.tools.register(tool, { when: /* 与 diary 相同的 chonkyfish 条件 */ })`。  
输出与 diary 同构：`ok` / `error.code`。

错误码：`VALIDATION` · `NOT_FOUND` · `VERSION_CONFLICT` · `ONCE_IN_PAST` · `LIMIT_REACHED` · `DISABLED` · `INTERNAL`

## 8. HTTP 与面板

- `ROUTES.schedule = '/chonkyfish/schedule'`
- **仅 GET**：`{ ok, timezoneDefault, items: PublicItem[] }`（不含 fires 全量，或仅摘要；**无写**）
- migration busy：与其它只读接口对齐（可读快照或忙错误，实现跟仓内 GET 习惯）
- 面板：「鱼鱼的日程」只读 + 脚注「改日程请让鱼鱼用工具调整」

## 9. Host 安装顺序

```text
layoutReady
  → createDeliverer（已有，含 source 扩展）
  → installSchedule({
      ctx, resources, deliverer,
      getActiveSessionId: () => read proactive.json（同 abs/host boundSessionId）,
      logger, ready: layoutReady,
    })
```

返回 `{ close }`：停表、卸工具与路由。  
v1 **不**新增 `config.schedule.enabled`（随插件启）。

## 10. 硬切换与迁移清单

| 文件 | 动作 |
|---|---|
| `app/dsh/packaging/cordis.patch.yml` | 删两处 `dsh-tool-schedule` |
| `README.md` | 定时章节 → `fish_schedule` |
| `core/modules/diary/README.md` / `tools.js` / `persona.js` / `index.js` | 文案 |
| `core/contracts/spec.js` | FILES/ROUTES/LIMITS + 日记说明 |
| `core/modules/persona/tests/run-supplement.mjs` | 断言 `fish_schedule` |
| migration 白名单 / 设计文档 | **确认** schedule 不在导出范围 |
| `package.json` | 增 `test:schedule`，并挂入根 `npm test` |
| 相关 docs | 交叉链接 |

不自动清理 DSH 全局旧 schedule 数据。

## 11. 测试计划

| 层 | 用例焦点 |
|---|---|
| `next-fire` | daily 跨午夜；weekly 含周日 0；once 过去/未来；Intl + Shanghai |
| `backoff` | 阶梯；跨槽；30m；once disable |
| `service` | CRUD；version；ONCE_IN_PAST；update 清 fire；missSkip；fires 有界且**不裁掉 active 引用**；**delivered 同次原子推进**；幂等不双投；`backoffOriginAt` 累计 30m |
| `repository` | 原子写；坏 JSON fail-closed 不覆盖 |
| `delivery` | 自定义 source（含 form）；默认 nudge 回归 |
| `host` | arm / `maxTimerMs`；`scanContinueMs`；dispose；CRUD 升 generation 只取消新枪；deliver 后必 mark（条件更新） |
| `tools` / `http` | schema；仅 GET |
| 硬切换 | cordis；supplement；`npm test` 含 schedule |
| 手工 | 到点旁白=prompt；关机不补；busy 退避 |

## 12. 落地顺序

1. **M1** schema + next-fire（Intl）+ backoff + repository  
2. **M2** service CRUD + fires + missSkip + fireId/退避（内存 deliver）  
3. **M3** Host 装甲（含 5s 续扫）+ deliverer source 扩展 + 工具注册  
4. **M4** GET + 只读面板  
5. **M5** 硬切换 + migration 确认 + `test:schedule` 进聚合  

**M5 与 M3 同发布列车**（同 commit 或同版本），避免「DSH schedule 已摘、鱼日程未上」空窗。

## 13. 已知取舍

- **崩溃窗口（投递后未 markDelivered）：** 启动 missSkip → **可能丢一枪、不双投**。  
- **崩溃窗口（退避中）：** 启动同样 missSkip → **放弃当前枪**（不续退避）。与产品「启动凡过点不投」一致。  
- **进程内已 delivered 痕迹：** 可 repair 推进、禁止二次 followup；裁剪不得丢掉仍被 `activeFireId` 引用的记录。  
- **无面板会话：** 同 busy 退避路径（outcome 区分）。  
- **不补历史、不进迁移包、不跟 ABS 时钟。**  
- **正文不包装 title**（与产品设计 `content = prompt` 一致）。

## 14. 与产品设计的差异容忍

仅允许微调：面板挂载位置、坏 JSON 对用户可见文案、工具拒绝句措辞。  
**已锁死、不得当「微调」改掉：** `at` 语义、fires 幂等与裁剪保护、`markDelivered` 同次原子 save、`form: 'notice'`、`scanContinueMs`、`backoffOriginAt`、CRUD/`rearm` 升 `scanGeneration`（只取消新枪）、**deliver 成功后 mark 不因 gen 跳过**、missSkip **仅 boot 一次**、Intl 时区、工具仅 core、`disable`→`nextFireAt=null`、enable 过期 once → `ONCE_IN_PAST`、`maxTimerMs` 夹紧。

若要改 fireId / 跨槽 / 上限 / 硬切换范围 / 启动是否续退避，先改产品设计再改本文与代码。

## Revision History

| Date | Changes |
|---|---|
| 2026-11-23 | 初稿：模块边界、数据契约、扫描/退避/fireId、投递复用、工具/HTTP、硬切换、测试与里程碑 |
| 2026-11-23 | 评审修复：fires 幂等、scanContinueMs、`at` 定稿（无 onceAt）、content=prompt、source.form、启动漏点=放弃退避中、Intl 时区、version 归 service、tools 仅 core、enable once 锁定、migration/`test:schedule` 清单 |
| 2026-11-23 | 复审修复：fires 裁剪保护与 markDelivered 原子 save；扫描/CRUD 并发（scanGeneration + 队列内条件更新）；`backoffOriginAt`；disable 置 next null；去掉 narration.js；`maxTimerMs` |
| 2026-11-23 | 第三轮：deliver 后 mark 不因 gen 取消；missSkip 仅 boot 一次；单条 ensure→deliver→mark 唯一写法；fires 裁剪规则合并 |
