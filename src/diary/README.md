# 大肥鱼 · 日记（模块1，Host 侧）

给大肥鱼一个「写日记」的能力：**同一个主 Agent、同一条面板会话**，
一个工具 + 本地 Markdown + 每天 20:00 一条隐藏旁白提醒。

> **当前形态（2026-10-28）**：不做独立日记会话、不做多会话聚合。
> 日记就是面板里那条鱼鱼会话自己写的；Host 只负责到点提醒和落盘。

## 设计

```text
每天 20:00（时区可配）
      │  proactive.json.activeSessionId
      ▼
同一个鱼鱼会话 ← 隐藏旁白（source.kind = chonkyfish-nudge）
      │
      ▼
模型调用 diary(action="write", date="YYYY-MM-DD", content="…")
      │
      ▼
Diary Core（校验 / 覆盖语义）
      │
      ▼
LocalDiaryProvider → $DSH_HOME/chonkyfish/日记/YYYY-MM-DD.md
```

- **一个工具**：`diary`，`action = write / read / list`；
- **Core 不调 LLM**：正文由主 Agent 自己写；
- **Provider 只落盘**：一天一个 UTF-8 Markdown，重复创建默认拒绝，显式 `overwrite=true` 才替换；
- **没有面板会话就不投**：项目设定是面板始终同一个会话；没有上报过的 `activeSessionId` 时当晚跳过，下个 tick 再试（不新建会话）。

## 文件

```text
src/diary/
  errors.js       领域错误 + 稳定错误码
  date.js         严格 YYYY-MM-DD / 真实日历日期
  provider.js     LocalDiaryProvider（原子写 / 路径安全 / 倒序枚举）
  core.js         DiaryService：日期、正文、limit、action 校验与分发
  tools.js        单工具 diary（裸定义注册，不 import DSH 包）
  narration.js    每日隐藏旁白的文案（写完不汇报）
  state.js        diary.json：lastNudgeDate / 最近一次结果
  schedule.js     20:00 判断（时区 / catchUp / 去重 / 重试）
  http.js         面板「日记」弹窗的只读路由（list / read）
  index.js        装配：tool + provider + scheduler
  tests/run-diary.mjs
```

## 配置（config.json → diary）

```json
{
  "diary": {
    "enabled": true,
    "enabledPresets": ["chonkyfish"],
    "maxContentChars": 50000,
    "schedule": {
      "enabled": true,
      "hour": 20,
      "minute": 0,
      "timezone": "",
      "catchUp": true
    }
  }
}
```

- `enabledPresets` 默认只有 `chonkyfish`。工具是全局注册的，其它 preset 的 Agent 创建时
  会 `restrict({ deny: ['diary'] })` 隐藏，guard 再兜一层；
- `diary.enabled` / `enabledPresets` 在插件启动时读取，改完要重启 DSH Host；
  `schedule` / `maxContentChars` 运行时重读；
- `catchUp`：20:00 Host 没开着，当天稍后启动补一次；
- 同一天只提醒一次（`diary.json` 落盘 + 进程内兜底）；当天日记已存在则不提醒。

## 面板查看

右上角 📔 打开「鱼鱼的日记」：按日期列出、点开只读正文。

```text
GET /chonkyfish/diary?limit=60          → { ok:true, action:'list', dates:[...] }
GET /chonkyfish/diary?date=2026-10-28   → { ok:true, action:'read', date, content }
```

请求需要注入页面的 `x-chonkyfish-token`；只读，写入仍然只能由鱼鱼调用 `diary` 工具。

## 工具契约

```json
{ "action": "write", "date": "2026-10-28", "content": "……", "overwrite": false }
{ "action": "read",  "date": "2026-10-28" }
{ "action": "list",  "limit": 30 }
```

成功：`{ok:true, action, ...}`；失败：`{ok:false, error:{code, message}}`。
错误码：`INVALID_DATE / INVALID_CONTENT / INVALID_LIMIT / INVALID_ARGUMENT /
DIARY_ALREADY_EXISTS / DIARY_NOT_FOUND / DIARY_STORAGE_ERROR`。

## 跑测试

```bash
node src/diary/tests/run-diary.mjs   # 13 个用例
npm test                            # 模块0 + 资源 + 人格 + 主动消息 + 日记
```
