# 大肥鱼内部日程设计 V1

**可实现 · 2026-11-23 · 方案设计。未写代码。两轮评审缺口已补齐。**  
**技术落地见：[fish-schedule-technical-v1](./fish-schedule-technical-v1.md)。**

把「到点提醒」从 DSH 原生 `schedule_*` 收归大肥鱼自己的调度模块：鱼鱼用工具创建与维护，宿主到点只投面板会话，模型自己决定要不要行动。主人面板只读查看。

## 1. 目标与非目标

### Goals

- v1 只做**会话提醒**调度；数据上可带固定字段 `delivery: "session"`，**不**实现多态 handler / 插件式用途表。
- 到点行为固定为**只投会话**（不静默跑 host job）。
- 硬切换：`chonkyfish` preset 不再挂 `@deepseek-ai/dsh-tool-schedule`。
- 控制面：仅鱼鱼工具可写；面板只读（文案提示「要改就跟鱼鱼说」）。
- 漏触发：宿主关机/未运行期间已过的点**不补投**，只算下一次。
- busy / 无面板会话：短退避后再试；**连续 busy 跨过下一逻辑槽位 = 丢弃当前槽，不补**。

### Non-goals（v1）

- 静默 `host_job`、handler 注册表、多投递面运行时（字段可写死 `session`，取值不可选）。
- cron / RRULE / 按月按年 / 「过 N 分钟」相对触发。
- 主人面板写入、自动迁移 DSH 侧已有提醒。
- 纳入数据迁移导出包（与现「定时任务不迁移」一致）。
- 与 ABS 唤醒合并成统一调度队列。
- 复用或扭曲 `core/modules/tasks`（那是外部作业生命周期，不是日历）。

## 2. 决策摘要

| 项 | 选择 |
| --- | --- |
| 形态 | 独立模块（方案 A），不塞进 proactive / tasks |
| 工具名 | 单工具 `fish_schedule`（多 action），避免与 DSH `schedule_*` 混淆 |
| 投递 | proactive 同款：`resolveAgent` → idle → `followup` → `flush` |
| source | `kind: 'chonkyfish-schedule'`，`form: 'notice'`（带 scheduleId / fireId / title） |
| 时钟 | 真实墙钟；时区默认 `Asia/Shanghai`；**不跟** ABS `timeScale` |
| recurrence | `once` \| `daily` \| `weekly`（weekly 带 `daysOfWeek`） |
| `daysOfWeek` | 整数 `0–6`，与 JS `Date#getDay` 一致（`0` = 周日） |
| 持久化 | 原子 JSON（体量 ≤50 条，不必上 SQLite） |
| 漏点 | 启动扫描：`nextFireAt < now` → 跳过并重算下次 |
| busy/无会话 | 短退避；跨逻辑槽则丢槽跳下次 |
| 单次扫描上限 | 每次定时器唤醒最多成功投递 **5** 条；其余 due 留待下一轮 arm |

## 3. 与现有模块的关系

```text
                    ┌──────────────────┐
                    │ fish_schedule 工具 │
                    └────────┬─────────┘
                             ▼
┌──────────┐        ┌──────────────┐        ┌─────────────────┐
│ ABS wake │ 并行   │ fish-schedule│ 到点    │ proactive 投递面 │
│ (欲望/休息)│ ──╳──►│ Core + store │ ──────►│ activeSession   │
└──────────┘        └──────┬───────┘        └────────┬────────┘
                           │                         ▼
                    ┌──────┴───────┐        followup + flush
                    │ 只读面板 GET  │        source=chonkyfish-schedule
                    └──────────────┘
```

- **日记**：排期改走本模块；写日记仍是到点后模型自己调 `diary`。
- **proactive**：复用「面板会话绑定 + followup 语义」；日程不并入 proactive 状态机。
- **ABS**：欲望唤醒与日程并行；都不把 schedule 注入当成 `owner_message`。
- **memory / 事件引擎**：跳过非 `user` 来源，提醒不记成主人说过的话。
- **tasks**：无关。

## 4. 数据模型

一条日程：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定 id |
| `title` | 短标题（列表/面板） |
| `prompt` | 到点投进会话的正文 |
| `timezone` | 默认 `Asia/Shanghai` |
| `delivery` | v1 恒为 `"session"`（写入时校验，禁止其他值） |
| `recurrence` | `once` \| `daily` \| `weekly` |
| `at` | **once**：带时区的绝对时刻（存成可解析为唯一 UTC 的 ISO）；**daily/weekly**：本地 `HH:mm`（24h） |
| `daysOfWeek` | 仅 weekly：非空整数数组，元素 ∈ `0…6`（0=周日），去重排序 |
| `enabled` | 开关 |
| `nextFireAt` | 下次应触发 UTC ISO（调度权威字段） |
| `activeFireId` | 当前逻辑 due 的 fire id；无进行中的 due 时为 null |
| `backoffUntil` | 短退避截止 UTC ISO；无退避时为 null |
| `backoffStep` | 当前退避阶梯序号（从 0 起）；推进逻辑槽或成功投递后归零 |
| `backoffOriginAt` | 本逻辑 due 首次 transient skip 的 UTC ISO；无退避为 null；用于累计 30m 上限（技术方案锁定） |
| `lastFiredAt` | 上次**成功**投递时间；未投过为 null |
| `createdAt` / `updatedAt` | 审计 |
| `version` | 乐观并发 |

另存 fire 尝试痕迹（同文件附属数组或旁路日志，实现自定，建议有界例如最近 200 条）：`fireId`、`scheduleId`、`attemptedAt`、`outcome`（`delivered` / `skipped_busy` / `skipped_no_session` / `flush_failed` / `skipped_missed_on_boot` / `dropped_crossed_slot` 等）。

持久化：`$DSH_HOME/chonkyfish/schedule.json`（路径以实现为准），原子写（临时文件 + rename）。数量上限 **每鱼 ≤ 50** 条 enabled+disabled 合计。

### `fireId` 生命周期（防双投）

1. 某条日程进入「当前逻辑 due」（首次 `nextFireAt <= now` 且准备尝试投递）时，若 `activeFireId` 为空，则分配新 `fireId` 并写入 `activeFireId`。
2. **同一逻辑 due 的短退避重试必须复用** `activeFireId`；不得每次尝试新建 id。
3. 幂等键：`(scheduleId, fireId)`。已 `outcome=delivered` 的 fire 禁止再投。
4. 仅在以下情况清空 `activeFireId` 并允许下次新 id：
   - `flush` 成功并推进 recurrence / disable once；或
   - 判定「跨逻辑槽丢弃」并跳到下一逻辑 `nextFireAt`；或
   - 启动漏点跳过并重算下次。
5. followup/flush 失败或 uncertain：不推进 recurrence，保留同一 `activeFireId`，只更新退避字段。

### 不变量

1. 只有 `fish_schedule` 工具能改写；面板与 HTTP 只读。
2. 启动时所有 `nextFireAt < now` 的 due **不投递**，记 `skipped_missed_on_boot`，清 `activeFireId` 与退避字段；daily/weekly 重算下次后 arm，once 则 `enabled=false`。
3. 投递目标 = proactive 的 `activeSessionId`；绝不猜会话、不新建会话。
4. once 在成功投递、启动漏点跳过、或宽限/跨槽放弃后均为 `enabled=false`，不再 arm。
5. `delivery` 必须为 `"session"`。
6. 改动调度相关字段的 `update` 必须同时清空 `activeFireId` 与退避字段（含 `backoffOriginAt`），避免旧退避粘在新槽上。

## 5. 触发与投递

### 时钟与装甲

- Host 一个定时器，睡到全局最近「可触发时刻」（`nextFireAt` 与 `backoffUntil` 的较早者中、仍 enabled 的最小值）；CRUD / enable 变更后重新 arm。
- dispose / 卸载必须清定时器。
- 与 ABS 定时器独立。
- **系统休眠/定时器推迟唤醒**：醒来后按「到点一轮」扫描；**每次唤醒最多成功投递 5 条**（按 `nextFireAt` 升序）。其余仍 due 的条目留在队列，arm 到「现在 + 短间隔」（如 5s）再扫，避免 inbox 雪崩。不把休眠积压当成「要补的历史漏点」——只投递当前仍挂在 `nextFireAt`/`activeFireId` 上的 due，启动时已过点的仍按漏点跳过。

### 到点一轮（单条）

1. 候选：`enabled && nextFireAt <= now && (backoffUntil == null || backoffUntil <= now)`，按 `nextFireAt` 升序；本轮成功投递计数达到 5 则停止。
2. 确保 `activeFireId` 已分配（见上节）。
3. 解析 `activeSessionId`；无效或非鱼会话 → 记 `skipped_no_session`，进入短退避，arm。
4. `resolveAgent`；`agent.status !== 'idle'` → 记 `skipped_busy`，进入短退避，arm。
5. `followup` 注入：
   - `role: 'user'`
   - `content`: `prompt`
   - `source: { kind: 'chonkyfish-schedule', form: 'notice', scheduleId, fireId: activeFireId, title }`
6. `flush === true` 才算成功：写 `lastFiredAt`，痕迹 `delivered`，清退避字段与 `activeFireId`，推进 recurrence 的 `nextFireAt`（once 则 disable）。
7. followup/flush 不确定或失败：痕迹 `flush_failed`（或不升级已有同 fire 的失败记录），**不**推进 recurrence，短退避再试，**复用** `activeFireId`。

### 短退避与跨槽丢弃

- 目的：当前这一枪稍后再试，**不是**补历史漏点。
- 阶梯（从 `backoffStep=0`）：**1m → 2m → 5m → 10m → 15m**，之后停在 15m。
- 单段累计退避时间上限 **30m**（从本逻辑 due 首次失败/跳过起算）；且退避终点不得超过「若此刻改跳、下一逻辑槽位」的时刻。
- **跨槽规则**：若计算出的退避终点 ≥ 下一逻辑槽位的应到点时刻，则：
  - 记 `dropped_crossed_slot`；
  - 清空 `activeFireId` 与退避字段；
  - `nextFireAt` = 下一逻辑槽位（daily/weekly）；
  - **once**：宽限用尽或跨槽丢弃时 **必须** `enabled=false`，清 `activeFireId` 与退避字段，**不再投**（与「不补历史」一致：只此一枪始终投不出即放弃）。
- **验收语义**：连续 busy/无会话直到跨槽 = **丢弃该槽，不补**；与「短退避是为少空过」并存——只在槽位尚未结束前重试。

### 逻辑下次（recurrence）

- `daily`：在 `timezone` 下，严格晚于「当前锚点」的下一个 `HH:mm`（锚点为成功投递时刻或丢槽判定时刻）。
- `weekly`：下一个落在 `daysOfWeek` 且本地时刻为 `HH:mm` 的点。
- `once`：成功投递、启动漏点跳过、或宽限/跨槽放弃 → 均为 `enabled=false`，不再 arm。

### 面板表现

| 面 | 行为 |
| --- | --- |
| 大肥鱼面板 | 非 `user` 来源不当成主发言；鱼鱼仍开一轮 |
| 标准对话 UI | 可作 notice/context |
| 工具说明 | 禁止伪造主人口吻 |
| 只读面板 | 脚注：「改日程请让鱼鱼用工具调整」 |

## 6. 工具与只读面板

### 工具 `fish_schedule`

单工具多 action：

| action | 作用 |
| --- | --- |
| `create` | title、prompt、recurrence、at、timezone、daysOfWeek（weekly 必填）。**`once.at` 若不晚于「现在」→ 创建时拒绝**，不建立刻 due 再靠漏点逻辑吞掉 |
| `list` | 含 nextFireAt、enabled、lastFiredAt、backoffUntil（若有） |
| `update` | 带 version；冲突拒绝；改 `recurrence` / `at` / `timezone` / `daysOfWeek` 须重算 `nextFireAt`，并清 `activeFireId`、`backoffUntil`、`backoffStep` |
| `delete` | 删除 |
| `enable` / `disable` | 可并入 update |

工具描述必须写明：提醒不是主人命令；到点只是旁白；行动由鱼鱼自己决定。

### 面板

- 「鱼鱼的日程」只读列表/详情：标题、周期、下次/上次、开关、prompt 摘要、退避中状态（可选）。
- HTTP 仅 `GET`；无写路由。
- 挂载：设置页一节或独立入口（实现二选一，默认跟设置页其它鱼本地数据放一起）。

## 7. 硬切换与迁移

实现时必须改到的文件/位置（清单）：

| 位置 | 动作 |
| --- | --- |
| `app/dsh/packaging/cordis.patch.yml` | 去掉两处 `@deepseek-ai/dsh-tool-schedule` |
| `README.md` | 定时任务章节改为 `fish_schedule` |
| `core/modules/diary/README.md` | 排期说明改指向本模块 |
| `core/modules/diary/tools.js` | tool description 去掉 `schedule_create` |
| `core/modules/diary/persona.js` / `index.js` 注释 | 同上 |
| `core/contracts/spec.js` | 日记相关文案 |
| `core/modules/persona/tests/run-supplement.mjs` | 断言从 `schedule_create` 改为 `fish_schedule` |
| 本设计与日记相关 docs | 交叉链接 |

策略：

1. **不**自动迁移 DSH 已有提醒；文档写明请鱼鱼用 `fish_schedule` 重建。
2. 运维备注：DSH 全局里可能仍残留旧定时，可在 DSH 侧手动清理；鱼预设工具面不再暴露。

数据迁移包：v1 **不包含**本模块数据（与 [data-migration-design-v1](./data-migration-design-v1.md)「定时任务不迁移」一致）。

## 8. 验收

- 工具 CRUD 与面板只读数据一致；工具名为 `fish_schedule`。
- 到点投会话；source 可区分；memory/事件引擎不记成主人话。
- 关机错过不补；busy/无会话短退避后再试；**连续 busy 跨槽丢弃且不补**。
- 同一逻辑 due 退避重试 **fireId 不变**；成功或丢槽后才换新 id。
- 休眠醒来单次扫描成功投递 ≤ 5；剩余 due 后续轮次处理。
- once：成功、启动漏点、宽限/跨槽放弃 → 均为关闭；`create` 拒绝过去时 once。
- daily/weekly 正确推进 `nextFireAt`（含跨午夜、周几 `0–6`）。
- preset 无 DSH schedule；§7 清单内文案/测试已替换；相关单测通过。
- 模块 dispose 不留定时器。
- **崩溃窗口（已知取舍）**：`followup` 已进 inbox、日程库尚未记 `delivered` 时进程崩溃 → 启动按漏点跳过 → **可能丢这一枪，但不会双投**；v1 不保证 crash 后补投。

## 9. 建议落地结构（实现阶段）

```text
core/modules/schedule/     # nextFire 计算、校验、退避/跨槽纯函数
app/shared/storage/...     # schedule.json 原子读写
app/dsh/adapters/schedule/ # fish_schedule 工具、Host 装甲、HTTP
app/dsh/ui/...             # 只读面板
```

## 10. 已拍板 / 仍可微调

**已拍板：**

- 持久化：原子 JSON  
- 工具名：`fish_schedule`  
- `daysOfWeek`：`0–6`（周日=0）  
- 退避阶梯与上限：1/2/5/10/15m，累计 30m，跨槽丢弃  
- 单次唤醒成功投递上限：5  
- `fireId` 复用规则见 §4  
- once 宽限/跨槽/漏点放弃 → **必须** `enabled=false`  
- `create` 拒绝过去时 once；`update` 清 fire + 退避  

**实现时可微调（不改语义）：**

- 面板挂在设置页哪一节  
- `schedule.json` 的精确文件名  
- 工具/面板拒绝与放弃时的用户可见文案措辞  

## Revision History

| Date | Changes |
| --- | --- |
| 2026-11-21 | 初稿：独立模块、会话投递、硬切换、工具可写面板只读、漏点跳过、busy 短退避 |
| 2026-11-23 | 补齐评审缺口：fireId 生命周期、跨槽丢弃、休眠扫描上限、硬切换文件清单、JSON/`fish_schedule`/`daysOfWeek` 拍板、收紧「通用底座」表述 |
| 2026-11-23 | 复审补齐：once 必须 disable、update 清退避、过去 once 创建拒绝、crash 窗口写进验收；状态改为可实现 |
| 2026-11-23 | 链到技术方案 V1 |
| 2026-11-23 | 与技术方案对齐：source.form=notice；字段 backoffOriginAt |
