# 大肥鱼 · Hello 首次使用引导技术方案 v1

> **实施修订（2026-11-13，以用户最新决定为准）**
> 人格沿用现有静态主预设及 `state.prompt` 补充机制；Hello 只提供新手预设和补充文本编辑，不替换完整主预设，不新增人格 provider 或人格文件。
> 已有非空人格设置原样保留，Hello 不覆盖。新手预设使用现有 `DEFAULT_PANEL_PROMPT`；保持默认文本时仍由现有静态预设生效，自定义文本仍是补充。
> 因此下文关于新增 `chonkyfish_persona`、`persona/profile.json`、人格迁移及旧预设升级阻断的设计已撤回，不作为实施要求。
> Hello 进度仍独立持久化，ABS mode 不变。未决操作可显式放弃引导记录后重新核对配置；放弃不回滚已经生效的业务设置、不重放未知副作用。


- 日期：2026-11-13
- 状态：实施方案，尚未实现；所有标注“新增/拟议”的文件、接口及数据结构均不存在于当前交付。
- 基线：`2f66d58`，`0.4.10`。产品依据：[Hello 首次使用引导设计](hello-onboarding-design-v1.md)。
- 本次仅新增技术文档，不修改功能代码、不提交或推送。下面的测试为实施验收计划，不是已执行的功能测试。

## 1. 不变约束与技术选择

1. 独立 `hello` 核心模块，DSH UI 独立实现，不创建第二个 Agent Loop。
2. 完整人格预设可查看、编辑，不提供性格标签卡。动态能力说明继续由 Host 装配。
3. 不增加“允许主动互动”开关，不通过 Hello 调用 ABS mode 切换。ABS 提供状态，大肥鱼决定行动。
4. 基础配置和钉钉分离提交。钉钉可跳过，失败不阻塞基础流程。
5. 服务端持久化草稿和提交记录；不把原型的 localStorage 当配置真相。凭据、配对码不进入草稿。
6. 采取可恢复的逐项提交，不宣称多个文件、采集进程和外部消息具有全局事务。
7. 不复制已有 HTTP handler 作为核心逻辑。先提取受控业务端口，原页面和 Hello 共用同一实现。

## 2. 已核对的真实实现

| 领域 | 当前源码与行为 | 接入判断 |
|---|---|---|
| Host 生命周期 | [host/index.js](../app/dsh/host/index.js) 的 apply 建资源；layoutReady 等待 ensureLayout 和迁移 recover；各安装器等待 ready | Hello 等待同一屏障；必须区分初始化中和失败 |
| 资源配置 | [resources/index.js](../app/shared/resources/index.js) 提供 getConfig、updateConfig、clientState、迁移访问屏障；updateConfig 合并后原子写文件 | 当前没有为普通配置并发更新提供 CAS 事务，需补共同写队列 |
| 面板状态 | GET/HEAD 读取，缺文件返回 `{}`；PUT/POST 要求 state 对象；generation 冲突返回 STALE_TARGET；临时文件 rename | generation 检查目前在 writeState 写队列之外，不能假定其覆盖全部并发竞态 |
| 人格 | [预设 YAML](../app/dsh/packaging/cordis.patch.yml) 主预设 prefix 是静态正文，含 supplement/modules 变量；[supplement.js](../core/modules/persona/supplement.js) 读 state.prompt | 现有字段是补充，不支持完整正文替换；必须新增 provider 并验证旧预设兼容 |
| 客户端 | [build.mjs](../app/dsh/build.mjs) 提取 original.html，组合 runtime、模块 CSS 和 React/Shadow DOM 页面，生成根 client.js；通过 slots 注册面板 | 不手工修改生成的 client.js；新增 Hello 页面来源与构建接线 |
| 感知 | [安装器](../app/dsh/adapters/perception/index.js) 加载 SQLite、探测采集器二进制、创建 preferences 并 initialize；[HTTP](../app/dsh/adapters/perception/http.js) GET action=status，POST start/pause/stop | enabled、用户采集意图、进程状态分离；不直接写 preferences 文件 |
| 感知持久化 | [service.js](../core/modules/perception/service.js) start 先校验能力并 savePreference(true)，再 startCollector；pause/stop 同时停止并保存 false | 启动失败仍可能已保存开启意图；恢复必须读 requested 与实际状态，不盲目重试 |
| ABS | [config.js](../core/modules/abs/config.js) 默认 shadow、timeScale=1；[HTTP](../app/dsh/adapters/abs/http.js) time-scale/rest-hours 更新配置后 syncClock；mode=active 另要求 confirmActive | 隐藏开关不等于已经启用主动执行；发布前独立处理运行策略 |
| ABS 生命周期 | [安装器](../app/dsh/adapters/abs/index.js) 异步启动前注册诊断路由；当前返回 initialized/close，不暴露 service | Hello 需要新增最小受控配置端口，不能假定可直接拿到 service |
| 社交 | [HTTP](../app/dsh/adapters/social/http.js) GET 返回脱敏配置与连接/bridge 状态；POST configure/reload/pair_owner/confirm_identity/view | 没有通用发送 HTTP 接口，不能虚构“发送测试”现有路由 |
| 社交服务 | [service.js](../core/modules/social/service.js) updateConfig 写配置后 reload；pair_owner 发绑定码；sendOwner 用 operationId 和账本防重 | configure 已触发重载，不能随后无条件再 reload；sendOwner 当前自行选择可用主人连接 |

HTTP 路由统一来自 [contracts/spec.js](../core/contracts/spec.js) 和 resources.routes。Hello 适配器应使用这些对象，不复制字符串路径。现有错误格式并不完全一致，新增端口负责归一化，不要求先改所有旧响应。

## 3. 模块结构与生命周期

以下为拟新增/调整位置：

```text
core/modules/hello/
  schema.js          草稿、步骤、提交输入与错误校验
  service.js         bootstrap / patchDraft / applyBase / inspectOperation
  ports.js           必需依赖与可观察结果契约
  tests/             内存端口 + 故障注入
core/modules/persona/
  presets.js         内置完整人格正文及版本（新增）
  effective.js       有效人格读取和 provider（新增）
app/shared/storage/hello/repository.js
app/shared/storage/persona/repository.js
app/dsh/adapters/hello/index.js, http.js
app/dsh/ui/hello/panel.js
```

共享存储层使用资源管理提供的路径；核心只依赖注入端口，不 import DSH ctx。DSH 页面使用现有 `module-surface.css` 和共享角色素材，不创建跨端共享 UI 框架。

Host 装配顺序：

1. 保持 layoutReady 的布局初始化和迁移恢复。
2. 安装 persona、perception、ABS、social；为 Hello 提供能力就绪 Promise 与只含必要方法的端口。
3. 先注册 Hello 路由，未就绪返回 503 `HELLO_INITIALIZING`，失败返回脱敏诊断。
4. layoutReady 后读取 Hello 仓储并核对未完成操作；只核对状态，不自动发外部消息或新启采集。
5. 客户端首次打开小鱼塘时请求 bootstrap，再决定展示欢迎、恢复或正常页面；页面组件挂载不产生采集/连接副作用。
6. dispose 取消 Hello 的订阅、轮询和排队工作，等待进行中的可控操作收尾；不额外关闭由其他安装器拥有的共享服务。

## 4. 核心端口（拟新增内部契约）

```text
panel.read() -> { generation, state }
panel.patchIdentity({expectedGeneration, name}) -> {generation, name}
persona.inspect() -> {revision, preset, override, effective, compatibility}
persona.save({expectedRevision, presetId, baseVersion, overrideBody})
abs.readSettings() -> {revision, timeScale, restHours, mode}
abs.updateSettings({expectedRevision, timeScale, restHours})
perception.inspect() -> {supported, requested, state, reason}
perception.setRequested(boolean) -> observed status
social.inspect() -> sanitized status
helloStore.read(), compareAndSwap(), journalOperation()
```

`perception.inspect()` 的字段是端口投影，映射真实 getStatus，不假定旧接口已返回完全相同的字段名。ABS 端口保持 mode 原值，内部复用校验、updateConfig 与 syncClock。panel 只修改 name，不碰钱包、日记、profileDirectory 等字段。所有端口失败返回 `{code, retryable, outcome}`，outcome 为 `not_applied / applied / unknown`，不向前端泄漏原始异常和路径。

### 4.1 共同写入口与并发

仅给 Hello 增加 mutex 不足以阻止原设置页并发写入：

- 面板 state 的读取、generation 比较、字段合并、落盘及 generation 更新须进入同一仓储队列，旧 state 路由也使用该入口。
- 配置更新须在 resources 的共同写队列中完成“读最新→合并→写”，不是每个调用者各自 getConfig 后写。新增 ABS revision 或等价的原子 CAS 能力；别把 read-back 相等当并发安全证明。
- 不改变旧 API 格式时，可先让旧调用无 expectedRevision 但仍走串行队列；Hello 使用条件更新。旧页面后写可以成为新版本，Hello 检测到冲突需回填和让用户重审。
- 迁移屏障包住实际持久化；执行开始和外部副作用前再次检查。不要持有跨模块锁等待用户在钉钉配对。

## 5. 数据与存储（拟新增）

统一在 contracts 的 FILES/ROUTES 中增加规范，建议 Hello 文件位于插件 home 的 `hello/state.json`、人格位于 `persona/profile.json`；实际寻址经 resources，不硬编码 `$DSH_HOME`。这两个名称是本方案建议。

Hello 示例：

```json
{
  "schemaVersion": 1,
  "flowVersion": "hello-v1",
  "revision": 3,
  "status": "draft",
  "step": "rhythm",
  "entryKind": "new",
  "draft": {
    "name": "大肥鱼",
    "persona": {"presetId": "chonkyfish-default", "baseVersion": "1", "overrideBody": null},
    "perceptionRequested": false,
    "abs": {"timeScale": 1, "restHours": {"enabled": true, "start": "23:00", "end": "08:00"}}
  },
  "baseCompletedAt": null,
  "dingtalk": {"status": "not_started"},
  "lastOperationId": null
}
```

- `perceptionRequested:null` 表示尚未选择，不得默认为 true；上例 false 表示用户已明确选择。
- `overrideBody:null` 表示沿用预设；空白文本不当成覆盖人格，返回字段错误。
- 预设版本示例 `1` 需由维护者确立，不能宣称已有版本目录。
- status：`draft / applying / partial / completed`。钉钉单独 `not_started / skipped / configuring / connected / pairing / bound / verified / failed`；实际连接状态每次另读，旧 verified 不证明今天在线。
- 操作日志单独有界存储：operationId、输入摘要、各步骤 pending/applying/applied/failed/unknown、时间、错误码及预期业务版本。建议保留最近 32 项并保留所有未决操作；达到未决上限拒绝新提交，不淘汰防重记录。
- 存储采用同目录临时文件、文件同步、rename、目录同步及严格 schema 校验；权限复用平台层私有文件约定。损坏文件保留，进入诊断，不静默回退默认并写覆盖。
- 草稿可能含私人 Prompt，按用户资料保护；不进入日志、遥测、HTML 注入、模型上下文或浏览器 localStorage。浏览器仅持内存编辑状态。

## 6. 完整人格方案

### 6.1 唯一来源和组装

将主预设的人格正文原样提取为受版本管理的内置数据，不在方案中重新编写性格。新增 `chonkyfish_persona` provider，主预设 prefix 拟改为：

```text
{{chonkyfish_persona}}{{chonkyfish_supplement}}{{chonkyfish_modules}}
```

- persona provider 只输出完整人格正文；用户不编辑内部模板槽位。覆盖正文中出现保留槽位应拒绝并解释，避免重复装配。
- supplement 保留现有补充语义，不将完整人格复制到 state.prompt。已有补充显示在高级预览中，默认保留；清空需要独立明确操作，本期不自动迁移删除。
- modules 保持实时能力说明；不将钉钉连接状态等缓存进人格文本。
- 新增人格文件记录 presetId/baseVersion/overrideBody/revision。升级预设不改自定义正文；提供“查看新预设”和明确恢复操作。
- 名称继续来自面板 state；人格正文包含固定名字时，不做任意字符串替换。可由 provider 加入受控当前称呼行，并在有效预览中展示；必须测试不与正文产生两个身份。预设源码可在专门人格变更中改为结构化称呼，不能由 Hello 临时改写。

### 6.2 旧 DSH 预设是发布阻断项

修改打包 YAML 不证明已安装会话会采用新 prefix。先以测试宿主及真实 DSH 验证：安装升级是否更新已有 preset、旧会话下次请求是否重新解析变量、provider 递归模板行为。

若不能证明完整 persona 已被主会话使用，Hello 返回 `PERSONA_UPGRADE_REQUIRED`，提供宿主预设升级/重启说明，不显示“人格已生效”。不把覆盖正文追加到旧 supplement 作为降级。访客社交预设保持独立人格与隔离，不能继承主人自定义正文或补充资料。

## 7. Hello HTTP API（全部拟新增）

建议资源键 `routes.hello` 对应 `/chonkyfish/hello`。复用当前管理面板的宿主访问边界，不宣称新增鉴权系统。

| 方法 | 请求 | 行为 |
|---|---|---|
| GET | 无 action | bootstrap：引导状态、真实配置、各服务能力、预设元数据、进行中操作 |
| POST | action=save-draft, expectedRevision, patch | 严格允许字段，校验并 CAS 保存；无运行副作用 |
| POST | action=apply-base, operationId, expectedRevision, expectedSources | 锁定对应草稿版本，启动基础提交；返回 202 与 operationId |
| GET | action=operation&id=… | 查询逐项结果；不存在返回 404，不能自动创建操作 |
| POST | action=resume, operationId | 核对后仅重试确定未应用的项目；unknown 先核对，不重放副作用 |
| POST | action=skip-dingtalk, expectedRevision | 只标记跳过，不删除已存在社交连接 |

接口返回统一 envelope：`{ok:true,data}` 或 `{ok:false,error:{code,message,retryable}}`。新增错误码例如 `HELLO_STALE_REVISION`、`HELLO_INVALID_DRAFT`、`HELLO_SOURCE_CHANGED`、`HELLO_PARTIAL_APPLY`、`HELLO_OUTCOME_UNKNOWN`、`PERSONA_UPGRADE_REQUIRED`、`MIGRATION_BUSY`。

拟定限制：JSON 请求最多 128 KiB，完整人格正文最多 64 KiB UTF-8；名称先对齐共享字段契约，若当前未定义则新增统一限制，不能只做 UI 限制。服务端不认识的键拒绝。GET 返回不含凭据与身份映射，`Cache-Control:no-store`。所有写请求校验 JSON、Origin/Host 与 Sec-Fetch-Site，参照感知适配器；这是对新路由的要求，不声称现有所有路由均已做到。

基础 apply 不接收任意业务 action、mode、路径、URL 或文件名。快照 expectedSources 包含 panelGeneration/personaRevision/absRevision；感知运行态另读，不用进程状态做持久配置 revision。

## 8. 提交、失败与恢复

基础提交顺序：

1. 校验草稿完整、版本未变、服务已就绪、迁移未进行，人格装配兼容检查通过。
2. 先持久化 operation 意图和输入摘要；相同 ID + 相同输入返回原操作，不同输入返回冲突。
3. 保存名称与人格，写 ABS 两项设置并同步时钟。每步写前记录 applying，写后回读版本和值再标记 applied。
4. 最后执行感知选择。false 对已停用不重复 stop；对运行中停用需 UI 已明确说明。true 先读取 requested/actual，避免每次恢复都 start 新进程。
5. 完整回读成功才记 baseCompletedAt。失败保留成功项，不回滚名称等已确认更新，也不自动逆转用户后来手动修改。

崩溃窗口处理：

| 情况 | 恢复动作 |
|---|---|
| journal 已写，业务未写 | 状态及版本确认未变化后允许重试 |
| 业务已写，journal 未确认 | 通过版本、目标值及业务 operation 关联核对；不能单凭相同文本证明归属 |
| 目标被其他设置页修改 | SOURCE_CHANGED，保留现值，用户重审并创建新操作 |
| 感知意图 true 但进程 error | 显示“已保存开启意图，尚未运行”；让用户重试或显式改为 false 后继续 |
| 配置写成功但 syncClock 失败 | 区分持久化成功/运行同步待完成，重试同步，不重复覆盖其他配置 |
| 文件写入结果无法确认 | unknown，先检查仓储，不自动标记成功 |
| Host 重启遇到 applying | 启动只核对；不会默认外发测试消息、发行新绑定码或恢复未确认的启动动作 |

进一步要求业务端口提供操作关联或原子“业务值 + lastOperationId”，否则读取同值只能确认当前目标状态，不能声称完整 exactly-once。V1 不承诺分布式精确一次执行。

## 9. 钉钉接入与验证

- 复用 social configure 的实际结构，先读脱敏配置，在服务端保留其他连接；不能用一个新连接的 UI 对象替换整个社交配置。Secret 合并沿用 mergeConfigSecrets，不将脱敏占位符当密钥提交。
- configure 本身写配置并 reload，完成后轮询 inspect；不要额外启动第二个 Stream 客户端作探针。
- 连接状态、身份已验证、主人已绑定分开显示。pair_owner 使用 connectionId；10 分钟一次性码只存内存展示，以服务返回有效期为准，不落 Hello 草稿或日志。新码替代旧码且不立即抹掉既有主人。
- 不默认确认身份变化；confirm_identity 保持现有 expectedProtocolUserId 流程。用户变更应用身份必须重新核对目标。
- **V1 推荐真实收发验证由用户在机器人私聊发送一句普通测试话，观察该私聊的实际回复。** 配对码控制消息不进入模型；普通话会进入模型并可能计费。现有管理 HTTP 无发送接口，因此不伪造“点击即发送成功”。未有可信结果证据则显示“待验证”，用户自报验证须标为“用户确认”，不能冒充机器检测。
- 若后续要求一键发送：新增 Host-only、固定测试文本、限定当前已配对主人、显式点击的用例；复用 sendOwner 幂等账本。当前 sendOwner 自行选择首个合格连接，多连接场景需先补 connectionId/identityRevision 的精确选路契约，不能直接暴露任意联系人发送 API。
- 对外发送 unknown 不自动重试；日志只存脱敏码和 operationId。测试请求不进入基础 apply 批次。

## 10. 已有用户、迁移和安全

### 10.1 首次识别

ensureLayout 会创建默认配置和目录，不能用“目录存在”断言已有使用记录。bootstrap 综合读取面板资料、实际感知偏好、社交配置及历史状态。存在真实资料但缺 hello 标记时取 `entryKind=existing`，不强制阻塞、不重设默认，只提供继续设置入口。不确定时按已有用户保护；首次安装的明确标记应在初始化前检测并持久化，不能靠当前默认 config 值猜测。

### 10.2 资料迁移

V1 建议 Hello 的进度与操作日志不进入 fishpack，迁移后根据当前资料重建非阻塞入口；不要恢复另一台电脑“已采集/已连接”的运行状态。新增完整人格文件应纳入“身份与人格”迁移范围，需要同步改导出白名单、schema、校验、预览与恢复测试；旧包没有该文件时沿用原有补充和预设兼容策略，不静默清空本机覆盖。本文只规划，不修改现有迁移包格式。

### 10.3 数据边界

沿用现有宿主权限边界；能访问宿主不等于任意网页可控制 Hello。新写接口做同源检查和字段白名单，服务端路径由资源管理决定。UI 用文本值渲染 Prompt，不 innerHTML 拼接用户输入；校验 UTF-8 字节上限、控制字符及日志脱敏。凭据只走社交现有服务，Secret 当前为本地明文私有文件，不宣称加密。引导不授予工具权限、不改安全策略、不读取用户个人资料正文作为欢迎语。

## 11. 测试与实施分解

### 阶段 A：接入阻断项与基础写入口

- 提取 panel 仓储原子比较/更新；resources 配置共同写队列与 revision。
- 验证 DSH 人格变量/已有预设升级，输出可复现的兼容矩阵。失败就不开放全文保存。
- 确认 ABS 运行目标：现有 shadow 与产品自主决策的差异单独评审；Hello 仍不切 mode。

### 阶段 B：Hello 核心与持久化

- schema、端口、CAS、操作日志、状态恢复、已有用户识别。
- 单元测试：未选择感知、非法时间、0/小数/120/越界倍率、空人格、版本冲突、重复 operationId、损坏文件、每一步崩溃注入。
- 并发测试：Hello 与旧设置页同时改 state/config；迁移请求期间写入；Host dispose 与执行竞争。检查钱包等无关字段不丢失。

### 阶段 C：基础页面与真实服务

- 页面加入现有构建和 slots，不编辑生成 client.js。新增 `zh/en` 文案，默认入口按 bootstrap 选择；提供设置页重新进入。
- 实机感知测试区分 macOS 支持与缺二进制/SQLite 不可用；持久意图成功但采集失败必须正确显示。
- ABS 测试固定 UTC+8、跨午夜/同日、端点、关闭时段、倍率不影响现实防打扰、syncClock 失败恢复；确认不写 mode。
- Persona 测试正文仅一次、补充保留、能力说明动态、旧会话与访客隔离、预设升级不覆盖自定义。

### 阶段 D：钉钉与回归

- 配置 Secret 留空保留/身份变更重填、保留其他连接、身份待确认、码过期/替换、断连和 unknown。
- 模拟传输与真实钉钉双向联调分开记录；只看到 Ping/Pong 或 connected 不算消息验收。
- 浏览器测试基础完成/重开/返回/刷新、失败重试、可选跳过、长 Prompt、键盘、窄屏与无横向溢出。
- 运行仓库已有 persona/perception/abs/social/migration/platform/build 相关测试及新 hello 测试；按 package.json 实际脚本选择，不把文档检查当功能测试。

发布门槛：上述差距有实现与验证证据、旧用户不被覆盖、无隐藏模式变更、部分成功可恢复、无 Secret 泄漏、完整人格确实进入目标主会话。再将状态从“方案”改为“已实现”，附测试环境与未覆盖范围。
