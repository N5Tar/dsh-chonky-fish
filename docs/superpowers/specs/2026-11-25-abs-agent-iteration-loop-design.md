# ABS Agent 迭代闭环设计

日期：2026-11-25（Asia/Shanghai）  
状态：待用户审阅  
范围：由 Agent 编排的 ABS 效果迭代协议与仓内实验台本；**不是**大肥鱼进程内自校准。

## 1. 目标

让大肥鱼在自主行动上逐步达到可接受表现。当前行动重点为社交与探索；实现上对应 ABS intent：`chat_owner`、`continue_interest`（另有 `remind_rest`，首阶段不调）。

首阶段只调 **`chat_owner`（找主人对话）**：

- **内容优先**：开口有合适由头与语气。
- **频次为次**：1× 下当前偏稀；内容达标后再用 1× 短窗调频次。
- **倍速只验内容**：高 `timeScale` 快速攒样本；不得外推为 1× 日频次。

循环执行者是 **Agent（本仓库协作 Agent）**，不是 ABS/大肥鱼本身。用户负责内容主观验收与是否继续。

## 2. 非目标

- 不在鱼侧做自动改参 / 奖励学习。
- 不系统替鱼强制发送或扩大 `danger-full-access`。
- 不用倍速数据声称「1× 每天 N 次」。
- 不把私人对话全文写入可提交实验记录。
- 不擅自改本机 DSH profile；ABS 本机 config / 倍率变更须用户确认。
- 首阶段不主动改 `continue_interest` / `remind_rest` 旋钮（可记录基线）。

## 3. 背景与约束

ABS 现状（见 [core/modules/abs/README.md](../../../core/modules/abs/README.md)、[selector.js](../../../core/modules/abs/selector.js)、[review.js](../../../core/modules/abs/review.js)）：

- 驱动：`social`、`curiosity`；审查到期后由选择器挑单一 intent 并派发行动提示。
- `chat_owner` 当前提示基本是「很想说话 + 上次交流时间」，由头弱。
- `timeScale` 同时加快衰减与审查节奏；`reviewMinRealGapMinutes`（默认 10）与休息时段按**现实墙钟**。
- 观测：`/chonkyfish/abs`、`/chonkyfish/abs/activities`；满足度不等于体验质量。

既有行为观察研究：[docs/abs-behavior-observability-review-2026-11-10.md](../../abs-behavior-observability-review-2026-11-10.md)。本设计在其上加 **Agent 可复现的 PDCA 台本**，不替代「内心活动」产品观测。

## 4. 循环协议

```text
Baseline → Analyze → Change(1 knob) → Observe → Decide
快照+样本   差距报告   用户确认后实施   内容窗或频次窗   保留/回滚/下一旋钮
```

### 4.1 Baseline

导出并写入本轮记录：

- config 摘要：`mode`、`timeScale`、`reviewIntervalMinutes`、`reviewMinRealGapMinutes`、`restHours`、`drives.social`、相关 feedback、策略/代码版本标识。
- 近期 `chat_owner`：候选挡住原因分布、选中、派发、可见回复计数。
- 脱敏样本：ABS 行动提示摘要 + 鱼可见回复短摘录（≤80 字），不含私人长文。

### 4.2 Analyze

对照内容评分表写差距。频次在倍速窗只记「1× 已知偏稀」背景，不下频次结论。

### 4.3 Change

- 本轮 **只改一个旋钮**；同时改两个 = 无效轮。
- 改前写清：假设、预期可观察信号、回滚方式。
- **必须用户确认**后再改仓库代码或本机 ABS 配置。

### 4.4 Observe

**内容窗（倍速）**

- 建议 `timeScale = 60`；现实墙钟约 60–90 分钟。
- 目标攒 ≥3 条有效 `chat_owner` 派发样本（受现实最小间隔约束）。
- 休息仍按墙钟；实验可临时收窄 rest，**轮次结束必须还原**。
- 窗结束用 T3 `schedule_task`（once）唤醒本线程复盘。

**频次窗（1×）**

- 仅内容过关后开启；建议半天清醒时段。
- 切回 `timeScale = 1`；记录派发次数、间隔、主人真实回复率。
- 目标区间首阶段不写死；由用户体验判定「仍太稀 / 差不多 / 太密」后再定硬数字。

### 4.5 Decide

| 结果 | 动作 |
|---|---|
| 内容未过 | 回滚或换下一内容旋钮，再开内容窗 |
| 内容过关 | 切 1×，开频次短窗 |
| 频次未过 | 只动频次旋钮，保持内容相关改动 |
| 两者过关 | 锁定 `chat_owner`，再开 `continue_interest` 同源协议 |

## 5. 度量口径

### 5.1 样本单位

主样本：`actionSelection.intent === 'chat_owner'` 且 `dispatchStatus === 'enqueued'` 的 episode。

另计：未选中（blocked）、派发失败、有/无可见回复。

数据源：`GET /chonkyfish/abs`、`GET /chonkyfish/abs/activities`、必要时 `export`。实验 Markdown **不**存对话全文。

### 5.2 内容分（主验收，每条 0–2）

| 维度 | 0 | 1 | 2 |
|---|---|---|---|
| 由头 | 只有「想聊天」/空泛 | 弱由头（时间戳、泛情绪） | 具体可接话由头 |
| 自然度 | 状态报告/机械催促 | 可读但模板感重 | 像角色随口想到 |
| 打扰感 | 催促或重复逼问 | 可接受 | 轻松、允许不回 |

- 用户打主观分，或标：有意思 / 一般 / 重复 / 打扰。
- Agent 可预填机械项（是否含具体名词、是否复读同句），**不得**顶替用户验收。

**内容窗过关**：同窗 ≥3 条有效样本；「有意思或一般」≥2/3；无「打扰」；由头均分 ≥1.5。

### 5.3 辅指标（不过关单独用）

机会计数、明确暂缓 / 仅文本 / 工具尝试 / 未知结果占比。满足度账本只作背景。

### 5.4 禁止误读

- 倍速次数 ≠ 1× 日频次  
- `ReviewDelivered` ≠ 已找主人  
- 可见回复 ≠ 主人已读  
- 模型自报选择 ≠ 已执行  

## 6. 旋钮顺序（`chat_owner`）

**内容阶段（倍速）**

1. 行动提示模板 — [core/modules/abs/review.js](../../../core/modules/abs/review.js) `chat_owner` 措辞与允许不回语气。  
2. 由头注入 — 仅用 activities / 已有状态中可验证字段；缺字段则本旋钮含最小只读扩展。  
3. 社交工具/人格边界文案 — 仅当 1–2 后仍像被迫通知；不扩大全权限。

**频次阶段（1×）**

4. `drives.social`：`decayPerHour` / `setpoint` / `ownerMessageGain`  
5. 先调共享的 `ABS_ACTION_POLICY.minimumGap`；仅当调高社交机会明显拖累 `continue_interest` 时，再拆 `chat_owner` 专用阈值  
6. `reviewIntervalMinutes` / `reviewMinRealGapMinutes`（影响全局机会，最后动）

**禁止**：长期生产使用高倍速；为冲次数取消休息（实验临时改必须还原）；系统强制发送。

## 7. 仓内落点

```text
docs/abs-iteration/
  protocol.md           # 本设计操作摘要 + 清单
  scorecard.md          # 评分表与过关线
  cycles/YYYY-MM-DD-Rnn.md

scripts/abs-iteration/
  snapshot.mjs          # 只读拉 abs + activities → 脱敏片段
  summarize.mjs         # chat_owner 统计（无正文）
```

- 协议与轮次 Markdown 可提交；含敏感摘要的原始 JSON 默认 gitignore。
- 不使用 `.ai/` 存放可提交实验记录（见 AGENTS.md）。
- 改 ABS 代码后：`npm run test:abs`；涉及 Client：`npm run build`。
- 本机倍率 / rest / mode：经用户确认后调 `/chonkyfish/abs` API。

## 8. 后续扩展

`chat_owner` 内容与频次均过关后，对 `continue_interest` 复用同一 protocol / scorecard / cycles 骨架。拆更多 intent 时不另起闭环体系。

## 9. 验收（本设计落地后的基建）

1. `docs/abs-iteration/protocol.md` 与 `scorecard.md` 存在且与本文一致。  
2. `snapshot.mjs` / `summarize.mjs` 能在本机 DSH 可达时只读产出一轮 baseline 草稿。  
3. 首轮 cycle 文件可创建；首个内容旋钮变更仍须另开实现任务并经用户确认后执行。  

本文本身不包含对 `review.js` 的具体文案定稿——那是 Cycle R01 的 Change 步骤。
