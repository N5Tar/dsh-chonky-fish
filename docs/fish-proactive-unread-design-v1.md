# 大肥鱼主动搭话 · 侧栏未读设计 V1

**可实现 · 2026-11-23 · 方案设计。未写代码。**  
产品确认：仅统计主动搭话；选中「大肥鱼」主入口清零；已在主聊天不 +1；只要侧栏数字（方案 A：动态 `label`）；单一主会话。

主动搭话成功且主人不在大肥鱼主聊天时，侧栏「大肥鱼」显示未读数量；选中该入口后清零。

## 1. 目标与非目标

### Goals

- 仅在 **proactive 主动搭话投递成功**，且当时 **未** 停在大肥鱼主聊天时，累加未读。
- 主人 **已在** 大肥鱼主聊天时再主动搭话：**不** +1。
- DSH 插件侧栏 `id=chonkyfish` 通过 **动态 label** 展示数量（如「大肥鱼 3」/「大肥鱼 99+」）。
- **选中**侧栏「大肥鱼」主入口（chat）即清零，并标记主聊天为选中。
- 未读数落盘；进程重启后仍保留，直到再次清零。`panelFocused` 不要求跨重启保留。

### Non-goals（v1）

- 系统 / 桌面通知。
- 独立通知列表或按条已读。
- 将 `fish_schedule`、社交、ABS、其它 followup 计入未读。
- 依赖 DSH 原生 sidebar badge API（若日后有，可只换展示层）。
- 其它侧栏子入口（零花钱 / 日记 / 设置等）清零或单独角标。
- 按多会话拆未读；产品只有一个大肥鱼主会话。
- 纳入 `.fishpack` / migration 导出。
- 实时推送未读（轮询即可）。

## 2. 决策摘要

| 项 | 选择 |
| --- | --- |
| 统计范围 | 仅 `proactive.send()` 成功，且 `panelFocused === false` |
| 已在主聊天 | **不** +1 |
| 清零时机 | 选中侧栏「大肥鱼」主入口 |
| 选中态 | Host 字段 `panelFocused`；**进入/离开主路径**均为 `PUT /chonkyfish/session` |
| 进入主聊天 | `PUT { sessionId, panelFocused: true }`（兼清零）；`POST .../unread/clear` 仅兜底，Client 默认不双发 |
| 离开主聊天 | `PUT { sessionId, panelFocused: false }`（**必带**当前 sessionId） |
| 会话模型 | 单一主会话；未读不分会话 |
| 展示 | `sidebar.panellist` 的 `label` 函数拼数字 |
| 存储 | `proactive.json`：`unreadCount`；`STORE_VERSION` **保持 2**，sanitize 补默认 |
| `panelFocused` | 进程内有效；读盘缺省 / 启动默认 `false`，不依赖落盘 |
| 常量 | `MAX_STORED = 999`；侧栏展示封顶 `99+` |
| 轮询 | Client 约 5–10s；`document.hidden` 暂停 |
| 方案代号 | A（label 动态文案） |

## 3. 与现有模块的关系

```text
Client 选中大肥鱼主入口（主路径）
  → PUT /chonkyfish/session { sessionId, panelFocused: true }
  → unreadCount = 0，panelFocused = true

Client 离开主入口（切到日记等）
  → PUT /chonkyfish/session { sessionId, panelFocused: false }  // sessionId 必填
  → panelFocused = false（未读不变）

proactive.send 成功
  → 若 panelFocused：不 +1
  → 若 !panelFocused：unreadCount += 1（封顶 MAX_STORED）

Client 轮询 GET /chonkyfish/proactive
  → 刷新 sidebar label「大肥鱼 N」
```

- **复用**：`core/modules/proactive` 的 send / store；现有 `PUT /chonkyfish/session`、`GET|POST /chonkyfish/proactive`。
- **不改**：`createDeliverer` 对其它 `source.kind` 的行为；日程旁白仍走 `chonkyfish-schedule`，不进未读。
- **Client**：`app/dsh/build.mjs` 侧栏 `chonkyfish` 的 `label`；选中/离开主入口时上报 `panelFocused`。

## 4. 数据

`STORE_VERSION` **固定为 2**（不 bump）。`sanitize` 对缺字段容错。

| 字段 | 持久化 | 类型 | 含义 |
| --- | --- | --- | --- |
| `unreadCount` | 是 | 非负整数 | 尚未清零的主动搭话条数 |
| `panelFocused` | 否（内存；读盘可忽略） | boolean | 侧栏当前是否选中大肥鱼主聊天 |

规则：

1. `send` 成功且 `panelFocused === false`：`unreadCount = min(unreadCount + 1, 999)`。
2. `send` 成功且 `panelFocused === true`：**不** +1。
3. 进入主聊天（见 §5）：`unreadCount = 0`，`panelFocused = true`。
4. 离开主聊天：`panelFocused = false`；`unreadCount` 不变。
5. 损坏 / 缺 `unreadCount`：视为 `0`。启动时 `panelFocused = false`，直到 Client 上报。
6. **不迁移**：不进 migration 白名单。

产品前提：**只有一个大肥鱼主会话/主聊天入口**，未读不分会话。

## 5. Host API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/chonkyfish/proactive` | `inspect()` 增加只读 `unreadCount`、`panelFocused` |
| `PUT`/`POST` | `/chonkyfish/session` | 扩展 body（见下） |
| `POST` | `/chonkyfish/proactive/unread/clear` | 幂等清零，并设 `panelFocused = true`（与「进入主聊天」同义） |

### 5.1 `PUT /chonkyfish/session` body

```json
{
  "sessionId": "<fish-session-id>",
  "panelFocused": true
}
```

| 字段 | 必填 | 行为 |
| --- | --- | --- |
| `sessionId` | **是**（进入与离开均必填） | 更新 `activeSessionId`；缺省或非法 → 4xx，**不**改 `panelFocused` / `unreadCount` |
| `panelFocused` | 否 | 缺省：**不改变**当前 `panelFocused`。`true`：设选中并 **`unreadCount = 0`**。`false`：设未选中，不清未读。 |

**成功响应（锁定）**：当 body 含 `panelFocused`（true/false）时，返回 **200 JSON**：

```json
{ "ok": true, "unreadCount": 0, "panelFocused": true }
```

（`unreadCount` / `panelFocused` 为更新后的当前值。）  
仅绑 session、**未**带 `panelFocused` 时，可保持现网 **204**，以兼容旧 Client。

### 5.2 `POST /chonkyfish/proactive/unread/clear`

- 语义：`unreadCount = 0` 且 `panelFocused = true`。
- **Client 默认主路径不用此接口**；仅作兜底（例如 session 路由暂不可用、或调试）。与 `PUT ... panelFocused: true` 效果对齐。
- 返回 `{ ok: true, unreadCount: 0, panelFocused: true }`。
- 自动化测试以 **PUT session + panelFocused** 为主路径；clear 单测覆盖幂等即可。

### 5.3 其它

- **无**手动 +1 HTTP。
- `proactive.enabled === false`：不能 send；已有未读仍可 GET / clear / 上报 focus。
- 投递失败：**不** +1。
- 并发：以 Host 上请求完成顺序为准；不引入分布式锁。

## 6. Client 行为

1. 启动后 `GET /chonkyfish/proactive`，缓存 `unreadCount`；若当前已在主入口，立刻 **`PUT session { sessionId, panelFocused: true }`**（不要再叠 clear）。
2. `chonkyfish` 的 `label`：  
   - `0` → `t('nav')`  
   - `1–99` → `t('nav') + ' ' + n`  
   - `>99` → `t('nav') + ' 99+'`
3. **未**在主聊天时低频轮询（5–10s）；`document.hidden` 暂停。在主聊天时可停轮询或仍拉（数字应为 0）。
4. **选中**侧栏「大肥鱼」主入口（主路径）：仅 `PUT session { sessionId, panelFocused: true }`；按响应更新本地未读与 focus，刷新 label。**默认不**再调 `POST unread/clear`。
5. **离开**主入口（切到 wallet / diary / …）：`PUT session { sessionId, panelFocused: false }`（**必带**当前 sessionId）；**不** clear。
6. 其它 `PANELS`：**不**调用 clear；只有离开主聊天后的新主动搭话才再累计。

实现不按多会话拆未读；以「侧栏当前选中是否为 `chonkyfish`」为准，不为 keep-alive 做复杂状态机。

**`label` 刷新（实现清单必测）**：若 DSH 对 `label` 函数不会随缓存重算，Client 用 slots 重注册或等价刷新；计数模型不变。

## 7. 文案与 i18n

| key | zh | en |
| --- | --- | --- |
| `nav` | 大肥鱼 | ChonkyFish |
| （可选）`navUnread` | v1 允许 `nav + ' ' + display` | 同左 |

不在 `chonkyfish_modules` 能力说明里宣传未读角标。

## 8. 测试计划

| 层 | 焦点 |
| --- | --- |
| store | +1（仅 !focused）；focused 时不加；clear / focus:true 归零；缺字段默认 0；封顶 999 |
| proactive service | send × focused 矩阵；失败不加 |
| HTTP | GET 含 unreadCount、panelFocused；session PUT focus true/false（必带 sessionId；带 focus 时 200 JSON）；POST clear 兜底幂等；非法方法 |
| Client / build | label 拼法；选中只用 PUT focus true；离开 PUT focus false+sessionId；不双发 clear；label 刷新路径 |
| 手工 | 不在主聊天投主动搭话 → 有数 → 选中大肥鱼 → 消失；已在主聊天再投 → 仍无数；日程旁白不计数 |

## 9. 实现落点（预告）

| 位置 | 动作 |
| --- | --- |
| `core/modules/proactive/store.js` | `unreadCount`；内存 `panelFocused` |
| `core/modules/proactive/proactive.js` | send 条件 +1；setPanelFocused；clearUnread |
| `app/dsh/host/index.js` | session body 扩展；clear 路由；inspect 字段 |
| `core/contracts/spec.js` | clear 路由常量（若需要） |
| `app/dsh/build.mjs` / client | label、轮询、选中/离开上报、label 刷新验证 |
| 对应 tests | §8 |

技术细案可另开 `fish-proactive-unread-technical-v1.md`（实现前可选）。

## 10. 验收清单

1. 仅 proactive 成功且 `panelFocused === false` 时数字增加；日程等旁白不变。  
2. 选中「大肥鱼」主入口后数字清除，且之后在面板内再搭话不加数。  
3. 离开主入口后新的主动搭话重新累计。  
4. 停留在其它大肥鱼子入口时：若离开前未清零则数字保留；`panelFocused` 为 false。  
5. 重启后未清零数字仍在；`panelFocused` 回到 false 直至 Client 上报。  
6. 失败投递不加数；`PUT focus:true` / clear 兜底可重复调用。  
7. 侧栏文案能随未读变化更新（含 label 刷新兜底）。  
8. 离开主入口若缺 `sessionId`，Host 拒绝且 focus 不变（避免卡在 focused）。

## 11. 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-11-23 | 初稿：方案 A；范围/清零/仅侧栏数字已产品确认 |
| 2026-11-23 | 评审修订：已在主聊天不 +1；单一主会话，清零以侧栏选中为准 |
| 2026-11-24 | 补齐：`panelFocused` 契约；统一流程图与 Goals；`STORE_VERSION` 固定 2；常量与验收对齐 |
| 2026-11-24 | 再补：进入主路径锁定为 PUT session；离开必带 sessionId；带 focus 的响应锁定 200 JSON；clear 降为兜底 |
