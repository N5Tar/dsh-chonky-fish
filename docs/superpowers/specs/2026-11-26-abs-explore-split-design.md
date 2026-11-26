# ABS 探索拆分设计（R03）

日期：2026-11-26（Asia/Shanghai）  
状态：设计已与主人确认，待实现  
范围：`core/modules/abs/**`、`app/dsh/adapters/abs/host.js`、`app/shared/storage/abs/sqlite.js`、ABS 面板文案；不新增浏览器工具。

## 1. 目标

把单一的「探索」（`continue_interest`）拆成三类：**代办回看**、**学习**、**逛网站**。

- 学习、逛网站驱动好奇满足度（探索）。
- 代办回看由自己的信号触发，**不计满足度**。
- 整理类删除。

## 2. 三类定义

| intent | 中文 | ABS 做什么 | 鱼鱼自己做什么 | 计分 |
|---|---|---|---|---|
| `review_pending` | 代办回看 | 算法选中后派发「回看一下我的代码或日程」 | 用已有工具（读文件、bash、`fish_schedule`）回看 | 不计 |
| `study` | 学习 | 算法选中后派发「看看前面记下的学习线，接着想想」 | 用 `fish_skill` 或文件工具读记忆，自己决定学什么 | 有来源的搜索；或对记忆目录的去重写入 |
| `browse` | 逛网站 | 算法选中后派发「去网上逛逛，看看有没有新鲜的东西」 | 用 `browser-cdp` 技能（贴吧用 `tieba-browsing`）自己操作浏览器 | 浏览器页面内容的 `eval` 非空输出 |

提示文本全部第一人称，并通过现有禁用词检查（`core/modules/abs/tests/run-review.mjs` 的 `BANNED`）。

### 2.1 产出去向（由鱼鱼决定，ABS 不指定）

- 学习想法 → 鱼鱼写入记忆目录（`resources.paths.memory`），由记忆模块维护。ABS 不解析记忆内容。
- 聊天话题 → 鱼鱼自己在会话里聊，或由 `chat_owner` 的由头引用。
- 分享、发帖、回复、留言等对外互动 → 鱼鱼在正常推理中自己决定，走既有渠道。**ABS 不触发、不计分。**

逛网站**不限只读**：浏览器操作可以包含互动，但互动由鱼鱼决定。

## 3. 选择器

- `PRIORITY`（[selector.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/selector.js)）：`remind_rest: 3`，`study: 2`，`browse: 2`，`review_pending: 2`，`chat_owner: 1`。
- **学习、逛网站**：好奇缺口 `curiosityGap`，门槛 `actionPolicy.minimumGap`（默认 0.65），分数 `actionPolicy.explorationScoreFactor × curiosityGap`（现有参数，默认 0.8）。
- **代办回看**使用独立信号，不依赖好奇满足度：
  - 距上次代办回看的小时数 `h`（取最近一次 `review_pending` 且派发为 `enqueued` 的真实时间；从未回看过则 `h` 视为饱和）。
  - 信号 `s = min(1, h / 24)`。
  - 门槛 `actionPolicy.reviewMinGap`（默认 0.5，即约 12 小时后才可选中），分数 `s`。
  - 因此代办回看在两次选中之间自然至少间隔约 12 小时，不需要额外冷却。
  - `reviewMinGap` 需要同时加进 [selector.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/selector.js) 的 `ABS_ACTION_POLICY` 常量和 `resolvePolicy`，不只是 config。
- 同一次审查只选一个 intent（沿用现有行为）。
- **分数量纲不同。** `s` 是绝对值（0–1），探索分数是 `0.8 × 缺口`。`s` 饱和时可能压过探索类。上线前在 shadow 模式检查选中分布，必要时调 `reviewMinGap`。

## 4. 计分变更（`app/dsh/adapters/abs/host.js`）

1. **记忆目录写入计分。** 现在 `write`/`edit` 只在 `resources.paths.workspace` 内计分。扩展允许根：加入 `resources.paths.memory`。ABS 自身状态目录仍排除。证据沿用现有去重键（工具类型 + 路径 + 内容 SHA-256）。
2. **学习写入不设上限。** 记忆目录写入与其他已验证的本地写入一样计分，只受去重和每轮上限约束。
   - 实现时核对 [store.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/store.js) 的状态校验，确保新增可选字段不会被拒绝，且不需要升 `schemaVersion`。
3. **`browse` 验证器。** 在 `bash` 证据判定中，**先于**现有的 `path` 门控处理：仅当命令是调用 `cdp.py` 的 `eval`，且工具回执成功、输出非空，才记为 `local_content_found`，证据键为 `sha256('browse' + 表达式 + 输出)`。
   - `goto` 只打印 `document.title`，**不计分**，因为它不代表取到了页面内容。
   - `cdp.py` 的路径用 `resources.paths.personalProfile`（由 `PERSONAL_PROFILE_DIR` 拼出，见 [resources/index.js](/Users/jinyan/workspace/chonkyFish/app/shared/resources/index.js) 第 237 行）解析，不写死。
   - 命令从 `tool/call` 的参数取，结果内容从 `tool/result` 取。已在真实会话日志确认：bash 回执的 `meta` 为空，没有 `path`。
   - 其它 bash 仍不计分。
4. **`review_pending` 不计分。** 它的任何工具调用都只记录，不产生满足度。判断依据是 `turn.action.intent`（[host.js](/Users/jinyan/workspace/chonkyFish/app/dsh/adapters/abs/host.js) 第 181–182 行已有）。
5. 每轮本地活动上限沿用现有规则（阅读、写入、浏览共享一次）。
6. `web_search` 的规则不变（`explore_content_found`，按来源计分）。

已知局限：`eval` 也可能用于点击发帖，只要输出非空就计为浏览证据。这是客观代理，不代表内容质量。

## 5. 由头

- 逛网站产出的已验证结果写入 `lastExploration`（`resultKind: local_content_found`，`activity: browse`）。
- [review.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/review.js) 的 `buildChatHook` 接受近 6 小时内 `activity === 'browse'` 的结果，文案为「我最近一次出去逛是 …」。现有的 `explore_content_found` 分支保持不变。
- 学习的由头不由 ABS 生成，由鱼鱼读记忆后自己决定。

## 6. 数据与兼容

- **schema 迁移。** `activity_action_selections.intent` 的 CHECK（[sqlite.js](/Users/jinyan/workspace/chonkyFish/app/shared/storage/abs/sqlite.js) 第 16 行）目前只允许 `chat_owner`、`remind_rest`、`continue_interest`。需要表重建迁移，允许 `review_pending`、`study`、`browse`。
- **仓库方法。** 新增 `lastReviewPendingAt()`（或并入 `actionContext()`），返回最近一次 `review_pending` 且派发为 `enqueued` 的真实时间。新方法要加入 [service.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/service.js) 第 23 行的必需方法列表。
- `ACTION_INTENTS` 集合（[sqlite.js](/Users/jinyan/workspace/chonkyFish/app/shared/storage/abs/sqlite.js) 第 8 行、[host.js](/Users/jinyan/workspace/chonkyFish/app/dsh/adapters/abs/host.js) 第 13 行）同步更新。
- `continue_interest` 保留为历史值，不再被选中。历史记录在面板显示为「旧探索」。
- 面板文案（[activity-panel.js](/Users/jinyan/workspace/chonkyFish/app/dsh/ui/abs/activity-panel.js) 第 7 行）新增三类中文名。`client.js` 是生成物，只能 `npm run build`。

## 7. 不做的事

- 不新建浏览器工具，使用现有 `browser-cdp` 技能。
- ABS 不解析记忆内容，不生成学习由头。
- ABS 不触发发帖、回复、留言。
- 不改 `chat_owner` 的社交满足度计分。
- 不扩大权限。浏览器操作沿用鱼鱼会话已有权限，实现时核对 `danger-full-access` 边界，不新增。

## 8. 验证

- `npm run test:abs`：新增 selector（学习、逛网站按好奇缺口；代办按时间信号与门槛）、review（三类提示与由头、禁用词）、host（记忆写入计分、`cdp.py` 只认非空 `eval`、`goto` 不计分、`review_pending` 不计分）、activity（迁移后三个新 intent 可写入，旧行保留）的用例。
- `npm run test:abs-iteration`：若汇总脚本的 intent 列表需要更新，同步更新并测试。
- 上线前用 shadow 模式观察选中分布，确认代办确实会被选中。
- 实验按协议走 R03：60× 内容窗，`study`、`browse` 各至少 3 条有效样本，`review_pending` 检查是否刷屏。过关线沿用 [scorecard.md](/Users/jinyan/workspace/chonkyFish/docs/abs-iteration/scorecard.md)，并把三类都纳入评分。

## 9. 实现备注（2026-11-26）

以下是实现中做出的具体决定，已与代码和测试对齐：

- **study / browse 同分交替。** 两者共用好奇缺口，分数相同时按上一次学习/逛网站的选择轮换（`lastCuriosityIntent`，来自仓库的 `actionContext` 之外的独立方法）。否则其中一类永远不会被选中。
- **学习写入无每日上限。** 决定于主人。去重键仍然生效，同一内容不重复计分。
- **浏览证据的命令形状。** 仅接受单条命令：`python3 <cdp.py> <ws://127.0.0.1 或 localhost ...> eval "<表达式>"`。管道、`;`、`&&`、命令替换和未闭合引号一律不计。带 `cd … &&` 前缀的命令同样不计，这是有意的保守选择。cdp.py 的位置由 `resources.paths.personalProfile` 与 `PERSONAL_PROFILE_CDP_TOOL`（`spec.js`）拼出。
- **shadow 下代办信号饱和。** 只有 `enqueued` 的代办才会更新 `lastReviewPendingAt`；shadow 只产生 `preview`，因此 shadow 中代办会一直处于饱和状态、每次都被选中。这会让 shadow 的选中分布失去对 study/browse 的参考意义。是否改为把 `preview` 也计入节律，需要主人决定。
- **surfaceAction 拒绝 `continue_interest`。** 旧 intent 不会再被派发，SQLite 的 CHECK 仍保留它，只为迁移历史行。
- **迁移。** `activity_action_selections` 从 v3 重建为 v4，已在生产库副本（258 行）上验证：行数、外键检查均通过。
