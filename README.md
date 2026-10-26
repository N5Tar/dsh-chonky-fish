# DSH Chonky Fish · 大肥鱼

一个给 **DeepSeek Harness（DSH）** 的公开插件：把「大肥鱼 · 小鱼塘管理台」作为一个自带面板装进 DSH，并**同时注册一个 `chonkyfish` agent preset**。装完就能和一只蓝色大肥鱼聊天，她会用真实 DSH 会话、带通用工具，还会把整个 Harness 皮肤换成小鱼塘蓝白配色。

> 独立粉丝概念 UI · 非 DeepSeek 官方产品。

![icon](icon.svg)

## 特性

- **自有面板**：侧栏「大肥鱼」入口 + 主面板聊天 UI（顶栏、消息流、无边框鱼鱼舞台、快捷 chips、钱包 / 人格弹窗）
- **真实对话**：消息走 DSH Session，不是前端假回复；会话保存在 DSH 日志里，标准对话界面也能打开
- **agent preset**：安装本插件即注册 `chonkyfish` preset（人格 + 通用工具），无需单独安装预设包
- **通用工具**：bash / pwsh、文件读写与 glob/grep、后台任务、todo、web_search / web_fetch
- **全权限会话**：`chonkyfish` 会话会自动切到 `danger-full-access` + 审批 `never`，因此可以通过 AppleScript / CDP 控制本机浏览器（⚠️ 见下方安全说明）
- **专属工作区**：首次打开会在 `$DSH_HOME/小鱼塘` 建目录并注册「小鱼塘」工作区，鱼鱼会话不混进项目会话
- **主题皮肤**：加载插件后把 DSH 的 14 个语义 token 之外、整套 `--dsw-static-*` 调色板重映射成小鱼塘配色（明暗主题都适配），卸载即恢复
- **角色养成**：名字 / 补充人格设定、贝壳钱包与账本、6 套姿态互动（点击害羞、投喂、思考/开心/睡着）
- **零外部请求**：插图与头像以 WebP data URI 内嵌在 `client.js` 里，不下载图片

## 安装

要求：DeepSeek Harness 桌面版（0.2.1 系列），推荐在配好模型的 profile 中使用。

### 方式一：本地目录安装（推荐）

1. 把本仓库克隆到任意目录：

   ```bash
   git clone https://github.com/N5Tar/dsh-chonky-fish.git
   ```

2. 在 DSH 里让 Agent 调用 `plugin_manager` 安装这个目录（需要 Creator 模式 / Full access）：

   ```
   plugin_manager({ action: "install_bundle", target: "/absolute/path/to/dsh-chonky-fish" })
   ```

   或者：

   ```bash
   dsh plugin --profile <profile> add /absolute/path/to/dsh-chonky-fish
   ```

3. 安装完成后：
   - 左侧会出现「大肥鱼」图标，点开即用
   - `chonkyfish` agent preset 会自动注册（设置里能看到「大肥鱼」）
   - 第一次打开鱼鱼面板会创建 / 注册「小鱼塘」工作区并新建会话

### 方式二：开发

```bash
node build.mjs      # 从 src/original.html + src/runtime.js 生成 client.js
```

`src/assets.json` 内是压缩后的 6 套姿态 WebP；`client.js` 是最终被 DSH 加载的产物。

## 安全说明（重要）

安装即代表你接受以下行为：

- `chonkyfish` preset 的会话会**自动切换到 `danger-full-access` 权限预设、审批策略 `never`**（Host 侧在 `agent/created` 时通过 `permissionPresets.set` 写入会话日志）。
- 这意味着鱼鱼可以使用 shell / 文件工具，**读写工作区以外的文件、执行任意命令、控制本机浏览器**，且不会弹审批。
- 它只应在你信任的机器和模型配置下使用。不想要全权限时，把 `index.js` 中 `giveFullAccess` / `agent/created` 监听删掉，或在会话里手动切回 `workspace-write`。
- 鱼鱼面板只渲染文字回复，不显示工具卡片或审批 UI；需要审批的操作请在标准对话界面处理。

## 数据与隐私

- 聊天记录保存在本机 DSH Session（`$DSH_HOME/sessions`）
- 名字、补充人格、钱包与账本保存在浏览器 localStorage（`chonkyfish-mini-demo-v1`）
- 插件本身不发网络请求；`web_search` / `web_fetch` 会走 DSH 配置的 Web 服务

## 仓库结构

```
cordis.patch.yml   # bundle 入口：插面板 row + chonkyfish preset row
index.js           # Host 半：建小鱼塘目录、给 chonkyfish 会话全权限
client.js          # 构建产物：面板 UI + DSH 会话桥 + 主题皮肤
client 源文件
build.mjs          # client.js 构建脚本
src/original.html  # 融合版聊天 UI 设计稿（Shadow DOM 适配前）
src/runtime.js     # 面板控制器（增量消息、鱼鱼姿态、钱包/人格）
src/assets.json    # 6 套姿态 + 头像（WebP data URI）
locale/            # 插件列表显示名与描述（zh / en）
icon.svg           # 插件图标
```

## 兼容性

在 DeepSeek Harness `0.2.1-rc.2` / `rc.3` 桌面版实测通过；依赖 DSH 的 Slot、Session、Theme、Permission、Agent Preset 等公开服务。DSH 版本升级后若接口有变，面板与 preset 可能需要跟着调整。

## License

仓库暂未附带开源许可证；如需商用或二次分发，请先联系仓库维护者。
