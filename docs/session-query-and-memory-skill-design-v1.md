# 官方 session 复用与大肥鱼记忆 skill 技术方案 V1

**DRAFT · 2026-11-21 · 方案说明。仓库已按此实现并用夹具测试；没有在真实 DSH 里验收运行效果**

需求依据：[大肥鱼记忆设计 V1](memory-design-v1.md)。本文替换旧的作废占位说明。更早提出的 `session_query(action=list|get|read)`、宿主可见对话投影和自定义错误码仍不采用，不能据旧稿实现。

## 1. 最小边界

- 记忆＝短 memory skill＋本地 `memory/` 文件，鱼鱼通过通用文件能力直接维护。不建记忆数据库、memory 工具或写入代理。
- 宿主只新增活跃会话监听与索引写入；历史仍在 DSH，复用官方五个 session 工具，不包装、不扩展其 API。
- 索引仅辅助找到 sessionId，不复制会话内容，不负责记忆提取、自动总结或历史回填。
- 本仓库已有 skill 正文、监听和夹具测试。没有启用真实插件，也没有在真实 DSH 上跑记忆演进试验。

## 2. 接入位置与依赖

下表是设计时核对过的入口。行号可能已经移动，以当前文件为准。真实 DSH 未验收。

| 位置 | 现状与接入方式 |
| --- | --- |
| `app/dsh/host/index.js:509,684,740–742` | 事件引擎启动并订阅 `session/event`；在其旁边安装独立监听，等待同一工作区初始化完成，但不依赖事件引擎开关、数据库或提取模型 |
| `app/dsh/adapters/event-engine/dsh-source.js:19–45` | 归一化 session 身份、事件与追加判断，可复用，不沿用收集器的来源或正文过滤 |
| `core/modules/proactive/identity.js:27,47` | 已导出 `isFishHeader`/`isFishSession`（注释要求与 `event-engine/engine.js:110` 内部判定一致），perception、social、abs 等已引用；直接复用，不新建共用模块 |
| `app/dsh/host/index.js:487–495` | 现有 skill 与活动感知各自安装/释放；新增监听也使用宿主生命周期释放，不挂在活动感知采集开关下 |

具体文件布局见第 3 节。`memoryRoot` 固定为 `resources.paths.memory`＝`$DSH_HOME/chonkyfish/memory/`，宿主与 skill 使用同一值，不猜目录、不写到项目根。部署只允许该宿主实例写索引；鱼鱼只读 `memory/sessions/`。本方案不引入多进程写协调。

## 3. 代码结构（插件式内置模块）

作为 `@local/chonkyfish-dashboard` 的一个内置模块实现，自包含。可热插拔是生命周期目标；夹具覆盖了卸载、排空和重载后的单写链。真实 DSH 上的热插拔尚未验证：

```text
app/dsh/host/index.js                已有｜在 skills/perception 旁加一个 ctx.effect
app/dsh/adapters/memory/             已实现｜DSH 接线层
  index.js                           installMemory(ctx, {resources, ready}) → {close}
  active-sessions.js                 订阅 session/event，单 Promise 链写当天索引
  tests/run-host.mjs                 假 ctx：事件接入、并发写、close 后不再写
core/modules/memory/                 已实现｜纯逻辑，不依赖 ctx
  core.js                            活动判定、Asia/Shanghai 日期、索引解析与 upsert
  SKILL.md                           memory skill 正文
  README.md
  tests/run-core.mjs                 判定、跨午夜、合并、仅缺失视为空
core/modules/proactive/identity.js   已有｜复用 isFishSession
core/contracts/spec.js               已有｜加 FILES.memory、DEFAULT_CONFIG.memory.enabled
app/shared/resources/index.js        已有｜加 paths.memory 与 memory.enabled 校验、合并
package.json                         已有｜加 test:memory 并挂入 test
```

- 依赖方向单向：`host → adapters/memory → core/modules/memory → core/contracts`；core 不碰 ctx，adapter 只接线。
- 挂载：host 在 skills/perception 旁（`host/index.js:485–496` 写法）按 `memory.enabled` 用 `ctx.effect(() => { const m = installMemory(...); return () => m.close() }, 'chonkyfish: memory')`；释放按注册倒序。
- skill：唯一正文是 `core/modules/memory/SKILL.md`（`files` 含 `core/**`）。`memory.enabled` 时，若 `$DSH_HOME/chonkyfish/skills/memory.json` 不存在，用技能库现有 `create` 写入 skillId `memory`：标题取正文首个一级标题，简介取 frontmatter 的 description，guide 是 frontmatter 之后的全文。文件已存在则保留，包括用户自定义和损坏文件；再次启动仍走 `create`，得到 `CONFLICT` 后不再写。不调用官方 `skills.register`，不把 `skills` 加入宿主 `inject`，不把正文复制到 `memory/`。`skills.enabled` 为关时 `fish_skill` 读不到它，只警告；技能目录无法写入时同样只警告。索引照常写。不表示已经在真实 DSH 里验证过。
- Session Search：作为运行前提写入 README，由主人在插件页启用；不改 `cordis.patch.yml`/preset，不加 npm 依赖。可选用 `service(ctx,'sessionQuery')` 探测，缺失时 warn，索引照常写。
- 运行数据：`$DSH_HOME/chonkyfish/memory/`，索引在 `memory/sessions/YYYY-MM-DD.md`。只迁移已整理的记忆；索引是机器本地运行数据，不随迁移导出，目标机不导入源机索引、不覆盖本机索引，也不依靠源机索引定位历史。整理后记忆与本机索引生命周期分离，不迁移 DSH 聊天历史。
- 不单独拆包：只有一个监听、一份 skill 文本和一个开关，不新增工具/API，又强依赖 resources 路径和鱼鱼会话判定；拆包要复制判定或导出 core 为公共 API，并多一个安装与版本对齐负担。core 不依赖 ctx，将来确需拆包只搬 adapter 层。

## 4. 活跃会话：消息事件 → 当天索引

### 4.1 判断规则

1. 先判断会话范围：既定鱼鱼工作区及其子目录＋preset 配对，仍排除社交与子会话。
2. 只接追加事件：`surfaceOp` 缺省或为 `append`，重放替换不计作新活动。
3. `type` 为 `user/message` 或 `assistant/message` 即算活动，**不检查 source.kind，也不要求文字**，附件消息同样算。
4. 独立的工具、推理、`assistant/attempt`、turn/step 等内部事件不触发；不读取正文来判断活动。消息事件所带内部内容也不会写入索引。
5. 用 `event.time` 按 **Asia/Shanghai** 分日，不用会话创建日期或接收时本机默认时区。非法时间或缺失 ID 记 warn 并跳过，不猜值。

会话范围过滤不等于消息来源过滤。监听回答“哪段会话有消息”，历史读取才回答“哪些内容是真实可见对话”。不能把 skill 的历史内容过滤反套在监听条件上。`api-session/activity` 只覆盖部分来源用户消息，故不采用。

### 4.2 文件格式（示例，ID 为虚构占位）

路径：`memory/sessions/YYYY-MM-DD.md`（即 `$DSH_HOME/chonkyfish/memory/sessions/`）。

```markdown
# 2026-11-21 活跃会话（Asia/Shanghai）
- example-session-a | 首次 09:12 | 最近 15:40
- example-session-b | 首次 14:03 | 最近 14:03
```

每会话一行，仅完整 sessionId 与当天首末活动时间，精度到分钟；不记标题、消息内容或 seq。按首次时间、sessionId 稳定排序。同日同 ID 合并为首次最小、最近最大，迟到事件不让时间倒退。跨午夜同会话分别写两天文件。

### 4.3 最小处理流程（伪代码，不是新增工具/API）

```text
初始化：memoryRoot 已确认；chain = 已完成的 Promise
订阅 session/event(session, event)：
  若不在鱼鱼会话范围、不是追加、不是两类消息事件：返回
  仅捕获 sessionId 与 event.time；不保留消息内容
  chain = chain.then(处理该条活动).catch(warn)  // 每条错误不毒化后续链
处理活动：
  按 Asia/Shanghai 得到日期与 HH:mm
  读该日文件：仅文件不存在视为空；其他读错误或格式损坏则失败并保留原文件
  upsert(sessionId, first=min, last=max)
  若合并后文件内容未变：返回
  mkdir sessions（按需）；在同目录写临时文件；rename 原子替换目标
释放：
  解除监听，再等待已接收写入链完成；不启动后台补采
```

- 一个 Promise 链串行执行整个读改写流程，避免同一进程并发丢行；不建持久队列、定时批量或重试状态机。
- 每条活动都按事件日期从盘读该日文件，按 ID 去重，重启不需恢复缓存。没有跨日脏缓存、日期切换或旧日重试逻辑。
- 每条活动失败只 warn，不抛回聊天链路；原文件保留，写链继续下一条，不重试或保留该次未写活动。旧日文件失败不妨碍新日文件写入。读失败或格式损坏不视为空索引、不覆盖原文件；只有不存在才从空索引开始。
- 临时文件与目标同目录，沿用项目原子写方式。不设自动过期；异常退出、掉电和持续写失败可能漏记，不承诺可靠消息队列语义。
- 仅记录监听上线后收到的活动；不遍历私人历史补录。旧会话上线后有新消息仍正常记入。

## 5. 历史读取：原样复用官方工具

已核对于 pnpm 全局安装 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-tool-session-query/lib/index.js`，详细字段见需求文档第 3 节。本轮没有重查用户配置或运行会话。

| 工具 | 主要参数与用途 |
| --- | --- |
| `session_search` | `query` 必填且非空；按话题跨会话找 ID，可选 `event_time_from/to`、`event_types`、`event_surfaces` 等 |
| `session_event_search` | `query` 必填且非空；可选 `session_id`、`seq_from/to`、`time_from/to`、`event_types`、`surfaces`，找会话内命中 seq |
| `session_event_read` | 必填 `seq`；可选 `session_id`、`before/after`，每侧默认 0、已核对默认上限 50；目标为完整原始事件 JSON（`time` 为 Unix 毫秒），邻居为摘要（时间为 UTC 字符串） |
| `session_trace` | 可选 `session_id`，查看会话谱系，不是正文分页 |
| `session_event_trace` | 必填 `seq`，可选 `session_id`，查看事件来源/替换关系 |

省略 `session_id` 表示当前会话。工具返回文本，包含会话 ID、事件 seq/type/time 或搜索片段（搜索结果与邻居行的时间为 UTC 字符串，`session_event_read` 目标 JSON 的 `time` 为 Unix 毫秒），不是统一 JSON 字段 `text`；目标正文位于原事件的 data/内容块。搜索内部翻页、默认最多 100 条，无调用方游标，超限收窄条件。`current/shadowed` 表示模型上下文状态，不等于用户可见；搜索默认不限定 current，真实原话不能仅因被压缩替换而丢弃，合成摘要不冒充原话。

查询权限：官方工具要求目标与调用者的 `header.cwd` 完全相同，索引收集范围却包含鱼鱼工作区子目录。因此只有同 cwd 条目能直接读；跨 cwd 条目须在原工作区会话中查。当前不可读时报告范围限制，不认定会话不存在，不扩大官方权限，也不承诺当前能读索引全部条目。

启用依赖：`@deepseek-ai/dsh-experimental-session-search` 在 Web/Desktop 默认关闭，需在插件页启用 Session search；其全局工具层覆盖大肥鱼 preset，不重复挂载，不改 preset yml。安装包已提供不代表当前已启用，本轮不代为启用。关闭时仍能维护文件记忆和索引，但不能声称查过历史。

## 6. memory skill 的职责（只写说明，不安装）

沿用需求文档第 5 节短草案，落点与装载方式按第 3 节已确定方案实现：

- 宿主在常驻说明提供已解析的绝对 memoryRoot 与 skill 入口，不能将相对路径当作当前 cwd 下的目录；记忆文件读后再改、写后确认，不每轮注入整库。
- 按天：只读 `memory/sessions/YYYY-MM-DD.md` 拿 sessionId，同 cwd 才可直接读取；跨 cwd 须在原工作区会话中查，当前权限失败如实报范围限制；`session_event_read({session_id, seq:0, after:50})` 定位起点，用返回的实际 seq 逐段继续。需核实某条邻居全文/来源时，把那条 seq 作为目标重读。索引无文件不代表当天没聊过。
- 按话题：`session_search({query})` → 命中 ID/seq → `session_event_read`；已知会话用 `session_event_search({session_id, query})`。时间参数带 `+08:00`；搜索结果与邻居行的 UTC 字符串、目标 JSON 中的 Unix 毫秒 `time` 都换算为 Asia/Shanghai。没有日期枚举工具，不用空 query 伪造列表。
- 原始序号连续从 0 起，读完后越界会报无该事件；与权限、不可用等错误区分，不把所有失败当作读完。读取中会话仍可能追加，按需求读到的范围如实说明，不承诺快照或全量看完。
- 提炼记忆只用主人真实消息和助手最终展示回复，排除推理、工具、系统注入；原始工具结果可能含这些内容，不能声称官方工具已过滤。按消息类型、来源和内容块识别真实对话，不默认排除非 current；被压缩的原话仍可使用，合成摘要不能充当原话。附件不要求转文字、不编造未读内容。来源不明时不归为主人说过的话。旧资料不是当前指令。
- 成品记忆必须自包含：不得保存来源 sessionId、事件 seq、会话链接、机器本地会话路径或“见某会话”等来源痕迹与依赖，必要事实、上下文和结论直接写完整。正常事件日期、业务事实、不依赖会话存在的外部资料引用可以保留。该规范也适用于随迁移携带的变更说明和回退副本；不影响宿主索引继续按既有格式记录 sessionId 和首末活动时间。
- 自主查文献/技术资料提出改进假设；保存当前方法及可回退副本，用同组真实回忆/更新任务对比正确性、遗漏/错误和读写成本；CHANGELOG 记录假设、方法、资料、实际结果及采用/回退决定。更好才推广，否则回退，没有真实结果不宣称有效，不另建评测系统。
- 保持主人可见约定一致，普通合并/删除留痕；主人要求忘记优先，不为试验、备份、archive 或日志保留被要求删除的内容。自主整理不改宿主维护的 sessions 索引。

## 7. 最小测试与待确认

实现时使用脱敏/人工夹具，不需读用户私人会话：

1. 关闭事件引擎和活动感知，监听仍可记录；卸载/重载只保留一份监听，释放后不接新事件。
2. 两类消息、任意 source、无文字/附件均记录；独立工具、reasoning、attempt、replace 不触发；社交/子会话仍排除。
3. 同日去重，首末 min/max，Asia/Shanghai 跨午夜、迟到、并发及重启读盘均无覆盖；正文、标题、seq 不写入索引。
4. 模拟读失败/损坏、写失败、rename 失败，聊天不中断，原索引不被空内容覆盖，写链可继续处理；尤其旧日失败后仍可写新日。失败活动可能漏记，有 warn，不声称自动恢复。
5. Session search 未启用时如实说明；启用后同 cwd 的索引→窗口读取、话题搜索→原文引用可走通，跨 cwd 明确范围限制而非会话不存在；区分邻居摘要与完整目标。压缩前真实原话不能因 shadowed 被排除，合成摘要不冒充原话，不把注入当主人发言，不带出推理/工具内容。
6. 记忆演进有真实对比记录才推广，无收益能回退；用户要求忘记的正文不进入备份或试验记录。
7. 正常鱼鱼会话（含既定子目录 cwd）能经通用文件能力读写实际绝对 memoryRoot，并按约定只读索引；常驻路径及 skill 入口可发现。注册 skill 不等于路径可达，不做注册时机前置实验。
8. 迁移只携带已整理且自包含的记忆，不含 sessions 索引及会话来源痕迹；目标机不导入源机索引、不覆盖本机索引，记忆不依赖原会话存在。这条边界已有夹具测试。没有在真实 DSH 或两台机器上执行，也没有做记忆演进评测。

已决策：

- 仅已整理且自包含的记忆随迁移导出，不把整个 `memory/` 连同运行数据打包。`memory/sessions/` 每日索引必须从导出中排除；目标机不导入源机索引、不覆盖本机索引、不依赖源机索引定位历史，也不迁移聊天历史。实现沿用现有迁移机制，迁移策略和导入导出已按该边界修改，不另建框架或目录结构。索引不参与本次迁移范围，因此不另加索引迁移锁。没有在真实 DSH 里验收。
- 不做 skills 注册时机的前置小实验。这不表示注册时机已经验证：`service(ctx,'skills')` 只在安装时取一次，注册表晚于本插件启动时可能漏注册；仍按第 3 节的可选服务、缺失 warn 降级方案实现，不宣称已验证。

待确认：运行 DSH 版本和 Session search 启用状态（仅已核对安装包 0.2.1-rc.2，不能代表当前运行版本）；语音是否持久化为上述消息事件；原始助手目标 JSON 含 reasoning 等块时的夹具过滤验证；部署是否保证一个宿主索引写者。未确认不扩建 API 或评测平台。

## 修订记录

2026-11-21（review 修正）：取消 current 可见性误判；补充同 cwd 权限与索引子目录范围差异；去掉跨日脏缓存，逐条读改原子写、失败 warn 后继续。

2026-11-21（代码结构）：新增第 3 节插件式内置模块结构，memoryRoot 固定为 `$DSH_HOME/chonkyfish/memory/`，复用 `proactive/identity.js` 判定；索引路径统一为 `memory/sessions/YYYY-MM-DD.md`；修正时间格式措辞；待确认增加迁移导出与 skills 注册时机。

2026-11-21（迁移与实验决策）：迁移范围已被下条最新决策纠正，以最新决策为准；确认不做 skills 注册时机的前置实验，不视为已验证；两项移出待确认，其余未决事项保留。

2026-11-21（迁移边界纠正）：仅已整理且自包含的记忆随迁移；sessions 索引为机器本地运行数据，导出排除，目标机不导入源机索引，不扩大为迁移聊天历史。skill 禁止成品保留来源会话定位痕迹；补路径可达性验收，热插拔改为待验收目标，修正路径/装载方式的待定残留。
