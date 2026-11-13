# Hello 首次使用引导实现记录

日期：2026-11-13。基线：2f66d58。功能分支：feat/hello-onboarding。

## 范围与最新决定

- Hello 是独立核心模块及独立 UI，不引入第二套 Agent Loop。
- 人格完全沿用静态主预设与现有 state.prompt 补充机制。新手预设取 DEFAULT_PANEL_PROMPT；默认文本保持原静态人格，自定义新手文本通过原 supplement 生效。
- 不新增人格 provider 或人格文件；已有非空 prompt 只读保留。以后的人格修改仍在原人格页面完成。
- 无主动互动开关；ABS 仅写 timeScale/restHours，不改变 mode。
- 钉钉为可选后续入口，复用既有社交页面；连接、配对不当作真实收发验证。

## 实现

- core/modules/hello：校验、草稿、来源快照、提交日志、恢复、放弃未决操作。
- app/shared/storage/hello：私有权限、文件/目录同步、原子 rename、revision CAS、损坏文件拒绝覆盖。
- app/dsh/adapters/hello：独立 HTTP；同源、JSON、体积及字段白名单；无凭据或任意代理接口。
- app/dsh/host：现有 state 共用队列内 generation 比较；Hello 只合并名称和空人格字段，保留钱包等无关内容。
- app/shared/resources：所有配置写操作共用串行队列；Hello 使用配置摘要 CAS。
- core/modules/perception/service：内部条件控制入口在同步阶段比较并保留控制版本，防止其他页面的最新选择被旧引导覆盖。Host 为版本加入启动 epoch。
- app/dsh/ui/hello：欢迎、人格、感知明确选择、ABS、审阅、完成；可退出聊天；部分失败按步骤展示，可恢复或放弃后重新审阅。构建器生成 client.js。

## 真实边界

跨文件配置和采集进程不是原子事务。已成功的步骤不会自动回滚。结果未知时不猜测归属或自动重放；用户可以保留已保存结果并重新审阅当前配置。放弃仅更新引导日志，不撤销业务设置。

感知意图与实际状态分别读取；开启意图已保存但采集未运行不报告完成。没有采集能力时可以明确选择关闭继续。ABS 服务未就绪/缺失不会伪报生效。

Hello 日志不导入 fishpack；人格仍在原 state.json，所以沿用现有迁移路径。操作 ID 日志目前最多 128 条，达到上限明确拒绝新提交，不静默删除幂等记录。

## 验证

测试命令：
- npm test（包含新增 test:hello）
- node app/dsh/build.mjs
- node --check client.js
- git diff --check

新增测试涵盖：草稿 CAS、重复 ID、已有人格保护、完整 Host 人格实际读取链路、旧 state 并发冲突、配置合并、ABS mode 不变、部分失败/unknown/放弃、感知 journal 期间的 ABA 并发、关闭生命周期、损坏仓储、HTTP 同源/白名单、UI 草稿与导航。

测试使用临时 home、mock 宿主及采集器，不连接真实钉钉，不启动用户真实采集器。

**未完成实机验收：**云浏览器不能访问命令环境的预览端口（ERR_CONNECTION_REFUSED）；命令环境 Chromium 也因 socket 权限被阻止启动，因此没有成功的浏览器视觉验收。客户端 mock 挂载测试不等同于完整 DSH GUI 测试。macOS 原生采集及钉钉真实收发也未验证。
