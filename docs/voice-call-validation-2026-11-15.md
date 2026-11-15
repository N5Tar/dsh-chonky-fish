# 连续通话 v4 实施与验证记录

本轮实现对应[产品设计 v4](windows-voice-call-design-v4.md)与[技术方案 v3](voice-call-technical-v3.md)。当前是 DSH 插件，桌面端只预留复用端口。软件验证与实物声学资格分开记录。

## 已实现范围

- composer 保持一个按钮，开启持续收音及当前通话的自动播报，关闭停止两路音频；普通 Send 不创建播报连接。
- 新输入不等待旧 turn 或任务结束，unknown 只核对原身份，不自动重发也不冻结下一句。
- 按已消费输入水位播报已提交片段；不等 turn/end、不重播历史或聚合终稿，被插话或撤销的旧响应不续播。
- 通用受管理任务独立入账，保留原 owner、sourceInputId、幂等操作、版本和资源锁；挂断不取消任务。
- 原生 pwsh job 与声明完整 requestId/status/cancel 协议的 MCP 工具接入；其他外部工具须通过显式 adapter/capability 扩展，不冒称已支持所有远端协议。
- 默认扬声器路径保持 AEC/VAD/采样，缺少实际 AEC 音轨、设备变化、采音或租约故障会结束通话。

## 隔离实测环境

Windows，已安装 DSH `0.2.2-rc.1`，独立 profile/DSH_HOME/本地浏览器会话。模型使用临时插件提供的本地确定性 LLM adapter，不访问外部模型账户。真实 DSH 的 agent loop、Session、工具执行、VAD、SenseVoice ASR 与 Windows System.Speech TTS 均保留。

没有向用户主 DSH 通话注入内容、切换主通话或操作游戏，没有修改游戏存档。临时 fixture、profile、认证材料及原始日志在工作区之外，不进入 Git 或插件包。

| 检查 | 实际证据 | 可证明的范围 |
| --- | --- | --- |
| 正在生成时插入 | 原模型设置 15 秒等待；最终复验新输入约 194 ms 得到回复，interrupt/query 都为 applied，pending=0 | 已安装 Host 条件取消与无正文 wake，不需第三条消息；非真实网络模型延时 |
| 真实语音链路 | 生成 WAV 经合成麦克风进入实际 Worklet、Silero、SenseVoice，再经 Session、模型回复、System.Speech、AudioBuffer 播放 | 实际软件链路；两次合成语音输入，不冒称二十轮实际 DSH 通话 |
| 播报中插话 | 合成输入起点到旧播放 source 停止约 270 ms；原片段自然长度 3938 ms，实际仅播放约 281 ms；期间采样继续，通话保持 connected | 单次软件插话回归，不能当作硬件 P95 或真实 AEC 资格 |
| 连续保持采样 | 最后快照仍 connected/listening、1 条 live track；观察到 6 次输出片段 | 隔离页生命周期和持续采样；随后已主动结束该隔离通话 |
| 原生后台任务 | 实际 pwsh 五秒任务运行时，最终复验聊天约 157 ms 返回；任务真正完成后原 owner 收到一次通知，sourceInputId 保持原输入 | 真实工具执行、持久状态、原会话通知；电话范围由 Host lease 建立，媒体链路另测 |
| 停止业务任务 | 实际 pwsh 长任务通过 fish_task_cancel 约 236 ms 标为 cancelled，DSH job 状态 killed | 原生 job 停止；不代表所有远端 MCP 都支持同样取消延时 |
| 挂断不停止任务 | 任务 running 时释放电话 lease，任务仍 running，随后实际 completed | 通话所有权与业务生命周期独立；不向用户主通话做挂断实验 |

合成麦克风使用 Web Audio MediaStream，fixture 的 track settings 明确标记为测试替身的 echoCancellation=true。这不会经过真实麦克风和扬声器的声学回路，不能用来验收 HECATE。

## Review 与修复闭环

每个模块先做需求复核，再做独立质量复核；有实际缺陷就补回归、修复并定向复审。已经关闭的主要问题：

| 问题 | 修复与验证 |
| --- | --- |
| accepted/unknown 等待整个旧 turn | 仅序列化单次 admission，独立输入继续；原身份不重发 |
| 错把 prepare/accepted 当消费证明 | 回复必须有匹配 input.consumed，step 继承已消费水位，后续局部来源不受旧 turn mixed 污染 |
| ASR 或 admission 永不返回 | ASR 从 speech-end 起 30 秒，含断句静音与排队；prepare/submit 30 秒；查证 5 秒；submit 超时只保留 unknown 与原 promise |
| 任务播报抢在用户提交前或晚到恢复 | 门禁覆盖录音、识别、排队、准备和提交；接受新用户输入时抑制冲突中的任务音频 |
| 中断回执丢失、重建后输入卡在 idle | 一次 interrupt、原 ID 有界 query；严格核对 owned pending input 后空 wake |
| 多次开关 follow 记录泄漏、拒绝积累满 512 身份 | stop 完整删除记录/订阅/回调；确定拒绝移出 prepared，只保留有界拒绝 tombstone |
| 永久 pending 的已结束输入无限留存 | proof drain 结束后可裁剪至 64 条，晚到回调不污染新输入 |
| 派发后报错被错判失败并释放资源 | 默认 outcome-unknown；只有可证明未派发或权威终态才释放 |
| 取消等待 RPC、重启丢取消、unknown 无 watcher | 短回取消、持久意图、按原身份恢复 handle/observer，同一取消身份继续核对 |
| 相同进度反复抬高版本、前台历史无界 | 进度去重；事件默认 50 条、最大 100 条，SQLite 也用 LIMIT |
| 任意 MCP 服务借同名读取工具进入前台 | 默认安全读取绑定 stardew/stardew2；其他服务须显式 capability |
| 租约失效但按钮仍开启、续约永不返回 | 故障结束通话；续约在安全期限前开始并有期限，晚到结果不复活通话 |
| 真实 DSH 找不到任务工具 | ctx.jobs 未注入 getter 抛错使安装提前退出；改为安全 ctx.get 优先，并用 throwing getter 回归 |
| 首轮任务错误地无法关联输入 | 只解析真正 user/message 输入，排除 session/title 的 provider/fallback 元数据，仍拒绝跨外部输入借用 owner |
| 已完成任务无通知 | sessions 服务安全读取，兼容实际 Session.sessionId；发送后 flush 才确认 outbox |
| 取消入账的崩溃窗口 | operation、stopping 意图、版本与事件在同一 SQLite 事务提交；trigger 中途失败全部回滚 |
| 自定义外部任务提前标为完成 | Host 启动前解析并持久完成范围；business result 不能覆盖，外部任务保持 watch 与资源锁 |
| 动态外部任务启动回执丢失且已请求取消 | 依持久 scope 恢复原 start 句柄，继续原 cancel；watch 失败后的权威停止确认仍可结算同一取消身份 |

最终独立复审已关闭上述高置信 finding，未发现新的已知未关闭代码问题。审查者只读检查，运行测试和隔离 DSH 的证据由主执行者另行验证；实物资格不包含在代码审查结论中。

## 自动验证

`npm run build`、完整 `npm run test:voice`（核心配置/断句 6 组、服务 54 组、媒体 8 组及全部 DSH/TTS/生成 Client 回归）和 `npm test` 通过。任务服务另由 `npm run test:tasks` 覆盖持久化、操作核对、取消恢复、适配器、电话策略及通知桥。`test:voice:model` 使用实际生成的人声 WAV 验证 Silero ONNX，通过；6 个固定音频资源长度与 SHA-256 核对通过。

`npm pack --dry-run` 验证新核心、SQLite、DSH task adapter、通知桥和音频资源均在包内，未生成或发布 tarball。文档本地链接与代码围栏、`git diff --check` 通过。

全量测试首次暴露 Windows 测试夹具问题，已与实际 Host 装配保持一致：Hello 存储注入 `platform.syncDirectory`；POSIX mode 0600 只在 POSIX 断言，不将 Windows 合成 mode 位视为 ACL 证据。社交页面局部执行夹具补齐 voiceControl，并验证电话 guard 不限制未通话的社交会话。缺少完整 agents API 的 Host 回归会将语音调度能力判为不可用，不能使其他模块异常。

## 设备验收边界

HECATE G1500 BAR 与耳机的实物验收尚未完成。需要各路径至少 100 次起音样本，记录真实起音到停止输出 P95≤300 ms；无人说话仅播放远端声音时误停与误提交为 0；另测设备切换、音量变化和持续通话。当前没有这组证据，所以设备资格保持 `deviceVerified:false`。

浏览器 AEC 是否足够须由上述实物结果决定。当前没有实现 Windows 原生 AEC 回退，不以请求了 echoCancellation、单次合成插话通过或增加阈值冒充完成。
