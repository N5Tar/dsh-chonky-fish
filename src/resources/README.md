# 大肥鱼 · 资源管理模块（Host 侧）

ChonkyFish 的**所有本地资源与配置只从这里来**：home 目录布局、文件名、HTTP 路由、请求体上限、
JSON schema 版本、浏览器 localStorage key、素材目录、默认配置。其它模块（`index.js`、事件引擎、
主动消息、`build.mjs` → `client.js`）都消费本模块，不再各自硬编码。

```text
src/resources/
  spec.js                 纯数据资源规格（Host / client 构建共用，单一事实源；含默认补充人格文案与 system prompt 变量名）
  index.js                Host 侧资源管理器：解析 home、建目录、读写 config.json、注入页面
  tests/run-resources.mjs 布局 / 配置 / 注入信息测试
```

## home 布局

`$DSH_HOME` 默认 `~/.dsh`。插件自己的 home 是 `$DSH_HOME/chonkyfish/`：

```text
$DSH_HOME/chonkyfish/
  config.json       可编辑配置（见下）
  state.json        面板状态（名字 / 补充人格 / 钱包 / 账本 / 演示对话）
  proactive.json    主动消息运行态（activeSessionId、发送计数、最近记录）
  events.db         模块0 事件库（SQLite，伴随 -wal/-shm）
  小鱼塘/           鱼鱼工作区（DSH 会话 cwd）
```

**不做迁移**：插件只认上面这套固定布局。旧版的 `$DSH_HOME/小鱼塘` 不会被搬入 home、不会建兼容
软链，也不会被当作合法工作区；升级后请当作全新工作区使用（旧目录可自行删除）。

## config.json

```json
{
  "version": 1,
  "proactive": { "enabled": true },
  "eventEngine": {
    "enabled": true,
    "extractTickMs": 5000,
    "extractBatch": 2,
    "maxRecordsPerTurn": 400
  }
}
```

- 读取时消毒：未知字段丢弃，非法值回退默认；`extractTickMs` 1000–60000、`extractBatch` 1–10、
  `maxRecordsPerTurn` 50–5000（均截断为整数）。
- 写入是「临时文件 + rename」原子写；`updateConfig(patch)` 深合并后落盘。
- 文件缺失时由 `ensureLayout()` 写入默认值；已存在的文件不会被覆盖。
- 运行时可通过 `GET /chonkyfish/config`（带 token）查看、`PUT /chonkyfish/config` 局部更新。
- `eventEngine.enabled` / `extractTickMs` / `extractBatch` 是启动时读取的，改完需要重启 Host 生效；
  `proactive.enabled` 每次发送前重读，改完即时生效。

## 对外接口

```js
const resources = createResources({ env: process.env })
resources.home / resources.dshHome / resources.paths
resources.routes / resources.limits / resources.versions / resources.spec
resources.getConfig() / await resources.updateConfig(patch)
await resources.ensureLayout({ logger })
resources.clientState()   // 注入页面：home / preset / routes / paths（不含 token）
```

`paths.workspace` 是唯一的鱼鱼工作区根（`$DSH_HOME/chonkyfish/小鱼塘`），事件引擎、主动消息、
客户端都只用它。`clientState()` 给面板提供工作区路径，客户端不再自己拼 `~/.dsh`。

## 跑测试

```bash
node src/resources/tests/run-resources.mjs   # 12 个用例
npm test                                     # 模块0 + 资源管理 + 主动消息
```
