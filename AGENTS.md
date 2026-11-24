# AGENTS.md · ChonkyFish（大肥鱼）

给在本仓库工作的 Agent 用的操作约定。产品文档见 [README.md](README.md)；目录与依赖边界见 [docs/architecture-refactoring-design-v1.md](docs/architecture-refactoring-design-v1.md)。

## 这是什么

- **当前可交付形态**：DeepSeek Harness（DSH）**插件**（侧栏「大肥鱼」面板 + `chonkyfish` agent preset）。不是独立 Web 服务；跑起来依赖本机已装好并配好模型的 **DeepSeek Harness**。
- **产品方向**：同一套业务核心，未来还有 **macOS / Windows 桌面端**。目录归属已按多 APP 设计好；桌面壳未开工前，日常改动仍以 DSH 插件可运行为准。
- **数据根（DSH 插件）**：`$DSH_HOME/chonkyfish/`（默认 `~/.dsh/chonkyfish/`）。

## 怎么跑（当前：DSH 插件）

1. **依赖**：Node 能跑本包脚本；DSH 桌面版（0.2.1 系列）已装好；本仓通常以 `link:` 挂在 `~/.dsh/profiles/desktop/node_modules/@local/chonkyfish-dashboard`。
2. **改 DSH Client 后必须构建**（生成根目录 `client.js`）：

   ```bash
   npm run build
   # 等价：node app/dsh/build.mjs
   ```

3. **装 / 更新插件**（在 DSH 里，Creator / Full access）：

   ```text
   plugin_manager({ action: "install_bundle", target: "/absolute/path/to/chonkyFish" })
   ```

   Electron 托管的 `desktop` profile **不要**用 `dsh plugin add`（会报 managed exclusively by Electron）。
4. **Host 代码变更**（`app/dsh/host/**`、`core/modules/**`、adapters 等）：需要**重启 DeepSeek Harness** 才加载新 Host；只改 Client 时至少刷新页面，稳妥仍建议重启。
5. **原生感知采集器**（少见）：`npm run build:perception`。

没有仓库内的 `dev:web` / 热替换 Host 的常规路径；不要另起替代 HTTP 服务冒充插件。桌面端如何启动以桌面项目启动时的文档为准（目前尚未交付）。

## 怎么测

改了哪块就跑对应脚本；提交前至少跑**行为相关**的那一组。全量很重，不要默认 `npm test`，除非用户要求或跨多模块改动。

| 区域 | 命令 |
| --- | --- |
| 主动消息 / revisit | `npm run test:proactive` |
| 内部日程 | `npm run test:schedule` |
| 日记 | `npm run test:diary` |
| 人格补充 | `npm run test:persona` |
| 事件引擎 | `npm run test:event-engine:all` |
| 资源规格 | `npm run test:resources` |
| 平台路径 | `npm run test:platform` |
| 社交 | `npm run test:social` |
| ABS | `npm run test:abs` |
| 技能 | `npm run test:skills` |
| 感知 | `npm run test:perception` |
| Hello / 首次设置 | `npm run test:hello` |
| 迁移 | `npm run test:migration` |
| 记忆 | `npm run test:memory` |
| 语音 | `npm run test:voice` |
| 任务 / companion | `npm run test:tasks` |
| 头像播放 | `npm run test:avatar` |
| 全量 | `npm test` |

DSH Client 相关改动：跑完对应测试后还要 `npm run build`，确认 `client.js` 已更新。

**不要**把「单测通过」说成「真实 DSH / 钉钉 / 感知 GUI / 桌面端已验收」。现场验收需要对应宿主重载或桌面构建后再看。

## 目录架构（已设计）

目标布局与依赖规则以 [architecture-refactoring-design-v1.md](docs/architecture-refactoring-design-v1.md) 为准。摘要：

```text
core/                      业务核心：contracts / ports / modules / application
                           · 不 import app/；不直接碰 DSH ctx、HTTP、UI
assets/                    共享立绘 / 头像等素材（各 APP 自行选用）
app/shared/                非 UI 技术实现：storage、platform、channels、audio…
                           · 不放页面 / 组件 / 交互 ViewModel；不绑某一 APP 生命周期
app/dsh/                   当前 APP：Host、Client、UI、adapters、packaging
app/macos/                 未来 macOS 桌面 APP（规划位；有实现任务时再创建）
app/windows/               未来 Windows 桌面 APP（规划位；有实现任务时再创建）
```

落点约定：

| 内容 | 放哪里 |
| --- | --- |
| 路径 / 路由 / 限额 / 文件名等纯数据 | `core/contracts/spec.js`（单一事实源） |
| 业务规则 | `core/modules/<name>/` |
| 宿主无关的存储 / OS / 协议实现 | `app/shared/` |
| DSH 插件 UI / Slot / 构建 | `app/dsh/ui/**`、`app/dsh/build.mjs` → `client.js` |
| DSH Host 装配与适配 | `app/dsh/host/**`、`app/dsh/adapters/**` |
| 未来桌面 UI 与入口 | `app/macos/**` 或 `app/windows/**`（**不要**塞进 `app/dsh/ui` 或 `app/shared`） |

新增 home 文件名、HTTP 路由、限额、schema 版本、preset 名：**只改** `core/contracts/spec.js`（再经 `app/shared/resources` 消费），禁止在各 APP 里再硬编码一套。

三个 APP **各自拥有 UI**；不在 `core/` 或 `app/shared/` 放共享页面。平台兼容（POSIX/Win32、macOS 感知采集）属于 `app/shared/platform/`，**不等于**已有桌面 APP。

## 永远不要碰 / 不要做

- **不要手改** 根目录 `client.js`：它是 `app/dsh/build.mjs` 的生成物；改 DSH UI/Client 逻辑改源再 `npm run build`。
- **不要**让 `core/` 依赖 `app/`，或在核心里直接使用 DSH `ctx` / Agent / HTTP / DOM。
- **不要**在业务代码里硬编码 `$DSH_HOME`、路由路径、文件名；走 `spec.js` / resources。
- **不要**把 `/chonkyfish/*` 无保护暴露到公网；当前接口**没有**插件私有 token，靠宿主边界保护。
- **不要**恢复或新加 `x-chonkyfish-token` 一类私有鉴权，除非产品明确要求并改文档。
- **不要**主动消息乱投会话：无面板 `activeSessionId` 时拒绝，**禁止**猜其它会话或新建会话。
- **不要**把日程旁白、社交、ABS 等算进 proactive 侧栏未读（未读只统计成功的主动搭话，且主聊天聚焦时不加）。
- **不要**做旧目录迁移（例如把历史 `$DSH_HOME/小鱼塘` 搬进 home）；插件只认固定布局。
- **不要**提交 `.ai/`（评估草稿、chrome-profile、任务现场）、密钥、真实 `config`/凭证、本机 home 数据。
- **不要**把遗留 `src/` 当作新功能落点；新代码进 `core/` + `app/`（按上表归属）。
- **不要**在没有桌面实现任务时，为「占位」创建空的 `app/macos/`、`app/windows/` 或伪造桌面壳；规划位已写在架构文档，真做桌面时再按该布局落地。
- **不要**把某一 APP 的页面/组件塞进 `app/shared/` 冒充跨端 UI 库。
- **不要**改用户本机 DSH 配置 / profile / 正在跑的宿主，除非用户明确要求「重载 / 安装 / 恢复插件」。
- **不要**对 `main`/`master` 强推或未经确认直推；上主干优先 PR。未要求时不要随意 `git commit` / `push`。
- **不要**扩大鱼鱼会话的 `danger-full-access` 行为范围，或在文档/能力说明里隐瞒全权限含义。

## 常用改动速查

| 想改… | 动这里 |
| --- | --- |
| DSH 侧栏 / 面板 UI | `app/dsh/ui/**`、`app/dsh/build.mjs` → `npm run build` |
| DSH Host 路由 / 装配 | `app/dsh/host/index.js`、`app/dsh/adapters/**` |
| 业务规则 | `core/modules/<module>/**` + 旁路测试 |
| 路径路由常量 | `core/contracts/spec.js` |
| 平台 / 存储适配 | `app/shared/**` |
| 目录与依赖边界 | `docs/architecture-refactoring-design-v1.md` |
| 功能设计说明 | `docs/*-design-v1.md` / `*-technical-v1.md` |

## 沟通

用户规则若要求中文回复，用中文。改动保持小而完整；不要顺手大重构或写无关文档。
