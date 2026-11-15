# 大肥鱼连续通话技术方案 v3

日期：2026-11-15。产品依据为[通话设计 v4](windows-voice-call-design-v4.md)。本方案取代 v2 中等待 turn 结束投递、turn 结束才播报、扬声器播放期间停止 VAD 的规则。状态为设计修订与独立复审完成、主体改造待实施；已进入代码的仍只有非通话播报入口纠正。修订与复审证据见[自审记录](voice-call-v4-self-review.md)。

## 1. 已核对的宿主事实

当前安装 DSH 版本为 `0.2.2-rc.1`。核对安装包的 `dsh-api-session-controller` 与 `dsh-agent-loop`：

- `request.mode === 'steer'` 调用 `agent.steer(message)`；其余正常排队调用 `followup`。
- `steer` 把输入加入 `next-step` 并请求唤醒 driver，不取消当前调用。运行中且尚未 aborted 时，该唤醒不会设置收尾后的重启标志；`followup` 加入 `next-turn`。
- 一个 step 先等待模型输出，随后等待该批工具执行；之后才进入下一 step。因此 `steer` 对当前正在执行的长工具没有实时抢占保证。
- 现有取消入口调用 `agent.cancel(...,{keepInbox:true})`，会取消当前活动，不代表取消外部已接收的业务任务。它也没有客户端可依赖的 expected-turn 条件参数，不能从 Client 盲目先取消再发送来模拟插入。
- 先 `steer`、后 `cancel(keepInbox:true)` 可使消息保留在 inbox、driver 收尾进入 idle，却不再消费消息。保留 inbox 和可靠继续调度是两个条件，必须同时满足。

核对仓库：文字和语音均用 queue；语音 `deliverNext()` 等 accepted 输入的 `turnEnded`；适配器在 turn/end 才产生合并回复；核心 `outputBlocked()` 又以 active turn 阻止输出。上述四层等待都要分别改造。

## 2. 共享层与 DSH 层分工

| 层 | 职责 | 复用边界 |
| --- | --- | --- |
| 共享通话核心 | 开关、连续输入、输出代次、打断、稳定身份、音频释放 | 无 DSH/DOM/系统私有类型 |
| 共享对话调度 | 用户输入优先、前台响应版本、片段资格、任务关联 | 以端口表达 interject 与安全前台中断 |
| 共享任务模型 | 任务身份、资源所有权、版本、终态与回执 | 不了解游戏地图、浏览器页面或命令语法 |
| DSH 装配与适配器 | Session 目标、steer、事件映射、任务后台执行、条件中断 | 不把 DSH Session 暴露到核心 |
| 共享音频与平台 | AEC/近端检测、播放参考、VAD/ASR、TTS/播放 | Windows 与浏览器实现可替换 |
| DSH UI | 现有 composer 单按钮、正常消息与错误反馈 | 不把内部队列/线程细节放入用户流程 |

未来桌面端替换 ConversationPort、TaskExecutionPort、DuplexCapturePort 的宿主实现，复用领域规则与取消测试。本次不创建桌面空工程。

## 3. 通话授权与生命周期

只有显式点击 Start 才进入 phone-active，取得麦克风并允许新回复播报；End 停止音频输入输出并释放本次通话资源。普通文字发送不调用 `prepareReplyAudio()`、不创建输出连接。通话开启后，文字发送沿用已有订阅，回复照常播报。

业务任务属于对话与资源，不属于通话。End 不等于 task.cancel。Session reset、通话结束、业务取消、前台生成中断各有独立 API 与原因码；普通切页继续遵循应用级控制器生命周期。

## 4. 输入接收与前台抢占

核心新增明确的投递策略 `interject`，DSH 映射为 `steer`。prepare 和 submit 统一采用该策略，保留既有 requestId 接收证据与 unknown 不重发规则。

移除“上一 accepted 输入必须 turnEnded 才能提交下一句”的门禁。串行临界区只覆盖单次身份准备与接收过程；不得持有整个任务或模型 turn。接收结果不明时单独核对该身份，新输入可以继续接收，不能因此冻结全部对话。

模型或网络不可用时仍使用有界预算和明确失败，不构造无限积压。DSH 实际接收和消费顺序是事实；客户端序号用于追踪，不拿本地时间猜测远端已执行或未执行。

前台调度端口的目标形状：

```ts
type InputRef = { inputId: string; clientSequence: number; conversationRef: ConversationRef }
type ForegroundRef = { responseId: string; turnId: string; stepId?: string; revision: string }

admitInput(input: InputRef & { text: string; policy: 'interject' }): Promise<Admission>
interruptForeground(request: {
  interruptionId: string
  expected: ForegroundRef
  acceptedInputId: string
  preserveAcceptedInputs: true
}): Promise<InterruptReceipt>
inspectInterruption(interruptionId: string): Promise<InterruptReceipt>
// status: applied | stale | unsafe | unavailable | outcome-unknown
// applied 必须同时给出旧响应的取消证明，以及输入已消费或已安排可靠唤醒的证明。
```

`interruptForeground` 不是任意 Agent.cancel 的别名。DSH Host 适配器在已鉴权的当前 Session 中原子核对 expected 响应版本、输入接收身份和安全阶段，再请求取消；过期返回 stale。不能核对时返回 unavailable，不进行无条件取消。

该 Host 条件中断入口需要新增，并非当前 Remote 已支持的参数。宿主适配能力必须覆盖“读取活动版本/阶段、条件取消、保留输入、无新增输入的 driver 唤醒”。本机实现存在 `wakeDriver()`，但它不是已承诺稳定的 Remote API：DSH 适配必须限定并验证支持版本与生命周期；缺少任一能力时，在取消之前返回 unavailable。不能通过重复 prompt、发送空消息或重插已消费输入补唤醒，也不把修改 DSH 安装包作为插件交付前提。

新输入应先取得接收证明，再在需要时安全中断旧前台生成，保留已接收输入。模型生成阶段可取消旧响应；有副作用的工具执行阶段按工具能力处理，不能声称已撤销。后台任务的 signal 与前台生成的 signal 独立。

条件中断的调度事务：

1. Host 以 `interruptionId` 记录幂等操作，绑定当前 Agent 实例、expected、acceptedInputId。核对接收证据、inbox claim 与持久化消费、安全阶段；目标输入已被 claim 或已转入新响应则返回 stale，不能取消新响应。当前 DSH 在 preStep 开始就 claim 输入，之后才异步准备工具、提交 user/message 和 step/start；不能只看 phase.step 或等 user/message 才认定新响应开始。缺少 claim 观察证据时禁止抢占。
2. 在同一宿主调度临界区先安装旧 driver 收尾观察与一次性唤醒意图，再取消旧响应；异步收尾期间不持有全局锁。即使同步取消触发事件，也不能遗漏 idle 边界。
3. 旧 driver 收尾后重新核对 Agent 实例和会话权限。若该输入已消费，结束操作；若输入仍 pending 且 driver idle，则无正文、无新身份地唤醒；若已有其他 driver 接管，则由其消费，不再另起并行 driver。
4. applied 只在输入已消费或唤醒意图已交给受监督的宿主调度器后返回，不等待模型完成。一次性意图按 Agent 代次和 interruptionId 去重，重复检查可再次唤醒 idle，但不能重复投递输入。新输入恰好在 abort 后进入、旧响应恰好结束、重复中断请求均须覆盖。
5. RPC 超时或插件卸载后只按原 interruptionId 核对，不能再次无条件 cancel。进程内接管失败要报告 outcome-unknown；Host 重启后依据原输入的 inbox/消费事实恢复调度，不能重发正文。未能证明接管时，不声称已支持前台即时抢占。

## 5. 通用后台任务

```ts
type ConversationOwner = { namespaceId: string; conversationId: string }
type TaskRef = {
  taskId: string
  ownerConversation: ConversationOwner
  sourceInputId: string
  resourceKeys: string[]
  version: number
}

startTask(request: {
  operationId: string
  command: TaskCommand
  context: TaskContext & { ownerConversation: ConversationOwner; sourceInputId: string }
}): Promise<TaskReceipt>
inspectTaskOperation(owner: ConversationOwner, operationId: string): Promise<TaskOperationSnapshot>
listOwnedTasks(owner: ConversationOwner, sourceInputId?: string): Promise<TaskSnapshot[]>
observeTask(ref: TaskRef, cursor?: string): AsyncIterable<TaskEvent>
cancelTask(ref: TaskRef, expectedVersion: number, operationId: string): Promise<CancelReceipt>
inspectTask(ref: TaskRef): Promise<TaskSnapshot>
```

`ConversationOwner` 是持久化归属，不含 runtimeId、bindingRevision、callScopeId 或进程对象。namespaceId 是宿主数据域的稳定标识，DSH 使用当前 profile 的插件数据域标识；conversationId 映射原 Session ID，桌面端可映射自己的会话 ID。通话引用 `ConversationRef` 仍只用于当前通话和在途输入，不复用作任务持久化身份。

任务操作每次通过 owner 解析当前宿主连接并重新检查归属和权限；绑定更新不改写 owner。Session reset 后旧 owner 保持不变，管理工具按 owner 查询其账本和外部适配器；删除、无权限或无法恢复的旧 Session 明确返回对应状态，不把任务改绑新会话。新会话仅可在宿主核对同一所有者权限后显式查询/控制旧任务，旧任务通知不得自动播入新会话。

通用状态：accepted、running、stopping、completed、failed、cancelled、outcome-unknown。accepted 表示宿主已持久化接收任务，不等于外部操作已经启动。取消接收与取消完成不是同一事实；需要按适配器回执保留部分结果。

启动协议与持久化：

1. 受管理工具网关在任何外部派发前生成并持久化 operationId，记录其来源工具调用身份、owner、sourceInputId、规范化命令摘要、资源和 taskId；提交失败则不执行。重试/重连从该记录取原 operationId，不在每次 HTTP 或模型重试时重新生成。不同命令不能复用同一身份；新的模型调用若指向未决任务，先查询既有任务，不据“失败/超时”自动另起同一操作。
2. 任务账本对 `(owner, operationId)` 唯一约束，同身份同命令返回既有回执；同身份不同命令拒绝。taskId 与操作记录在一个事务中落盘，之后才能派发。回执丢失时用 inspectTaskOperation 或按 owner/sourceInputId 查找，不能把“没收到回执”解释成“没启动”。
3. 外部支持幂等键时透传原键；已异步任务记录其外部句柄。仅有非幂等阻塞接口时也先写派发意图；进程在外部接收与回执落盘之间退出，恢复为 outcome-unknown，只查询/核对，不自动重放。只有权威证明 not-applied 后才允许原操作继续派发；不能凭本地超时或账本缺少外部句柄推断 not-applied。
4. 账本持久化任务、启动/取消操作、版本、外部句柄、资源占用和最后观察游标；重启先恢复账本与资源占用，再开放新写操作。adapter 无恢复能力则保留 unknown 与查询入口，不伪装为 running 或 cancelled。取消 operationId 同样幂等，重复请求不重复推进版本。
5. 资源键在 namespace 内标识真实写入目标，跨会话也互斥；多个资源按统一顺序一次取得所需集合，不能每个会话各锁一份。租约过期只撤销旧执行者的本地调度权，不证明外部操作已停；stopping/outcome-unknown 的冲突资源保持隔离，直到权威终态/未执行证明允许交接。适配器不能约束已发外部命令时，明确保留其不确定性。

实施方式：

1. 给前台模型提供受管理的任务入口和短状态查询。能力声明与路由约束阻止它退回前台长轮询；提示词只是补充，不作为唯一保证。
2. 已异步接口直接托管其原始任务句柄。阻塞接口在后台执行上下文中运行，前台只等待接收回执，避免“双重启动”。
3. 终端任务可复用 DSH Jobs 的生命周期；其他 MCP、浏览器与工具需各自接入托管执行能力，不把“存在 job 工具”当作它已能管理任意 MCP 任务。
4. 状态订阅或受控后台轮询观察外部事实，进展合并去重，用户输入优先于通知。完成结果回到所属对话，不能抢占当前用户话语。
5. 工具上下文由宿主附加 taskId、版本、来源输入和资源；模型文本不能伪造这些权限与版本。
6. 同资源的写操作按租约执行。明确的停止、换目标推进任务/资源意图版本；派发前核对版本，迟到且尚未派发的旧请求不得启动。已经进入外部系统的命令按真实取消能力结算，不能承诺本地版本能撤回外部副作用。闲聊不会推进业务取消版本。
7. 重置后旧任务仍可在原所属对话查询；退出时按适配器能力取消或持久化恢复。不能把一条已经入游戏/浏览器/外部服务的命令当作杀掉模型就取消了。

阻塞且不支持取消的工具也必须离开前台；取消请求记录其限制和实际状态，不返回虚假的 cancelled。

当前 DSH Jobs 的默认工具提示要求最终回答前收集相关作业结果，可能诱导前台继续 `job_output(wait:true)`。接入时要同时调整通话前台的任务使用策略和受管理工具能力：允许报告“已接收、正在执行”后恢复对话，由后台管理完成结果与通知；不能只挂上 Jobs、保留长等待入口及原提示就声称已解耦。

## 6. 回复片段模型

由适配器把已提交的 `assistant/message` 文本映射为片段，不再等待 turn/end。草稿、思考、工具调用块和工具原始输出不直接播报。

```ts
type ReplySegment = {
  segmentId: string
  conversationRef: ConversationRef
  callScopeId: string
  foreground: ForegroundRef
  forDialogueRevision: string
  surfaceRevision: string
  text: string
  source: 'local-dialogue' | 'owned-task-notice'
}
```

关键规则：

- 同一 DSH turn 可以包含多次 steer 输入，不能再用 turnId 作为唯一回复归属。按 step/已消费输入的水位建立 forDialogueRevision，不按“收到片段时最新的输入”倒填旧模型响应。
- 播放资格由当前通话、响应版本、输入水位、片段修订和来源确定，不由“整个 Agent 空闲”确定。后台任务仍 running 不阻止当前对话回答被播报。
- 播放前以及合成完成、入队、音源启动时都要检查第 7 节的输入尝试门禁和输出代次。片段不能在到达时被重新贴成当前 outputEpoch 来绕过打断；同一被打断响应后续新增的片段也不能恢复资格。
- 相同片段身份去重；替换表面撤销未播片段，已失效响应不能迟到播出。基线和历史消息不播。
- 自有任务通知只有在所属对话、权限与对应来源已核对后才能参与当前响应；外部社交输入仍不能串入主通话。不能把一个 turn 混有任务回执就整轮禁播，也不能据此开放所有外部来源。

## 7. 音频打断与回声处理

通话采样、回声处理和近端检测持续运行，TTS 不再 gate 掉整条 VAD 输入。

```ts
type NearEndEvent = { type: 'near-end-start'; capturedAt: number; confidence: number }
pushRenderReference(frame: AudioFrame, renderTimestamp: number): void
processCapture(frame: AudioFrame): { cleaned: AudioFrame; nearEnd?: NearEndEvent }
```

该端口描述目标能力，不表示现有浏览器 VAD 已具备回声分离。先验证实际 Track settings 和本机设备；若浏览器链路无法满足验收，Windows 共享实现提供渲染参考、时间对齐与 AEC。硬件/输出设备切换后重新建立参考与能力状态，不沿用旧校准。

W3C 对 `echoCancellation:true` 的定义允许用户代理决定移除哪些声音，不能由请求参数推出效果已经满足双讲。WebRTC AEC3 接口分别接收 AnalyzeRender 与 ProcessCapture；使用参考音频时须处理采样、时钟、播放延迟与音量变化，而不是用 TTS 文本去删相似识别结果。

- 参考：[W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)。
- 参考：[WebRTC AEC3 接口](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/aec3/echo_canceller3.h)。

确认用户近端说话后立刻推进 outputEpoch、stop 当前音源、取消合成与未播队列；捕获预录约 300 ms，识别后继续 interject。没有最终有效文本时不恢复被打断的旧句，不自动取消任务。

近端检测到输入与最终识别成功之间有独立状态，不能只靠 outputEpoch：

| 输入尝试状态 | 输出和收尾规则 |
| --- | --- |
| collecting | 创建绑定 call generation 的 utteranceAttemptId 和采样顺序；立即关闭普通回复与任务通知的播放门禁，记录被打断响应身份及输入水位；持续近端检测和采音，不 gate 麦克风 |
| resolving | speech-end 后按原 attempt 识别；仍关闭播放门禁。用户又开口时创建新 attempt，旧回调只能结算自己的 attempt |
| transcribed | 有效全文移交有稳定 inputId 的输入账本，结束本次采集/识别门禁；接收状态另行跟踪 submitting/accepted/rejected/unknown。只允许宿主已证明消费了新输入的响应播报，仍有 collecting/resolving attempt 时继续禁止播放 |
| no-speech / failed / timed-out | 不提交正文，不取消任务，不回退输出代次，不恢复旧响应或其后续片段；清理本 attempt，结束等待，保持通话。确认无语音时静默收尾；识别失败或超时通过现有聊天反馈“本句未发送，请重说”，不在用户讲话期间播错误提示 |
| abandoned | 挂断/reset/卸载撤销所属 attempt 的提交和播放资格；已进入提交的输入仍按原身份核对。迟到 ASR、错误及超时回调不能关闭新通话或其他 attempt 的门禁 |

门禁从所有 collecting/resolving attempt 计算，不能用一个布尔值由任意 ASR 回调解除。转写完成顺序不等于语音顺序；成功输入沿采样顺序提交，失败项明确结算后不再阻塞后项。文字发送也推进回复版本；其实际接收/消费顺序仍以宿主证据为准，不因迟到 ASR 把旧响应改归新输入。转写成功后的提交超时属于接收 unknown，只提示“接收结果待核对”，保留原身份，不谎称未发送；它不持有语音 attempt 门禁，也不阻塞后续新输入，回复仍须有真实消费证据。

继承现有 90 秒单轮、8 个未解决输入、180 秒原始音频和单个 ASR RPC 30 秒预算；另设 speech-end 起 30 秒的整句自动识别收尾期限，包含本地排队，与每 RPC 执行超时分开。超出则该 attempt timed-out，未提交内容不再自动发出；取消识别并过滤晚到结果。单按钮电话模式不保留需要额外面板操作的 held 音频：已确认从未提交的 no-speech/识别失败/超时尝试在反馈后释放音频和未解决输入名额，仅留有界身份与错误元数据；用户重说产生新输入，不自动重试原音频。已开始提交的 unknown 不适用该释放推断，保留原接收身份并核对，不能声称未发送。

采样中断走现有 2 秒 watchdog，不能因缺少 speech-end 永久锁住输出；达到单轮上限正常 seal。真正的预算耗尽、采样故障或设备不可用不进入隐藏的“已连接但暂停采音”状态：明确终止本次通话并恢复按钮关闭状态，在原聊天显示原因，已有提交按原身份核对，业务任务继续；用户仍用同一按钮重新开启。已确定未提交的本地内容终止并释放，必须提示其未发送；不能把释放本地音频当作撤回在途请求。上述预算属于共享配置/限制，不在 DSH UI 写死另一套值。

没有待决 attempt 后只开放新输入响应及重新核对的自有任务通知。被打断响应 ID 与该输入水位的普通后续片段保持失效，直到新的用户输入产生新响应；不自动恢复旧句。待决期间任务事实照常入账和显示，通知仅保留有界的最新状态；恢复后重新检查 owner、版本和未通知事实再形成新通知，不能重放被丢弃的音频队列。

耳机路径与扬声器路径共用中断语义。HECATE 扬声器必须实际验证双讲与回声误提交，不能沿用“耳机插话已通过”的旧验收结论。

实施时同步更新能力声明和配置校验。当前 `validateVoiceConfig()` 明确拒绝 speaker-duplex；不能只解除拒绝或把扬声器伪装成 headphones。旧 speaker-turn-taking 配置迁移后，应先核对新近端检测链路与设备能力；不具备能力时明确报告未满足，不静默关闭插话能力。

## 8. 身份、版本与取消范围

| 身份/版本 | 作用 |
| --- | --- |
| callScopeId / call generation | 挂断、重开、重置后阻止旧音频或旧提交串入新通话 |
| inputId / clientSequence / dialogue revision | 稳定接收证明、追踪消费、按 step 标注回复来源 |
| outputEpoch / segment revision | 用户开口即废弃旧音源、迟到合成及重复片段 |
| utteranceAttemptId / pending attempts | 用户说话及 ASR 待决期间保持输出关闭，迟到回调只结算自身尝试 |
| ConversationOwner / operationId / taskId / task version / resource lease | 稳定任务归属、幂等派发、取消与安全资源交接 |

停止声音不等于取消模型；取消前台生成不等于取消业务；挂断不等于停止任务。具体动作只取消其所属范围，错误和结果未知按该范围保留。

## 9. 实施拆分与验收门槛

1. 撤回普通文字自动开启输出，锁定电话式开关语义。
2. 统一 interject/steer，调整接收门禁并保留未知结果身份；用当前 DSH 的长前台 step 验证 next-step 与安全中断行为。
3. 通用后台任务与资源控制接入，不针对锄地写分支；用至少一种本机长任务和一种异步外部工具验证“执行中持续聊天”。
4. 回复改为已提交片段，验证同 turn 多次输入、工具仍执行时播报、表面替换与旧响应抑制。
5. 耳机、HECATE 扬声器分别接入持续近端检测、回声处理与本地停播，完成 v4 的连续插话统计。
6. 重置、迟到接收、完成与取消同时发生、后台任务恢复和无协作取消等故障回归。

新增必须通过的协议用例：

- steer 已接收后取消旧生成，无第三条消息也能消费新输入；中断重复请求、RPC 超时、abort 后新输入与自然收尾竞态不产生重复输入或并行 driver。加入“目标输入已 claim、step/start 尚未出现”的窗口，确认不取消这次新输入。必须先在当前安装版本证明条件中断和无正文唤醒可由插件 Host 使用，失败则本阶段不通过。
- 同一个任务在绑定变更、插件重载、Host 重启后仍按稳定 owner 查询；Session reset 后新通话不接收旧通知，授权管理入口仍可检查旧任务。
- 外部已接收但启动回执丢失、派发前/后崩溃、重复启动/取消请求，只产生一份可证明的外部操作；无幂等/查询能力时应保留 unknown，不靠再次启动让测试成功。unknown 资源不能因租约到期让冲突任务进入。
- speech-start 后旧响应新增片段、任务完成、ASR 无 final、no-speech、30 秒收尾超时、多次起音和乱序回调，均不在用户讲话时重新出声；失败收尾后能接收下一句，不自动续旧句，旧 ASR 不晚发。

如果 2 通过而 3 未通过，只能报告“支持下一步插入”，不能报告“任意长任务中随时响应”；如果 5 仅耳机通过，不能报告“HECATE 电话模式已完成”。
