# ABS 自主实验进度

试验场：本机 DeepSeek Harness（desktop）。协议见 [protocol.md](./protocol.md)。手册见 [MONITOR_RUNBOOK.md](./MONITOR_RUNBOOK.md)。

## 当前实验（R02）

| 项 | 值 |
|---|---|
| 轮次 | **2026-11-26-R02**（已收束并验收） |
| 旋钮 | 2 · `chat_owner` 由头注入（`review.js` `buildChatHook`） |
| 内容窗 | 已结束；`timeScale` **1**；pacing 默认 120 / 10 / 0.65 |
| 窗起点 (UTC) | 2026-11-26T02:12:41Z（CST 10:12） |
| 收束 (UTC) | 2026-11-26T03:28:20Z（CST 11:28） |
| HTTP | `http://127.0.0.1:55985` |
| 巡检 | `scheduled-task:33ca7bcf-…`（**enabled=false**） |
| cycle | [`cycles/2026-11-26-R02.md`](./cycles/2026-11-26-R02.md) |
| 状态 | **closed**（主人验收：前 5 项符合预期、第 6 项可接受；内容窗按主人口径通过） |

### R02 时间线

| 时刻 (CST) | 事件 |
|---|---|
| 10:10–10:13 | 实现 `buildChatHook`（探索结果 → 时段+间隔）；`npm run test:abs` 通过；重启 DSH 加载；R02-start 快照；timeScale→60；巡检 + 收束已排 |
| 10:34–11:24 | 6 条 `chat_owner`，严格 10 分钟间隔；钉钉 1 次（10:34）；hook 6/6 为兜底层 |
| 11:28 | **R02 收束**：snapshot `2026-11-26-R02-end`；`timeScale→1`；配置核对无误；巡检禁用 |
| 11:33 | 主人验收；钉钉回复计入 owner 交流（`host.js` + `run-host.mjs` + README）；`npm run test:abs` 通过；DSH 未重启 |
| 11:36 | 主人要求重启：DSH 已重启加载新 Host（ABS HTTP `62693`；timeScale=1、pacing 120/10/0.65、rest 开）；约 3 分钟后鱼会话仍 `session-not-live`，待面板/会话在 DSH 里打开后恢复 |
| 11:57 | **钉钉修复现场验证通过**：主人发钉钉后，会话 seq 7568（`social-` id，`source.kind=user`）→ `lastOwnerMessage.realAt=03:56:42Z`、社交满足度随之 +0.05；鱼会话已 live |

### R02 收束对比

| 指标 | 值 |
|---|---|
| chat_owner enqueued / visibleReply | **6 / 6** |
| result | no_action 1，unknown 5 |
| hook（时段+小时） / 探索层 | 6 / 0 |
| 钉钉 `social_send_owner_message` | **1**（10:34） |
| 面板 🍚 | 6/6 收尾；1 条仅 🍚；无短间隔连发 |
| 由头机械预填均分 | ≈≤1.0（弱由头），**待主人标注** |
| BUG（已修） | 钉钉渠道回复原不算 owner 交流 → 提示写「13–14 小时前」；主人确认应算，已修（需重启 DSH 生效） |
| 主人验收 | 前 5 项符合预期；第 6 项可接受 |
| 10:19 | 首次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T02:24:36Z`；ownerSession live（available，idle）；相对 R02-start **+0** chat_owner（enqueued 0 / visibleReply 0 / result 无）；无 <5 分钟 chat_owner 连发、无「🍚」。观察：窗内新增 1 条 `continue_interest`（`5d74ec91`，02:14:36Z，result=unknown）；距上一条 02:08:04Z 约 6.5 分钟，低于 10 分钟现实下限，紧接 timeScale 1→60，未改配置 |
| 10:24 | 第二次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T02:34:36Z`；ownerSession live（available，idle）；相对 R02-start 仍 **+0** chat_owner（enqueued 0 / visibleReply 0 / result 无）。本段新唤醒 1 条 `continue_interest`（`ddf866c0`，02:24:36Z，visibleAt 有，result=unknown），距 `5d74ec91` 正好 10 分钟。无 <5 分钟 chat_owner 连发、无「🍚」；未改配置 |
| 10:29 | 第三次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T02:34:36.813Z`；ownerSession live（available，idle）；相对 R02-start 仍 **+0** chat_owner（enqueued 0 / visibleReply 0 / result 无）。本段无新唤醒（最近仍是 `ddf866c0`，02:24:36Z，result=unknown）。无 <5 分钟 chat_owner 连发、无「🍚」；未改配置 |
| 10:35 | 第四次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T02:44:36.936Z`；ownerSession live（available，idle）；相对 R02-start **+1** chat_owner（enqueued 1 / visibleReply 1 / result unknown×1）。本段新唤醒 `e3e4bd8d`（02:34:36Z，chat_owner，visibleAt 有，result=unknown；evidence 1 次 `social_send_owner_message` unverified）。距上一条 `ddf866c0` 正好 10 分钟。无 <5 分钟 chat_owner 连发、无「🍚」；未改配置 |
| 10:40 | 第五次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T02:44:36.936Z`；ownerSession live（available，idle）；相对 R02-start 仍 **+1** chat_owner（enqueued 1 / visibleReply 1 / result unknown×1）。本段无新唤醒（仍是 `e3e4bd8d`，02:34:36Z，result=unknown）。无 <5 分钟 chat_owner 连发；窗内面板回复带「🍚」但都是整句，没有连续只回「🍚」；未改配置 |
| 10:44 | 第六次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T02:44:36.936Z`；ownerSession live（available，idle）；相对 R02-start 仍 **+1** chat_owner（enqueued 1 / visibleReply 1 / result unknown×1）。本段无新唤醒（仍是 `e3e4bd8d`，02:34:36Z，result=unknown，evidence 为 1 次 `social_send_owner_message` unverified）。无 <5 分钟 chat_owner 连发、无连续只回「🍚」；未改配置 |
| 10:49 | 第七次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T02:54:37.111Z`；ownerSession live（available，idle）；相对 R02-start **+2** chat_owner（enqueued 2 / visibleReply 2 / result unknown×2）。本段新唤醒 `54bded9d`（02:44:36Z，chat_owner，visibleAt 02:44:44Z，result=unknown；evidence 为 1 次 `write` unverified，无 social 发送证据）。距上一条 `e3e4bd8d` 正好 10 分钟。无 <5 分钟 chat_owner 连发；API 不含回复正文，未发现连续只回「🍚」迹象；未改配置 |
| 10:56 | 第八次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T03:04:37.729Z`；ownerSession live（available，idle）；social sat=0 / demand=1（timeScale 60 下自起点约 0.33 衰减，符合 decay）；相对 R02-start **+3** chat_owner（enqueued 3 / visibleReply 3 / result unknown×3）。本段新唤醒 `ae36d1c7`（02:54:37Z，chat_owner，visibleAt 02:54:53Z，result=unknown；evidence 为 2 次 `bash` unverified，无 social 发送证据）。距上一条 `54bded9d` 正好 10 分钟。无 <5 分钟 chat_owner 连发；窗内近期面板回复为整句（部分句末带「🍚」），无连续只回「🍚」；未改配置 |
| 11:01 | 第九次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T03:04:37.729Z`；ownerSession live（available，idle）；相对 R02-start 仍 **+3** chat_owner（enqueued 3 / visibleReply 3 / result unknown×3）。本段无新唤醒（仍是 `ae36d1c7`，02:54:37Z，result=unknown）。无 <5 分钟 chat_owner 连发；窗内面板回复为整句（部分句末带「🍚」），无连续只回「🍚」；未改配置 |
| 11:04 | 第十次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T03:04:37.729Z`（约 30 秒后到点）；ownerSession live（available，idle）；social sat=0 / demand=1；相对 R02-start 仍 **+3** chat_owner（enqueued 3 / visibleReply 3 / result unknown×3）。本段无新唤醒（最近仍是 `ae36d1c7`，02:54:37Z）。无 <5 分钟 chat_owner 连发、无连续只回「🍚」；未改配置 |
| 11:09 | 第十一次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T03:14:37.954Z`；ownerSession live（available，idle）；social sat=0 / demand=1；相对 R02-start **+4** chat_owner（enqueued 4 / visibleReply 4 / result unknown×4）。本段新唤醒 `05122343`（03:04:37Z，chat_owner，visibleAt 03:04:43Z，result=unknown），距上一条 `ae36d1c7` 正好 10 分钟。无 <5 分钟 chat_owner 连发；ABS activities 不含回复正文，未能核对是否连续只回「🍚」（无迹象）；未改配置 |
| 11:14 | 第十二次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T03:14:37.954Z`（约 34 秒后到点）；ownerSession live（available，idle）；social sat=0 / demand=1；相对 R02-start 仍 **+4** chat_owner（enqueued 4 / visibleReply 4 / result unknown×4）。本段无新唤醒（最近仍是 `05122343`，03:04:37Z）。无 <5 分钟 chat_owner 连发、无连续只回「🍚」；未改配置 |
| 11:19 | 第十三次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T03:24:38.004Z`；ownerSession live（available，idle）；social sat≈0 / demand=1；相对 R02-start **+5** chat_owner（enqueued 5 / visibleReply 5 / result unknown×5，均无 no_action；另 continue_interest×2）：`e3e4bd8d`(02:34)、`54bded9d`(02:44)、`ae36d1c7`(02:54)、`05122343`(03:04)、`3fe01295`(03:14)；evidence 里仅 `e3e4bd8d` 有 `social_send_owner_message`（unverified），其余为 bash/write unverified。间隔均为 10 分钟，无 <5 分钟连发；API 无面板文本，未见「🍚」连续刷屏证据；未改配置 |
| 11:25 | 第十四次 5min 巡检：HTTP `55985` OK；timeScale=60；pacing 120/10/0.65；nextWake `2026-11-26T03:34:38.133Z`；ownerSession live（available，idle）；social sat=0 / demand=1；相对 R02-start **+6** chat_owner（enqueued 6 / visibleReply 6 / result unknown×5 + no_action×1）。本段新唤醒 `25f20584`（03:24:38Z，chat_owner，visibleAt 03:24:40Z，result=no_action，evidence 空）。距上一条 `3fe01295` 正好 10 分钟。无 <5 分钟连发。面板最近一条（turn 431）正文仅为「🍚」，此前仍是整句（句末可带「🍚」），尚未连续只回「🍚」；未改配置 |

## 上一轮（R01）

| 项 | 值 |
|---|---|
| 轮次 | **2026-11-25-R01**（已收束） |
| 旋钮 | 1 · `chat_owner` 提示语气（`review.js`）；窗中含 R01b 工具描述对齐 |
| 内容窗 | 已结束；`timeScale` **1**；pacing 已还原默认 |
| 窗起点 (UTC) | 2026-11-25T07:28:58Z（CST 15:28） |
| 收束 (UTC) | **2026-11-25T09:32:39Z（CST 17:32）** |
| HTTP（收束时） | `http://127.0.0.1:58185` |
| 实验 pacing（已还原） | 曾用 gap=0.3 / 现实间隔=2 / ABS 间隔=30 → 现 **10 / 120 / 0.65** |
| 巡检任务 | `scheduled-task:33ca7bcf-3e4b-491f-a554-7f65624c665e`（**enabled=false**） |
| 收束任务 | `scheduled-task:b170cfda-8569-4f6a-b94a-072472f5b779`（once，已跑） |
| 状态 | **closed** |
| 下一建议 | **R02 · 旋钮 2 由头注入**（保留 R01/R01b 模板） |

## 时间线

| 时刻 (CST) | 事件 |
|---|---|
| 15:27–15:29 | R01 改模板；`npm run test:abs` 通过；重启 DSH；timeScale→60；R01-start 快照；创建 5min 巡检 + 收束 once |
| 15:34 | 首次 5min 巡检：HTTP 51700 OK；timeScale=60；窗内 +1 chat_owner（enqueued+visible，result=no_action） |
| 15:40 | 第二次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start 仍 +1 chat_owner（本 5 分钟无新增）；无异常 |
| 15:45 | 第三次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start **+2** chat_owner（本段 +1：`f8afef9f`）；均 no_action；无异常 |
| 15:50 | 第四次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start 仍 +2 chat_owner（本 5 分钟无新增；nextWake 约 07:50:41Z）；无异常 |
| 15:55 | 第五次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start **+3** chat_owner（本段 +1：`34cd9439`，result 暂 `unknown`）；无异常 |
| 16:00 | 第六次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start **+4** chat_owner（本段 +1：`f13f9e6c`，刚入队，result/`visibleAt` 暂未结算）；无异常 |
| 16:05 | 第七次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start 仍 +4 chat_owner（本 5 分钟无新增；`f13f9e6c` 已结算 no_action）；无异常 |
| 16:11 | 第八次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start **+5** chat_owner（本段 +1：`6308f37d`，刚入队，result/`visibleAt` 暂未结算；ownerSession busy）；无异常 |
| 16:15 | 第九次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start 仍 +5 chat_owner（本 5 分钟无新增；`6308f37d` 已有 visibleAt，result 仍 unknown；ownerSession 空闲）；无异常 |
| 16:20 | 第十次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start **+6** chat_owner（本段 +1：`a9a30b65`，刚入队，result/`visibleAt` 暂未结算；ownerSession busy）；无异常 |
| 16:25 | 第十一次 5min 巡检：HTTP 51700 OK；timeScale=60；相对 R01-start 仍 +6 chat_owner（本 5 分钟无新增；`a9a30b65` 仍无 visibleAt / result unknown；ownerSession 空闲）；无异常 |
| 16:29 | **Pacing 可调 + 下调**：新增 `actionPolicy.minimumGap` 配置与 `POST pacing`；实验设 gap=0.3、现实最小间隔=2、ABS 间隔=30；重启 DSH；手动 wake → `chat_owner` 立即 enqueued；nextWake≈2 分钟；收束改到 CST 17:29 |
| 16:33 | **R01b no_action 诊断**：多为面板自语或 bash unverified，零 social_send。已改提示与 `social_send_owner_message` 描述；DSH 重载；wake 已派发新提示 |
| 16:30–17:29 | 第十二～二十三次 5min 巡检：增量爬升至相对 R01-start **+36**；仍以 no_action 为主；偶见 social_send unverified |
| 17:32 | **R01 收束**：snapshot `2026-11-25-R01-end`；窗内 **+38** chat_owner（29×no_action + 9×unknown）；`timeScale→1`；pacing 还原默认；禁用 5min 巡检；状态 **closed**；建议进 **R02 由头注入** |
| 17:37 | **滞留 5min 巡检误触发**（任务本应 enabled=false）：HTTP `58185` OK；`timeScale=1`（收束后正确，未改回 60）；相对 R01-start **+39** chat_owner（收束后又 +1：`cff73612`，no_action）；已再次 `enabled=false`；无旋钮改动 |
| 19:00 前后 | 会话排查：面板短时间 🍚 刷屏 = 2min pacing 强制开轮 + 最小输出；钉钉 `social_send_owner_message` **仅 2 次**（16:35、16:57） |
| 19:13 | **主人判定**：上述钉钉 **2 次调用符合预期**（记录验收；与 ABS episode `verified=0` / unverified 记分脱钩） |
## 窗起点快照摘要

- mode=active, timeScale=60, social sat≈0.15, demand≈0.80
- 当日此前 chat_owner enqueued=9（均为窗前基线）；窗内增量从下一轮唤醒计
- nextWake 当时约 07:30:40Z（约 2 分钟内）

## 收束对比（start → end）

| 指标 | start | end | 窗内 Δ |
|---|---|---|---|
| chat_owner enqueued | 9 | 47 | **+38** |
| visibleReply | 9 | 46 | **+37** |
| no_action（窗内） | — | — | **29**（≈76%） |
| unknown（窗内） | — | — | **9**（≈24%） |
| 社交 verified 发送（ABS 记分） | — | — | **0**（episode 仍标 unverified） |
| 钉钉 `social_send`（会话证据） | — | — | **2**（16:35、16:57） |
| 主人对钉钉 2 次的验收 | — | — | **符合预期**（2026-11-25 19:13 口述） |

- end 快照：`docs/abs-iteration/snapshots/2026-11-25-R01-end.json`
- cycle：[`cycles/2026-11-25-R01.md`](./cycles/2026-11-25-R01.md) Decision：保留模板；下一旋钮 = **2 由头注入**；内容窗 **未过**（面板刷屏/由头仍弱；**钉钉频次已按主人口径过关**）

## 累计观察（内容窗 · 终态）

| 指标 | 值 |
|---|---|
| chat_owner enqueued（相对 R01-start 新增） | 38 |
| visibleReply 新增 | 37 |
| no_action | 29 |
| unknown | 9 |
| 钉钉 `social_send_owner_message` | **2**（主人：**符合预期**） |
| 异常 | 无（面板 🍚 刷屏属加速 pacing 副作用，非钉钉过量） |
| 配置还原 | timeScale=1；pacing 默认；restHours 23:00–08:00 |
| 巡检 | 已禁用 |
