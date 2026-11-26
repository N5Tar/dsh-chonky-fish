# ABS 自主实验 · 定时巡检手册

供 schedule 唤醒的 Agent 使用。试验场：本机 DeepSeek Harness。

## 探测 HTTP

```bash
PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/DeepSeek/ {print $9}' | sed -n 's/.*://p' | sort -u | while read p; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$p/chonkyfish/abs" || true)
  [ "$code" = "200" ] && echo "$p" && break
done)
export CHONKYFISH_HTTP_BASE="http://127.0.0.1:$PORT"
```

若无端口：在 `docs/abs-iteration/progress.md` 记 `DSH_DOWN`，`send_to_user` 短告警，**不要**乱开应用以外的重装；可尝试 `open -a "DeepSeek Harness"` 一次。

## 可调触发门槛（实验用）

`POST /chonkyfish/abs`：

```json
{
  "action": "pacing",
  "reviewIntervalMinutes": 30,
  "reviewMinRealGapMinutes": 2,
  "actionPolicy": { "minimumGap": 0.3 }
}
```

| 字段 | 含义 | 默认 | 当前实验 |
|---|---|---|---|
| `reviewMinRealGapMinutes` | 两次审查最短**现实**间隔 | 10 | **2** |
| `reviewIntervalMinutes` | ABS 时间审查间隔 | 120 | **30** |
| `actionPolicy.minimumGap` | 社交/探索缺口入选阈值 | 0.65 | **0.3** |

内容窗结束后应还原默认值（除非进度里另有约定）。

## 巡检（5 分钟）

1. GET `/chonkyfish/abs`：记录 `mode`、`timeScale`、`nextWakeRealAt`、social sat/demand、`ownerSession`。
2. 拉当日 activities / 或 `snapshot.mjs --date <CST今天> --cycle monitor-tmp`，统计自 R01 起点后新增的 `chat_owner` enqueued / visibleReply / no_action。
3. 追加一节到 `docs/abs-iteration/progress.md`（时刻、指标、异常）。
4. `send_to_user` 两三句进度（中文）。
5. **禁止**：无分析就乱改多个旋钮、提交 git、扩大权限。
6. 内容窗进行中应保持 `timeScale=60`；若被改回且非收束任务，记异常并恢复 60（仅内容窗期间）。

## 持续 no_action 升级

若最近连续 ≥4 条 `chat_owner` 均为 `no_action`（或仅有 bash unverified、无 social 发送证据）：

1. 在 progress 写明根因假设（提示过软 / 工具文案过严 / 渠道未绑定 / 模型只回话等）。
2. **只动一个**内容向调整：优先 `review.js` `chat_owner` 提示，或 `social_send_owner_message` 描述与 persona 对齐。
3. 改完后重启 DSH、保持 pacing，再观察 ≥3 条新样本。
4. `send_to_user` 说明「原因 → 调整 → 观察指标」。

## 收束（once）

1. snapshot 为 `2026-11-25-R01-end`。
2. POST `time-scale` → `1`；确认 restHours 仍为 23:00–08:00。
3. 对比 start/end：窗内新增 chat_owner 数、no_action 比例。
4. 更新 `cycles/2026-11-25-R01.md` Decision；更新 progress 状态为 `closed`。
5. **禁用** 5 分钟 interval 巡检任务（`schedule_task` + `enabled:false` 或 `delete_scheduled_task`）。
6. `send_to_user` 汇报成果与是否进入旋钮 2。
7. 若样本≥3 且模板语气可接受但由头仍弱 → 提议 R02 由头注入（等下一轮自主继续或按 progress 决策执行）。
