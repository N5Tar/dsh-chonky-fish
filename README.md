# DSH Chonky Fish · 大肥鱼

一个给 **DeepSeek Harness（DSH）** 的公开插件：把「大肥鱼 · 小鱼塘管理台」作为一个自带面板装进 DSH，并**同时注册一个 `chonkyfish` agent preset**。装完就能和一只蓝色大肥鱼聊天，她会用真实 DSH 会话、带通用工具，还会把整个 Harness 皮肤换成小鱼塘蓝白配色。

> 独立粉丝概念 UI · 非 DeepSeek 官方产品。

![icon](icon.svg)

## 特性

- **自有面板**：侧栏六个平级入口（大肥鱼 / 零花钱 / 人格 / 感知 / 日记 / 社交），各自一个主面板：聊天页保留顶栏、消息流、无边框鱼鱼舞台、快捷 chips，其余入口把原来的弹窗内容铺成独立整页（钱包账本、人格设定、感知事件、只读日记、社交连接）
- **真实对话**：消息走 DSH Session，不是前端假回复；会话保存在 DSH 日志里，标准对话界面也能打开
- **agent preset**：安装本插件即注册 `chonkyfish` preset（人格 + 通用工具），无需单独安装预设包
- **通用工具**：bash / pwsh、文件读写与 glob/grep、后台任务、todo、web_search / web_fetch
- **全权限会话**：`chonkyfish` 会话会自动切到 `danger-full-access` + 审批 `never`，因此可以通过 AppleScript / CDP 控制本机浏览器（⚠️ 见下方安全说明）
- **专属 home**：插件所有数据都在 `$DSH_HOME/chonkyfish/` 下（状态、配置、事件库、鱼鱼工作区），不再散落
- **主题皮肤**：加载插件后把 DSH 的 14 个语义 token 之外、整套 `--dsw-static-*` 调色板重映射成小鱼塘配色（明暗主题都适配），卸载即恢复
- **角色养成**：名字 / 补充人格设定、贝壳钱包与账本、6 套姿态互动（点击害羞、投喂、思考/开心/睡着）；补充人格设定会作为 **system prompt 的补充**动态生效，不会混进用户消息
- **资源管理**：路径、路由、请求体上限、schema 版本、localStorage key、素材目录、默认配置集中由 `src/resources/` 统一管理，Host / Client 构建 / 各功能模块都从这里读取，不各自硬编码；可编辑配置落在 home 下的 `config.json`
- **状态落盘**：名字、补充人格、钱包、账本保存在 home 里的 `state.json`（Host 通过带一次性 token 的本地路由读写），HTTP API 与嵌入式浏览器存储只作为缓存/降级
- **事件感知（模块0）**：Host 侧监听 DSH 会话事件，把「小鱼塘 + chonkyfish」会话里每个 turn 交给该会话自己的模型抽取语义事件（说了喜欢 / 打算做 / 否认做过……），落 `$DSH_HOME/chonkyfish/events.db`，面板右上角「感知」可查看，每条都带原文引用与事实地位
- **主动消息（能力）**：保留「让大肥鱼先开口」的能力——Host 往**面板当前会话**里注入一条隐藏旁白，她就会主动说一句；主动消息本身没有定时器，不会自己新建或另找会话
- **日记（模块1）**：一个 `diary` 工具（write / read / list）+ 本地 Markdown（`$DSH_HOME/chonkyfish/日记/YYYY-MM-DD.md`）；模块**不带定时器**，写日记的时间由大肥鱼自己用定时任务工具安排；面板右上角 📔 图标可查看已写日记（只读）；默认只有 `chonkyfish` preset 能用，写完不用汇报
- **定时任务（DSH 原生）**：给 `chonkyfish` preset 挂了 `schedule_create / list / update / delete`，鱼鱼可以自己排一次性/每日/每周/cron 提醒（包括“每天几点写日记”），到点由 DSH 的 `schedule` 服务把提醒投回**同一条会话**
- **内嵌图片资源**：插图与头像以 WebP data URI 内嵌在 [client.js](<client.js>) 里，不下载图片

## Social 社交接入（V1.2 · 默认关闭）

新增事件感知型社交模块：QQ / Discord 消息经过身份校验和去重后进入有界收件箱，只更新未读通知，**不自动调用模型、不自动回复**。明确选择查看后才尝试将批次交给独立受限社交会话；可以沉默，只有显式发送工具才发信。

- QQ NapCatQQ / SnowLuma 共用 v11 Driver；Discord OneBots 使用 v12 Driver。真实平台兼容性和接收端验收尚未完成。
- 独立 `chonkyfish-social` preset 不包含通用工具，不读取主人日记、私人补充人格和面板历史；未经安全桥接授权的 Agent 默认拒绝 Social 工具。
- 面板顶栏「社交」入口：只填平台、接入方式、地址和凭证，再加未读会话与显式「查看」；没有开关、接收范围或允许名单。
- 自动行动引擎尚未接入；配置默认关闭，不自动连接账号。
- 参见 [Social 配置、接口、测试和限制](<src/social/README.md>)。不要把代码和模拟测试完成理解为真实平台生产可用。

## 主动消息

大肥鱼可以在你**没有发消息**的时候先开口。实现方式和 DSH 内置定时提醒完全一样：Host 往
鱼鱼会话里注入一条 **user 角色的旁白**（`source.kind = 'chonkyfish-nudge'`），驱动一个真实
turn，由鱼鱼自己生成回复。

- 面板只渲染 `source.kind === 'user'` 的消息，所以旁白不会显示；你看到的只是她先开口。
- 标准对话界面里旁白会渲染成 context/notice 行（「大肥鱼主动来找你了」），不是伪造的用户发言。
- 消息是一条真实会话记录，和普通聊天一样留在 DSH 日志里。

### 当前形态：只有能力，没有定时器

2026-10-28 起，主动消息先去掉了所有自动触发（空闲问候、事件回访、鱼鱼自己排提醒），
只保留「主动发送」这一条能力，并且**只投到面板当前显示的会话**：

1. 面板绑上鱼鱼会话后，通过 `PUT /chonkyfish/session` 把 sessionId 报给 Host；
2. Host 把它记在 `$DSH_HOME/chonkyfish/proactive.json` 的 `activeSessionId`；
3. 任何地方调用 `POST /chonkyfish/proactive`，Host 就只往这条会话注入旁白。
   没有面板会话时直接拒绝（`no-panel-session`），不会猜一条别的会话投过去，也不会新建会话。

### 触发方式（手动 / 给后续功能留的入口）

打开一次大肥鱼面板（让会话上报成功）后，在页面控制台：

```js
const t = window.__CHONKYFISH_STATE__.token

// 让大肥鱼在面板当前会话里主动说一句
await fetch('/chonkyfish/proactive', { method: 'POST', headers: { 'x-chonkyfish-token': t } }).then(r => r.json())

// 可选：自定义旁白 / 指定会话（不指定时只用面板会话）
await fetch('/chonkyfish/proactive', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-chonkyfish-token': t },
  body: JSON.stringify({ narration: '（鱼塘旁白：下午了，你想跟主人说句话。）' }),
}).then(r => r.json())

// 查看面板当前会话与最近发送记录
await fetch('/chonkyfish/proactive', { headers: { 'x-chonkyfish-token': t } }).then(r => r.json())
```

以后要接自动触发（空闲、事件、外部 webhook），在对应触发点调用同一个 `send()` 就行：
Host 会把消息投到面板当前会话。事件回访计划器 `src/proactive/revisit.js` 已经写好、有测试，
目前**未接线**，等触发点确定后再接。

> 注意：主动消息需要 DSH 正在运行；每条消息都会真实消耗模型 token；更新代码后要
> 重启 DSH（Host 半）并刷新页面（客户端需要拿到新的上报路由）。

## 日记（模块1）

日记是给大肥鱼自己的，不是系统日志。设计原则和「主动消息」一致：
**同一个大肥鱼主 Agent、同一条面板会话**，日记模块只提供工具和存储，不新增第二个 Agent，也**不内置定时器**。

- **只有一个工具**：`diary`
  - `diary(action="write", date="2026-10-28", content="...")`：写某天，默认不覆盖；
  - `diary(action="read", date="2026-10-28")`：读某天；
  - `diary(action="list", limit=30)`：列出已有日期。
- **存储**：`$DSH_HOME/chonkyfish/日记/YYYY-MM-DD.md`，一天一个文件，UTF-8、正文原样保存（不自动加标题）。
- **写日记的时间由鱼鱼自己安排**：她可以用 DSH 原生的 `schedule_create` 给自己排一个每日/每周提醒
  （例如“以后每天 20:00 提醒我写日记”）；到点提醒回到同一条会话，她再调用 `diary` 写。
  详见下方「定时任务」。
- **不新建会话、不做多会话聚合**：项目设定就是面板始终同一个会话。
- **面板查看**：右上角 📔 图标打开「鱼鱼的日记」，按日期列出、点开只读正文；
  走 token 鉴权的本地路由 `GET /chonkyfish/diary?limit=60` / `?date=YYYY-MM-DD`，不写文件。
- **谁能用**：全局注册，但 `config.diary.enabledPresets` 默认只有 `["chonkyfish"]`；
  其它 preset 的 Agent 创建时会被 `restrict` 掉，guard 再兜一层。
- **生效时机**：`diary.enabled` / `enabledPresets` 在插件启动时读取，改完要重启 DSH Host；
  `maxContentChars` 每次写入时重读。

### 手动验收

1. 在大肥鱼面板里让她“写今天的日记”，应调用 `diary` 且生成 `$DSH_HOME/chonkyfish/日记/<今天>.md`；
2. 再说一次“写今天的日记”，应返回 `DIARY_ALREADY_EXISTS`，文件不变；
3. 对她说“以后每天 20:00 提醒我写日记”，她应调用 `schedule_create` 建一个 daily 任务；
   到点提醒回到面板会话，她再调用 `diary` 写；
4. 标准 Agent 会话里应该看不到 `diary` 工具。

## 定时任务（DSH 原生）

鱼鱼可以「自己给自己排一个提醒」，用的是 DSH 自带的耐久定时任务（`@deepseek-ai/dsh-schedule` 服务 + `@deepseek-ai/dsh-tool-schedule` 工具），不是我们另写的一套。

- 挂载位置：`cordis.patch.yml` 的 `preset-chonkyfish.plugins` 里挂了 `@deepseek-ai/dsh-tool-schedule`；
  `dsh-schedule` 服务由 DSH Web 组合全局提供，所以 Host 侧不用新增代码。
- 鱼鱼可用的工具：
  - `schedule_create(prompt, title, <after_seconds | at | every_seconds | daily | weekly | cron>)`
  - `schedule_list()` / `schedule_update(id, …)` / `schedule_delete(id)`
- 行为：每个提醒绑定**创建它的那条会话**；到点由 schedule 服务恢复/唤起该会话并投一条 follow-up 消息，
  然后照常走鱼鱼的人格回复。面板始终同一个会话，所以提醒会回到面板里。
- 典型用法：让鱼鱼自己排“每天 20:00 写日记”，时间、频率都由她/你决定，不再有硬编码的 8 点任务。
- 注意：带活跃定时任务的会话在 DSH 里归档会被拒绝，先停掉/删除任务再归档。

## chonkyFish home 与资源管理

插件有自己的 home，所有数据都收在 `$DSH_HOME/chonkyfish/` 下（`$DSH_HOME` 默认 `~/.dsh`）：

```text
$DSH_HOME/chonkyfish/
  config.json        # 可编辑配置（主动消息开关 / 事件引擎节奏 / 上限）
  state.json         # 面板状态：名字、补充人格、钱包、账本、演示对话
  proactive.json     # 主动消息：面板当前会话 id、发送计数、最近记录
  events.db          # 模块0 事件库（SQLite，含 -wal/-shm）
  日记/              # 日记正文：YYYY-MM-DD.md（一天一个文件）
  小鱼塘/            # 鱼鱼工作区（DSH 会话的 cwd）
```

- **不做旧目录迁移**：插件只认 home 内的固定布局；旧版 `$DSH_HOME/小鱼塘` 不会被搬入、软链或识别。
  升级后请当作全新工作区使用（旧目录可自行删除）。
- **不复用历史工作区**：面板只使用 home 内的 canonical 工作区（`$DSH_HOME/chonkyfish/小鱼塘`）。
  如果 DSH 里还留着旧版软链工作区（例如 `$DSH_HOME/小鱼塘`），面板会忽略它并新建 canonical 工作区；
  旧条目/软链可在侧栏或文件系统里手动删除（DSH 会拒绝把新会话挂到软链路径的工作区上）。
- **工作区识别**：鱼鱼会话身份 =（cwd 落在 `$DSH_HOME/chonkyfish/小鱼塘` 内，`agentPreset === 'chonkyfish'`）。
- **资源管理模块**：`src/resources/spec.js` 是静态资源规格（home 布局、文件名、路由、限制、版本、
  localStorage key、素材目录、默认配置）的单一事实源；`src/resources/index.js` 负责解析/建目录/读写配置。
  `index.js`、事件引擎、主动消息、`build.mjs`/`client.js` 都从它取配置，不各自写死。

### config.json

```json
{
  "version": 1,
  "proactive": { "enabled": true },
  "eventEngine": {
    "enabled": true,
    "extractTickMs": 5000,
    "extractBatch": 2,
    "maxRecordsPerTurn": 400
  },
  "diary": {
    "enabled": true,
    "enabledPresets": ["chonkyfish"],
    "maxContentChars": 50000
  }
}
```

- 文件缺失 / JSON 坏 / 字段非法时自动回退默认值，不会把 Host 搞挂；
- `extractTickMs` 会被限制在 1000–60000，`extractBatch` 在 1–10，`maxRecordsPerTurn` 在 50–5000；
- 也可以带 token 通过 `GET /chonkyfish/config` 查看、`PUT /chonkyfish/config` 局部更新（深合并后原子写盘）。

## 安装

要求：DeepSeek Harness 桌面版（0.2.1 系列），推荐在配好模型的 profile 中使用。

### 方式一：本地目录安装（推荐）

1. 把本仓库克隆到任意目录：

   ```bash
   git clone https://github.com/N5Tar/dsh-chonky-fish.git
   ```

2. 在 DSH 里让 Agent 调用 `plugin_manager` 安装这个目录（需要 Creator 模式 / Full access）：

   ```
   plugin_manager({ action: "install_bundle", target: "/absolute/path/to/dsh-chonky-fish" })
   ```

   或者：

   ```bash
   dsh plugin --profile <profile> add /absolute/path/to/dsh-chonky-fish
   ```

3. 安装完成后：
   - 左侧会出现「大肥鱼」以及零花钱 / 人格 / 感知 / 日记 / 社交五个同级图标，点开即用
     （DSH 侧栏没有子菜单 API，所以六个目的地用平级入口注册，id 与主面板 key 一一对应）
   - `chonkyfish` agent preset 会自动注册（设置里能看到「大肥鱼」）
   - 第一次打开鱼鱼聊天面板会创建 / 注册「小鱼塘」工作区并新建会话；其它五个入口不建会话，只读本机数据

### 方式二：开发

```bash
node build.mjs      # 从 src/original.html + src/runtime.js 生成 client.js
```

`src/assets.json` 内是压缩后的 6 套姿态 WebP；`client.js` 是最终被 DSH 加载的产物。

## 安全说明（重要）

安装即代表你接受以下行为：

- `chonkyfish` preset 的会话会**自动切换到 `danger-full-access` 权限预设、审批策略 `never`**（Host 侧在 `agent/created` 时通过 `permissionPresets.set` 写入会话日志）。
- 这意味着鱼鱼可以使用 shell / 文件工具，**读写工作区以外的文件、执行任意命令、控制本机浏览器**，且不会弹审批。
- 它只应在你信任的机器和模型配置下使用。不想要全权限时，把 `index.js` 中 `giveFullAccess` / `agent/created` 监听删掉，或在会话里手动切回 `workspace-write`。
- 鱼鱼面板只渲染文字回复，不显示工具卡片或审批 UI；需要审批的操作请在标准对话界面处理。

## 数据与隐私

- 聊天记录保存在本机 DSH Session（`$DSH_HOME/sessions`）
- 名字、补充人格、钱包、账本和地方演示记录保存在 `$DSH_HOME/chonkyfish/state.json`，由 Host 半通过本地 `/chonkyfish/state` 路由读写；路由要求每次 Host 启动随机生成、注入到页面的 token
- 浏览器 localStorage（`chonkyfish-mini-demo-v1`）仅作为缓存和降级；首次安装/更新后刷新一次页面以拿到新的文件存储 token
- 「感知」事件保存在 `$DSH_HOME/chonkyfish/events.db`（只存抽取结果，原始对话仍在 DSH 会话日志里）；抽取会把该 turn 的对话原文发给当前配置的模型
- 主动消息的「面板当前会话 id、发送计数、最近发送记录」保存在 `$DSH_HOME/chonkyfish/proactive.json`；旁白正文与鱼鱼回复都会进入 DSH 会话日志
- 日记正文保存在 `$DSH_HOME/chonkyfish/日记/YYYY-MM-DD.md`；定时任务由 DSH 自己保存（`$DSH_HOME` 下的 schedule 存储）
- 路径、路由、上限、默认配置由 `src/resources/` 统一管理，可编辑配置在 `$DSH_HOME/chonkyfish/config.json`
- Social 默认没有任何连接；配置一条连接后 Host 才会连它的 OneBot Endpoint 并缓存收到的消息。其余图片资源无外部请求；`web_search` / `web_fetch` 会走 DSH 配置的 Web 服务

## 仓库结构

```
cordis.patch.yml   # bundle 入口：插面板 row + chonkyfish preset row
index.js           # Host 半：消费资源管理模块、给 chonkyfish 会话全权限、状态/配置/主动消息路由
client.js          # 构建产物：面板 UI + DSH 会话桥 + 主题皮肤
build.mjs          # client.js 构建脚本
src/original.html  # 融合版聊天 UI 设计稿（Shadow DOM 适配前）
src/runtime.js     # 面板控制器（增量消息、鱼鱼姿态、钱包/人格）
src/assets.json    # 6 套姿态 + 头像（WebP data URI）
src/event-engine/  # 模块0：事件结构化引擎（采集 / 提取 / 分发，自带测试）
src/resources/     # 资源管理：home 布局 / config.json / 路由 / 限制 / 素材规格（自带测试）
src/proactive/     # 主动消息：仅保留发送能力（会话上报 / 旁白 / 投递，自带测试）
src/diary/         # 日记：单工具 diary + 本地 Markdown + 面板只读查看（自带测试）
src/persona/       # 面板补充人格 → system prompt 变量（自带测试）
locale/            # 插件列表显示名与描述（zh / en）
icon.svg           # 插件图标
```

## 兼容性

在 DeepSeek Harness `0.2.1-rc.2` / `rc.3` 桌面版实测通过；依赖 DSH 的 Slot、Session、Theme、Permission、Agent Preset 等公开服务。DSH 版本升级后若接口有变，面板与 preset 可能需要跟着调整。

## License

仓库暂未附带开源许可证；如需商用或二次分发，请先联系仓库维护者。
