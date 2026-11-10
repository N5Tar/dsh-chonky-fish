# 活动感知 V1

大肥鱼插件内的独立业务模块：复用现有宿主运行时、资源路径、HTTP 路由与 GUI。只增加一个 macOS 原生采集器进程，不新增 Node 服务或端口。注册只读 Agent 工具供大肥鱼按需查询，不主动唤醒或替模型决定行为。

## 运行

- 安装插件时携带模块与对应架构的原生二进制。
- 插件初始化时打开 SQLite、执行过期清理并注册查询工具；**不会自动采集**。
- 在 ABS 实验台的“主人状态”区域显式开始后，每 5 秒读取前台应用与闲置时间，每 30 秒分析。
- 暂停/停止终止采集器，但保留自动清理；插件 dispose 时释放进程、定时器和数据库。
- Windows 当前明确 unsupported，模块故障不阻止其他插件功能。

## 数据与隐私

数据位于插件资源目录的 `perception/activity.db`。仅 samples 和 summaries 两张表；当前状态在内存，不跨插件重启恢复为实时状态。

- 原始数据默认保留 1 小时。
- 摘要默认保留 7 天。
- 每 5 分钟清理，初始化时补清理，查询同时过滤过期数据。
- 不采截图、窗口标题、网页地址、键盘内容、剪贴板或命令行。
- 采集与分析在本地完成；大肥鱼调用查询工具时，精简的当前预测作为工具结果进入模型上下文，不包含原始采样、应用明细和历史。不根据后台进程运行推断人在忙。
- 无键鼠输入不等于离开。终端不能单独证明开发；浏览器不能说明具体页面活动。
- 锁屏检测当前可降级为 unknown，不将无输入伪装成锁屏。

插件配置 `perception` 支持 enabled、rawTtlMs、summaryTtlMs。TTL 在模块初始化时加载，修改后需重新加载插件；enabled 动态检查，关闭后拒绝新采样。界面不提供规则修改、人工标注、反馈或重算。

## 0.4.3 修复说明（2026-11-10）

- 原生采集改为真正主线程上的 AppKit RunLoop + Timer，避免 NSWorkspace 前台应用停留在进程启动时的缓存。双屏仍只记录拥有输入焦点的应用，不枚举所有可见窗口。
- 单调时钟与整数毫秒墙钟的 2ms 内量化差异对齐到采样边界，不再制造亚毫秒伪缺口；真实中断不被填补。
- 规则版本为 `activity-v1.1`。独立 Codex 的实际 Bundle ID `com.openai.codex` 已加入开发工具映射；终端内 CLI 仍只识别为终端，不读取命令行。
- 新一轮当前分析仅使用本轮 runId，旧记录保留至正常过期，不污染修复后的判断。旧版摘要在页面标为待核实，原始时间轴含前轮记录时明确提示。
- 状态接口提供 analysisVersion 和 observationScope，便于确认实际加载版本。

## 开发与验证

```sh
npm run build:perception
node build.mjs
npm run test:perception
node src/perception/tests/run-soak.mjs
npm test
```

原生构建环境与可用开关见 native 目录说明。用户安装已构建插件不应需要 Swift 编译器。Node SQLite 通过动态 import 注入，仅感知模块失败时降级；开发验证已确认当前桌面宿主同一 Electron 可执行文件支持 node:sqlite，但不能据此宣称支持全部历史宿主版本。

测试默认使用合成采样，不读取真实桌面活动。run-soak 使用真实临时磁盘 SQLite 和加速时钟模拟 90 分钟，不是 90 分钟真实桌面监测。

真实前台切换不能仅靠合成测试验收。需要用户知情时显式运行 `npm run test:perception:live -- --observe=120`，手动切换应用并各停留至少10秒。此命令做采样前后独立系统查询，不激活窗口、不写入用户数据库；没有观察到切换时退出2并标为不确定，不算通过。

## 接口

复用 `/chonkyfish/perception`：

- GET `?action=status|current|timeline|summaries`
- timeline 支持 fromMs/toMs，最多 1 小时。
- summaries 支持 fromMs/toMs/cursor/limit；默认 120、最多 500，cursor 为上一页 nextCursor。
- POST JSON `{ "action": "start" | "pause" | "stop" }`

沿用宿主访问控制，不增加私有 token。控制请求验证 JSON 和明确跨站来源。当前结果动态检查样本和分析新鲜度，暂停、停止、陈旧来源不能冒充实时状态。

## 大肥鱼查询工具

`perception_get_owner_state({})` 随插件初始化注册，无需单独安装。仅对 `chonkyfish` preset 且位于专用鱼塘工作区的主人会话开放；社交隔离会话与子代理不开放。执行时再次验证身份。

- 未开始或配置禁用：`status: "not_enabled"`、`prediction: null`，明确提示“未开启”。工具仍可见，不自动启动采集。
- 暂停、初始化、观察不足、过期、不支持、异常分别返回明确状态，绝不回退到历史预测。
- 有效结果：`status: "ready"`，prediction 包括 activity、label、interaction、confidence、continuity、analyzedAt/sourceThrough（毫秒时间戳）。内部 development 映射为对外 work / 工作。
- 工具只查询当前服务，不执行开始、分析、重算或模型调用；结果不是允许打扰主人的授权。
- 插件卸载时注销工具；重新初始化时重新注册。模型输出中的工具结果遵循宿主通常的会话历史机制，不是临时 ABS 注入。

## 发布注意

构建客户端不代表运行中的插件宿主已重载。没有同 checkout 的 dev:web watcher 时不能承诺自动刷新；需要按宿主正常插件重新加载流程并刷新既有 GUI 验证。不要启动替代 Web 服务，也不要在运行中的开发会话里未经安排重启整个宿主。
