# ABS Agent 迭代 · 操作协议

本文是 [ABS Agent 迭代闭环设计](../superpowers/specs/2026-11-25-abs-agent-iteration-loop-design.md) 的仓内操作摘要；评分口径见 [scorecard.md](./scorecard.md)。

## 角色

| 角色 | 职责 |
|---|---|
| **Agent** | 跑 PDCA 闭环：基线、分析、提议单旋钮变更、观测窗、决策记录 |
| **用户** | 内容主观验收、确认是否改代码/本机 ABS 配置、是否进入下一旋钮 |
| **大肥鱼 / ABS** | 按现有运行时行为运转；**不**自校准、不自动改参 |

首阶段 **单行动锁定**：只调 `chat_owner`。`review_pending`、`study`、`browse`、`remind_rest` 可记录基线，不主动改旋钮。

## 本基建范围（明确不含）

- **不改** `core/modules/abs/review.js`、selector、service 等 ABS 运行时；首期文案改动是 **Cycle R01** 的 Change 步骤，须经用户确认后另开实现任务。
- 不在鱼侧做奖励学习或强制发送。
- 不把私人对话全文写入可提交记录（见 `cycles/`、`scorecard.md`）。
- 不擅自改本机 DSH profile；本机 `mode` / `timeScale` / `restHours` 变更须用户确认。

## PDCA

```text
Baseline → Analyze → Change(1 knob) → Observe → Decide
快照+样本   差距报告   用户确认后实施   内容窗或频次窗   保留/回滚/下一旋钮
```

1. **Baseline**：导出 config 摘要 + `chat_owner` 统计与脱敏样本（见命令）。
2. **Analyze**：对照 [scorecard.md](./scorecard.md) 写差距；倍速窗内频次只记「1× 已知偏稀」背景，不下日频次结论。
3. **Change**：本轮 **只改一个旋钮**；写清假设、预期信号、回滚方式；**用户确认后**再动仓库或本机配置。
4. **Observe**：内容窗（倍速）或频次窗（1×），见下节。
5. **Decide**：保留 / 回滚 / 下一旋钮；轮次记录写入 `cycles/YYYY-MM-DD-Rnn.md`（可复制 [\_template.md](./cycles/_template.md)）。

| 结果 | 动作 |
|---|---|
| 内容未过 | 回滚或换下一内容旋钮，再开内容窗 |
| 内容过关 | 切 1×，开频次短窗 |
| 频次未过 | 只动频次旋钮，保持内容相关改动 |
| 两者过关 | 锁定 `chat_owner`，再开 `review_pending` / `study` / `browse` 同源协议 |

## 观测窗

### 内容窗（倍速，先跑）

- 建议 `timeScale = 60`。
- 现实墙钟约 **60–90 分钟**。
- 目标：同窗 **≥3** 条有效 `chat_owner` 且 `dispatchStatus === 'enqueued'` 的样本（受 `reviewMinRealGapMinutes` 等现实间隔约束）。
- 休息时段仍按墙钟；实验可临时收窄 `restHours`，**轮次结束必须还原**（见每轮 checklist）。
- 窗结束前用 T3 **`schedule_task`（once）** 唤醒同一线程做复盘与填 cycle。

过关线见 [scorecard.md](./scorecard.md)（有意思或一般 ≥2/3、无打扰、由头均分 ≥1.5 等）。

### 频次窗（1×，仅内容过关后）

- 切回 `timeScale = 1`。
- 建议覆盖 **半天清醒时段**。
- 记录派发次数、间隔、主人真实回复率；首阶段不写死目标次数，由用户体验判定稀/合适/太密后再定硬数字。

## 门禁

- 每轮 **一个旋钮**；同时改两个 = 无效轮。
- **禁止**用倍速窗派发次数外推「1× 每天 N 次」。
- 实验结束 **必须还原** `restHours` 及其它为观测临时改动的 config。
- 不长期用高倍速当生产配置；不为冲次数永久取消休息。

## 旋钮顺序（`chat_owner`）

**内容阶段（倍速）**

1. **行动提示模板** — `review.js` 中 `chat_owner` 措辞与允许不回的语气（Cycle R01 典型落点）。
2. **由头注入** — 仅用 activities / 已有状态中可验证字段构造具体由头；缺字段则本旋钮含最小只读扩展。
3. **社交工具 / 人格边界文案** — 仅当 1–2 后仍像被迫通知时；不扩大 `danger-full-access`。

**频次阶段（1×，内容过关后）**

4. **`drives.social`** — `decayPerHour`、`setpoint`、`ownerMessageGain`（及 feedback 侧相关项）。
5. **`abs.actionPolicy.minimumGap`**（可配置，默认 0.65）— 先调共享阈值；仅当调高社交机会明显拖累 `study` / `browse` 时，再拆 `chat_owner` 专用阈值。实验可用 `POST /chonkyfish/abs` `action:"pacing"`。
6. **`reviewIntervalMinutes` / `reviewMinRealGapMinutes`** — 影响全局机会；亦可经 `pacing` 热更新，**生产默认勿长期压低**。

## 命令入口

需要本机 **DeepSeek Harness** 已加载插件且 HTTP 可达（端口随进程变化，无固定默认值）。探测示例：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/chonkyfish/abs` 应返回 `200`。

```bash
export CHONKYFISH_HTTP_BASE='http://127.0.0.1:<dsh-port>'
node scripts/abs-iteration/snapshot.mjs --date YYYY-MM-DD --out docs/abs-iteration/snapshots/Rnn.json
node scripts/abs-iteration/summarize.mjs docs/abs-iteration/snapshots/Rnn.json
```

- 原始 JSON 落在 `docs/abs-iteration/snapshots/`（gitignore，不提交）。
- 轮次 Markdown 落在 `docs/abs-iteration/cycles/`（可提交，脱敏）。

## 数据与手工补全

- 数据源：`GET /chonkyfish/abs`、`GET /chonkyfish/abs/activities`（脚本只读拉取）。
- activities API **通常不含**会话回复正文与 ABS 提示全文；`summarize` 输出 choice 摘要等统计字段，**提示摘要与回复摘录 ≤80 字须在 cycle 中人工填写**（对照 DSH 可见内容，禁止贴全文）。

## 改 ABS 代码后的验证

涉及 `core/modules/abs/**`：`npm run test:abs`。涉及 DSH Client：`npm run build`。

## 后续

`chat_owner` 内容与频次均过关后，对 `review_pending` / `study` / `browse` 复用本 protocol / scorecard / cycles 骨架，不另起闭环体系。