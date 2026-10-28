# Social V1.2 · 事件感知型社交接入

**默认关闭。收信不调用模型，不自动回复。** Social 只维护连接、身份、有界收件箱与通知；后续行动决策引擎尚未接线。现在通过面板「社交」入口或鉴权本机接口显式选择 `view`，才会创建/恢复受限 Social 会话。

## 已实现的边界

- 面板顶栏 🧩 入口：只有连接本身（平台、接入方式、地址、凭证引用）、未读会话和显式「查看」；没有开关、接收范围或允许名单，也没有自动回复和直接发信按钮。
- QQ NapCatQQ / SnowLuma 共用 OneBot v11 客户端；OneBots Discord 使用 v12 客户端。**均未完成真实平台联调，Provider Registry 明确标记 verified:false。**
- Platform / Provider 决定协议，不允许用户配置 protocol；远程连接要求 wss 和凭证引用。
- 配置好一条连接就接收它的消息（私聊/群/频道）；只过滤自身回声和机器人，其余靠去重、有界收件箱和批次确认。
- 有界持久化收件箱、身份版本、跨重启批次与发送结果；未知发送结果不自动重发。
- 独立 `chonkyfish-social` 运行 preset 共享大肥鱼静态形象，不共享主人补充人格、日记或历史。不挂载 Shell/文件/网络/委派/定时工具。
- 全局执行 guard + 安全桥接 scoped allowlist/guard；未经安全桥接授权的冷恢复 Agent 不能执行工具。
- 普通 assistant 输出不外发。只有显式 `social_send_message` 发送至当前绑定目标；查看后沉默是正常结果。

## 本地配置

面板「社交」入口是最简单的配置方式：填表保存即可，写入下面这个文件；点弹窗里的「刷新」或调用 `reload` 重新读取。所有路径由[资源规格](<../resources/spec.js>)和[资源管理](<../resources/index.js>)生成。配置位置：

```text
$DSH_HOME/chonkyfish/social/config.json
```

示例（Token 仅放到 DSH 进程可读取的环境变量中）：

```json
{
  "version": 1,
  "connections": [{
    "id": "qq-main",
    "platform": "qq",
    "provider": "napcat",
    "endpoint": "ws://127.0.0.1:3001/",
    "tokenEnv": "DSH_QQ_MAIN_ONEBOT_TOKEN"
  }]
}
```

没有连接就什么都不连接；非法配置失败关闭，不会带着半套配置跑起来。私有部署把 OneBot 直接暴露在公网时有风险：一旦配置成功，任何能给该账号发消息的人都会进入有界收件箱（不会因此调用模型）。凭证 URL 不允许写在配置中；运行时 Driver 使用 OneBot access_token 查询参数鉴权，因此远程只允许 wss。不要让代理访问日志记录该查询参数。

独立运行第三方 Provider，配置其正向 WebSocket、鉴权及文本消息段输出。本插件不安装、扫码、启动或管理 Provider。

## 本机管理接口

单一路由 `/chonkyfish/social`，所有请求都需当前页面注入的 `x-chonkyfish-token`。这里不是平台 webhook；无 Token 不可查询或操作。

```js
const token = window.__CHONKYFISH_STATE__.token;
const headers = {
  'x-chonkyfish-token': token,
  'content-type': 'application/json'
};

// 只查状态和通知，绝不启动推理，不返回收件箱正文。
await fetch('/chonkyfish/social', { headers }).then(r => r.json());

// 手工修改配置后重载；也可 action: 'configure', config: 完整配置。
await fetch('/chonkyfish/social', {
  method: 'POST', headers, body: JSON.stringify({ action: 'reload' })
}).then(r => r.json());

// 明确选择关注一个目标。此操作才可能消耗模型 token！
await fetch('/chonkyfish/social', {
  method: 'POST', headers,
  body: JSON.stringify({
    action: 'view', connectionId: 'qq-main',
    conversation: { type: 'direct', id: '替换为测试账号QQ号' }
  })
}).then(r => r.json());
```

`view` 只作用于独立社交会话，不能传主人 sessionId。没有任何未读时不需要生成回复。是否发送由受限会话自主决定，内部最终文本不会自动发给对方。

身份变化时查看状态中 pending 记录；仅本机用户可通过 `confirm_identity` 加 connectionId、expectedProtocolUserId 确认。确认会生成新身份版本，旧会话/消息不自动迁移，随后重新核验连接。

接口不提供直接发送、任意 ACK、注入任意 Agent 或提升权限的 action。

## 面板入口

面板顶栏 🧩 图标打开「鱼鱼的社交」弹窗，可以完成日常操作：

1. **连接配置**：新增/编辑/删除连接，只填平台、接入方式、地址和凭证环境变量名；保存即生效，不提供开关或接收范围设置。
2. **状态**：模块是否启用、连接在线数、受限桥接是否可用、当前配置错误；换号时按钮变成「确认新账号」。
3. **未读会话**：显示未读条数与是否被 @；「查看」会二次确认，因为会启动一轮真实模型对话。
4. **边界**：弹窗里没有「自动回复」开关，也没有直接发信按钮。回复只能由受限会话中的显式工具完成，并且你查看之后她可以不回。

面板只是这个 HTTP 接口的图形外壳，两者行为一致；接口仍然可用于排查和手工验收入口。

## 宿主桥接前提

- 宿主有 agents、agentPresets、tools、sessions、sessionPersistence 等已核验接口。
- 可信默认模型已配置。
- `chonkyfish-social` preset 已通过安装/更新插件组合加载。
- 已有 `read-only` 权限预设可用；不覆盖宿主 permission 配置或用户自定义预设。
- 必须验证精确绑定会话的实际持久化批次，不能把 followup 返回或 flush=true 独立当作已读证明。

不满足条件时 `view` 明确失败；不降级到面板会话或全权限，不影响收信和通知。运行时证据与崩溃恢复边界见[宿主审计](<../../.ai/tasks/social-v12/host-audit.md>)。源码审计和 mock 测试不等于真实宿主模型联调已通过。

## 持久化和实现选择

```text
$DSH_HOME/chonkyfish/social/
  config.json
  identities.json
  inbox/inbox-state.json
  operations.json
  session-bindings.json
  会话/
```

与设计建议的每会话文件相比，当前使用**一个有界原子收件箱快照**：让消息、全局容量裁剪、批次和游标在同一提交中一致。接口仍按 sessionKey + identityRevision 分区。文件权限 0600；目录 0700；写入先 fsync 再替换并同步目录。

工程默认值集中在[限制常量](<limits.js>)：每会话 500 条、全局 5000 条/8 MiB 正文、最多 256 个身份会话分区、保留 7 天、单批最多 100 条/32000 字符、稳定批次最多保留 1 小时、排队操作最多 128。期限惰性于操作清理；缺口显式标记。

发送操作日志最多 10000 条，达到上限拒绝新发送，不自动淘汰后重放旧 operationId。需要后续受控维护方案；不要随意删除日志后重试未知发送。

**部署限制：同一个 Social 数据目录只能有一个写入进程。** 收件箱提供进程内重复打开防护，不提供跨进程锁。不要用多个 DSH 实例同时启用同一 home 的 Social。

## 已知兼容性限制

- 只消费结构化文本消息段，不解析原始 CQ 字符串或媒体。
- 群“回复它”仅识别当前连接内已确认自身消息的有界 ID 缓存（256 条）；重连清空，未知历史引用不猜作者。
- v12 自身身份若不含 platform，使用 get_status 的 bots/self 核验；不支持该核验的网关失败关闭，需要真实版本兼容性验证。
- 未实现 Discord Thread、全部权限映射、离线补拉或可靠消息队列。
- 消息交付与 DSH 日志没有跨存储事务；未知交付状态失败关闭，不能承诺端到端 exactly-once。
- 确认游标只表示持久化接纳，不表示模型已理解、回复或对方已读。
- 新消息不会创建/恢复 Agent；没有行动引擎时需要明确选择查看，不会自动轮询 LLM。
- 实际桌面 GUI 要重载 Host 插件/重启宿主并刷新页面才使用新代码；仅修改仓库不会更新运行中的进程。

## 验证

```bash
npm run test:social
npm test
```

测试覆盖配置、身份、协议动作、无自动推理、稳定批次、精确确认、重启防重、限额与损坏保护、受限桥接和工具/HTTP 鉴权。真实 NapCatQQ / SnowLuma / OneBots、接收端可见以及 GUI 冷恢复仍需使用独立测试账号联调，禁止据模拟测试声称生产可用。
