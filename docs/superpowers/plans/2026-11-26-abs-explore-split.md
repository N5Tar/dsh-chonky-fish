# ABS 探索拆分（R03）实现计划

> 设计见 [2026-11-26-abs-explore-split-design.md](../specs/2026-11-26-abs-explore-split-design.md)。  
> 每步先写失败的测试，再写实现。不 commit，除非主人明确要求。

**目标：** 把 `continue_interest` 拆为 `review_pending`、`study`、`browse`；删除整理；补齐计分、由头与存储迁移。

## 任务

### 任务 1：配置与选择器

**文件：** [config.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/config.js)、[selector.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/selector.js)、[run-selector.mjs](/Users/jinyan/workspace/chonkyFish/core/modules/abs/tests/run-selector.mjs)

1. 测试（失败）：
   - `study`、`browse` 的分数为 `explorationScoreFactor × curiosityGap`，门槛为 `minimumGap`。
   - `review_pending` 的信号为 `min(1, h / 24)`，门槛为 `reviewMinGap`（默认 0.5），分数等于信号。
   - 从未回看过时信号饱和为 1，可以立即选中。
   - `reviewMinGap` 非法值回落默认 0.5。
2. 实现：
   - [selector.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/selector.js) 的 `ABS_ACTION_POLICY` 常量增加 `reviewMinGap: 0.5`，`resolvePolicy` 同步校验。
   - `actionPolicy.reviewMinGap` 在 [config.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/config.js) 中校验。
   - 选择器接收 `lastReviewPendingAt`，计算 `s`。
   - `PRIORITY` 增加三类，移除 `continue_interest`。

### 任务 2：提示与由头

**文件：** [review.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/review.js)、[run-review.mjs](/Users/jinyan/workspace/chonkyFish/core/modules/abs/tests/run-review.mjs)

1. 测试（失败）：三类提示均为第一人称、不含禁用词；`buildChatHook` 接受近 6 小时内 `activity === 'browse'` 的结果；`explore_content_found` 分支行为不变。
2. 实现：`renderActionPrompt` 增加 `review_pending`、`study`、`browse` 分支；删除 `continue_interest` 分支（历史提示不会被重新渲染）；改 `buildChatHook` 的判断。
3. 同步改 [run-review.mjs](/Users/jinyan/workspace/chonkyFish/core/modules/abs/tests/run-review.mjs) 第 66–67 行的旧用例。

### 任务 3：存储迁移与仓库方法

**文件：** [sqlite.js](/Users/jinyan/workspace/chonkyFish/app/shared/storage/abs/sqlite.js)、[service.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/service.js)、[run-activity.mjs](/Users/jinyan/workspace/chonkyFish/core/modules/abs/tests/run-activity.mjs)

1. 测试（失败）：
   - 旧库（CHECK 只含三个旧值）迁移后可写入三个新 intent，旧行保留。
   - `lastReviewPendingAt()` 只返回派发为 `enqueued` 的 `review_pending`。
2. 实现：表重建迁移；`ACTION_INTENTS` 更新（第 8 行）；新增仓库方法并加入 [service.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/service.js) 第 23 行的必需列表。
3. 同步改 [run-activity.mjs](/Users/jinyan/workspace/chonkyFish/core/modules/abs/tests/run-activity.mjs) 第 102、110 行。

### 任务 4：计分

**文件：** [host.js](/Users/jinyan/workspace/chonkyFish/app/dsh/adapters/abs/host.js)、[store.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/store.js)、[run-host.mjs](/Users/jinyan/workspace/chonkyFish/core/modules/abs/tests/run-host.mjs)

1. 测试（失败）：
   - `write` 到记忆目录计分；ABS 状态目录仍不计分。
   - 记忆写入不设每日上限（已取消，见 spec 第 9 节）。
   - `cdp.py eval` 成功且输出非空计为 `local_content_found`；`goto` 不计；失败或空输出不计；其它 bash 不计。
   - `browse` 验证器位于 `path` 门控之前，无 `path` 的 bash 回执也能计分（真实 bash 回执的 `meta` 为空，见会话日志）。
   - `review_pending` 的工具调用不计分（用 `turn.action.intent` 判断）。
2. 实现：扩展允许根（加 `resources.paths.memory`）；`cdp.py` 验证器（路径用 `resources.paths.personalProfile`，不写死）；`review_pending` 豁免计分。
3. 同步改 [run-service.mjs](/Users/jinyan/workspace/chonkyFish/core/modules/abs/tests/run-service.mjs) 第 142 行。

### 任务 5：面板与文档

**文件：** [activity-panel.js](/Users/jinyan/workspace/chonkyFish/app/dsh/ui/abs/activity-panel.js)、[README.md](/Users/jinyan/workspace/chonkyFish/core/modules/abs/README.md)、[scorecard.md](/Users/jinyan/workspace/chonkyFish/docs/abs-iteration/scorecard.md)

1. 面板第 7 行新增三类中文名，历史 `continue_interest` 显示为「旧探索」。
2. README 更新计分表、intent 列表与代办信号。
3. scorecard 纳入三类。
4. 运行 `npm run build`，确认生成的 `client.js` 已更新（不手改）。

### 任务 6：残留引用检查

- `rg -n "continue_interest"` 确认只剩：历史兼容（SQLite 旧行、面板「旧探索」映射）、`scripts/abs-iteration` 的汇总测试数据、以及文档中的历史记录。
- [selector.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/selector.js) 第 12、61–62 行、[review.js](/Users/jinyan/workspace/chonkyFish/core/modules/abs/review.js) 第 82 行、[run-selector.mjs](/Users/jinyan/workspace/chonkyFish/core/modules/abs/tests/run-selector.mjs) 第 23 行必须已改完。

### 任务 7：验证与 R03 实验

1. 运行 `npm run test:abs`，若改动汇总脚本则运行 `npm run test:abs-iteration`。
2. 运行 `npm run build`。
3. 重启 DeepSeek Harness 加载新 Host。
4. shadow 模式观察选中分布，确认代办能被选中。
5. 切 active，60× 内容窗，按协议记 `cycles/2026-11-26-R03.md`，窗末收束。
6. 收束后还原 `timeScale` 为 1，禁用巡检。

## 不做

- 新建浏览器工具。
- ABS 解析记忆内容。
- ABS 触发发帖、回复、留言。
- 改 `chat_owner` 社交计分。
- 扩大权限。
