# 连续语音通话 v4 实施计划

> **For agentic workers:** 使用 superpowers:subagent-driven-development；按任务实施、核对需求、审查代码，发现问题先修复再继续。用户已要求执行，不在任务之间重复请求确认。

**Goal:** DSH 电话开启后持续收音、自动发送与播报，长任务不阻塞聊天，用户可以打断播报；共享核心可用于未来桌面端。

**Architecture:** 共享语音核心管理输入尝试、接收与输出资格；DSH 适配器负责 steer、条件取消、可靠唤醒与已提交片段。后台任务使用独立持久化归属、幂等操作账本和资源隔离。Web 采集保持 AEC/VAD 活动，设备能力与实机证据分别记录。

**Tech Stack:** ESM JavaScript、Node assert 测试、Cordis/DSH Host、Web Audio/AudioWorklet、现有 Silero VAD/DSH ASR/Windows TTS。

**Scope:** 依据 docs/windows-voice-call-design-v4.md、docs/voice-call-technical-v3.md。保留唯一 composer 开关；不创建桌面应用或游戏特例；不更改游戏存档。当前分支 codex/voice-concurrent-calls；用户随后要求先提交未提交改动，已保存 2406c21 与 8e6b2f1 两个本地检查点；后续修复单独提交。

## 1. 基线与宿主调度能力

**Files:** app/dsh/adapters/voice/foreground.js（新）、其 tests/run-foreground.mjs（新）；app/dsh/adapters/voice/http.js、app/dsh/host/index.js。

- [x] 建立实施分支并读取当前实现和已复审设计。
- [x] 运行 `npm run test:voice`，记录基线。
- [x] 先写回归：steer 后 cancel 不依赖第三条消息；已 claim 且未 step/start 时不能取消；重复中断/旧 expected/超时不重投正文。
- [x] 运行回归，确认旧实现不能满足；实现版本/能力限定的 Host 调度器。
- [x] 接口使用 `interrupt({interruptionId, expected, acceptedInputId})` 与 `inspect(interruptionId)`；取消前装收尾观察，无正文 wake；缺能力不取消。
- [x] Host 路由沿用 connection.requestRejection，验证会话所有权和原输入证明；模型生成阶段与工具阶段分开。
- [x] 运行 `node app/dsh/adapters/voice/tests/run-foreground.mjs` 和 HTTP 回归，通过后做需求、质量审查。

## 2. 插入输入与已提交回复片段

**Files:** app/dsh/adapters/voice/conversation.js、app/dsh/build.mjs、对应会话与发送测试。

- [x] 测试先断言 prepare/prompt 和普通文字均使用 steer，稳定 requestId 不变。
- [x] 测试 assistant/message 在 turn/end 前产生 `reply.segment`，包含稳定 replyId、responseId/step、inputIds、来源、表面修订；历史和撤销片段不可播。
- [x] 实现同 step 消费水位，不能用 turnId 或最新收到输入冒充响应归属；自然完成与安全抢占竞态保持身份。
- [x] 连接前台条件中断；在支持能力范围内发出原身份中断请求，不使用无条件 Remote cancel。
- [x] 运行 `node app/dsh/adapters/voice/tests/run-conversation.mjs`、发送策略和生成产物测试，再审查。

## 3. 核心持续输入与音频输出门禁

**Files:** core/modules/voice/service.js、limits.js、config.js、tests/run-service.mjs；app/shared/audio/web/capture.js 与媒体测试；app/dsh/client/voice/bootstrap.js。

- [x] 测试先覆盖 accepted 未 turnEnded 时下一句仍发送；unknown 只核对自己，不冻结之后输入。
- [x] 测试 `reply.segment` 不等待 turn/end；speech-start 到 ASR 结算期间，新片段/任务通知不出声；被打断旧响应不能续播。
- [x] 为输入尝试创建独立身份和 30 秒整句识别收尾期限；unknown admission 不持有语音门禁，乱序回调不解锁新输入。
- [x] 失败且从未提交的识别释放音频/名额；故障/真实预算耗尽结束通话并让按钮 off，在途输入仍核对。
- [x] 取消播放时保持采样/AEC/VAD；记录 Track settings/输出参考能力，不把请求 echoCancellation 当作扬声器验收。
- [x] 更新配置迁移与能力检查；仅在通过实际链路能力检查后运行 speaker-duplex，保留耳机路径。
- [x] 运行核心与媒体测试，核对没有任何非通话自动输出入口，再审查。

## 4. 持久化后台任务与工具接入

**Files:** core/modules/tasks/（新）、app/shared/storage/tasks/（新）、app/dsh/adapters/tasks/（新）、Host 装配与受管理工具。

- [x] 先测稳定 owner、启动回执丢失、重复启动/取消、崩溃恢复、未知资源隔离、跨会话归属。
- [x] 网关在派发前持久化 `{operationId, taskId, owner, sourceInputId, resourceKeys, commandDigest, version, state}`；同键不同命令拒绝。
- [x] 实现 `startTask/inspectTaskOperation/listOwnedTasks/observeTask/cancelTask/inspectTask`，unknown 不重放、租约到期不等于外部已停止。
- [x] 接入通用阻塞工具后台上下文、原生异步句柄和短查询；长等待工具不能在前台重新暴露，用户输入优先。
- [x] 实现 owner 核对的完成通知；通话结束不取消任务，reset 后旧任务不自动播进新会话。
- [x] 用本机长任务和异步工具适配验证任务执行中多次对话/停止；实际外部不支持取消时据实反馈。
- [x] 运行任务/工具/恢复回归并审查。

## 5. 集成与交付验收

**Files:** package.json、core/modules/voice/CONTRACT.md、docs/voice-call-implementation-guide.md、docs/voice-call-validation-2026-11-15.md（新）。

- [x] 完整 `npm run test:voice`、任务测试、resources/platform 和受影响 Host 测试。
- [x] `npm run build`、生成产物回归、`git diff --check`；核对发布包含新模块。
- [x] 独立需求审查后做代码质量审查，修复并复审到无已知未关闭问题。
- [x] 在隔离测试会话验证已安装 DSH 的调度能力与真实长任务，不向用户主通话注入测试内容，不修改游戏存档。
- [ ] 耳机与 HECATE 分别记录真实双讲、无人声回放误触发及起音到停播 P95；每路径至少 100 次尝试。没有实测证据的设备能力保持未验收，不宣称全功能完成。
- [x] 更新实际验证记录、剩余限制和迁移说明，向用户交付可审查结果。
