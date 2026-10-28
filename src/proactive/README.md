# 大肥鱼 · 主动消息（Host 侧）

让大肥鱼**在你没发消息的时候先开口**：往鱼鱼会话里注入一条不可见的旁白 → 她按人格生成回复。
不伪造用户发言、不走前端假消息，主动消息和普通聊天一样是一条真实 DSH Session 记录。

> **当前形态（2026-10-28）**：只有「主动发送」这条能力，**没有任何定时器或自动触发**。
> 空闲问候、事件回访、鱼鱼自己排提醒都已经先摘掉；消息只会投到**大肥鱼面板当前显示的会话**。

## 怎么做出来的

DSH 内置的定时提醒（`dsh-schedule`）已经证明了一条受支持的路径，我们照它的做法走：

```text
ctx.sessionController.resolveAgent(sessionId)   // 冷会话会被恢复成 live Agent
  → agent.status === 'idle'                     // 不打断正在跑的 turn
  → agent.followup(userMessage)                 // 进 inbox 并唤醒一轮
  → ctx.sessions.flush(agent.session)           // 等持久化确认
```

注入的消息 `role: 'user'`，但 `source.kind = 'chonkyfish-nudge'`（`form: 'notice'`）：

- **大肥鱼面板**只渲染 `source.kind === 'user'` 的用户消息 → 旁白不可见，你只看到她先开口。
- **标准对话界面**把非 user 来源渲染成 context/notice 行（「大肥鱼主动来找你了」）→ 不是伪造的用户发言。
- **模块 0 事件引擎**会跳过非主人来源的 user 消息 → 旁白不会被抽成「主人说过」的事实。

## 为什么只会出现在面板对话里

Host 不再自己「找一条鱼鱼会话」投递（那是上次投错会话的原因），而是等面板上报：

```text
client.js  attach(session) → PUT /chonkyfish/session { sessionId }
Host       $DSH_HOME/chonkyfish/proactive.json → activeSessionId
POST /chonkyfish/proactive → 只投 activeSessionId
```

- 面板切换/新建会话时会重新上报，Host 跟着换目标；
- 没有上报（面板从未打开 / 页面还是旧版本）时，发送直接返回 `no-panel-session`，
  **绝不猜一条别的会话，也不会新建会话**；
- 显式传 `sessionId` 可以覆盖（给以后的触发点用），但目标仍必须落在鱼鱼工作区且 `agentPreset === 'chonkyfish'`，
  否则以 `identity-mismatch` 拒绝。

## 文件地图

```text
src/proactive/
  proactive.js                 服务编排：active session 上报 + send()（无定时器）
  delivery.js                  DSH 会话 API 适配：followup + flush + 鱼鱼身份校验
  identity.js                  鱼鱼会话联合判定（(工作区根, chonkyfish) 配对）
  narration.js                 默认旁白文案与 source 定义（防止穿帮的措辞约束）
  store.js                     home 内 proactive.json 持久化：activeSessionId / 发送计数 / 最近记录
  revisit.js                   【预留、未接线】事件 → 到点回访计划器（纯函数）
  tests/run-proactive.mjs      身份/旁白/存储/投递/编排 17 个用例
  tests/run-revisit.mjs        回访计划器 52 个用例（模块保留，暂不接入运行时）
```

## 对外入口

Host 路由（都需要注入页面的 `x-chonkyfish-token`）：

| 路由 | 作用 |
|---|---|
| `PUT /chonkyfish/session` | 面板上报当前会话 `{ sessionId }` → 204 |
| `GET /chonkyfish/proactive` | 只读：`activeSessionId`、最近发送记录 |
| `POST /chonkyfish/proactive` | 主动发一句；body 可选 `{ sessionId?, narration?, kind? }` |

页面控制台验收：

```js
const t = window.__CHONKYFISH_STATE__.token
await fetch('/chonkyfish/proactive', { method: 'POST', headers: { 'x-chonkyfish-token': t } }).then(r => r.json())
```

以后接自动触发（空闲 / 事件 / 外部 webhook）时，只需要调用 `service.send({ narration?, kind? })`，
目标会话仍然是面板上报的那一条。

## 跑测试

```bash
npm run test:proactive     # proactive 17 + revisit 52
npm test                   # 模块0 全部 + 主动消息
```

## 已知边界

- **DSH 必须开着**：Host 进程不在就不会有主动消息。
- **每条都花 token**：一次主动消息 = 一次真实模型调用。
- **页面要刷新**：Host 重启后 token 和上报路由都会更新，旧页面拿不到新 token，需要刷新后
  面板才能重新上报会话。
- **回访计划器未接线**：`revisit.js` 与测试保留，等触发点确定后再接回（接的时候仍然只投面板会话）。
- **路径与开关来自资源模块**：home / proactive.json / 工作区根 / preset 由 `src/resources/` 提供；
  `config.json` 的 `proactive.enabled` 关掉后，POST 会返回 `proactive-disabled`。
