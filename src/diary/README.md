# 大肥鱼 · 日记（模块1，Host 侧）

给大肥鱼一个「写日记」的能力：**同一个主 Agent、同一条面板会话**，
一个工具 + 本地 Markdown + 面板只读查看。

> **当前形态（2026-10-28）**：日记模块**不内置定时器**。
> 什么时候写由大肥鱼自己决定——她可以用 DSH 原生的 `schedule_create`
> 给自己排一个每日/每周提醒；到点提醒回到当前会话，她再调用 `diary`。

## 设计

```text
大肥鱼自己用 schedule_create 排提醒（时间由她/主人定）
      │ 到点 → DSH schedule 投回同一条鱼鱼会话
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
- **没有定时器**：日记模块不猜时间、不做 20:00 提醒；排期交给 DSH 的 schedule 工具。

## 文件

```text
src/diary/
  errors.js       领域错误 + 稳定错误码
  date.js         严格 YYYY-MM-DD / 真实日历日期
  provider.js     LocalDiaryProvider（原子写 / 路径安全 / 倒序枚举）
  core.js         DiaryService：日期、正文、limit、action 校验与分发
  tools.js        单工具 diary（裸定义注册，不 import DSH 包）
  http.js         面板「日记」弹窗的只读路由（list / read）
  index.js        装配：tool + provider + service
  tests/run-diary.mjs
```

## 配置（config.json → diary）

```json
{
  "diary": {
    "enabled": true,
    "enabledPresets": ["chonkyfish"],
    "maxContentChars": 50000
  }
}
```

- `enabledPresets` 默认只有 `chonkyfish`。工具是全局注册的，其它 preset 的 Agent 创建时
  会 `restrict({ deny: ['diary'] })` 隐藏，guard 再兜一层；
- `diary.enabled` / `enabledPresets` 在插件启动时读取，改完要重启 DSH Host；
  `maxContentChars` 每次写入时重读。

## 排期：交给 DSH 定时任务

`chonkyfish` preset 里挂了 `@deepseek-ai/dsh-tool-schedule`，鱼鱼可以直接用：

```text
schedule_create(prompt, title, daily({ time: "20:00:00", time_zone: "Asia/Shanghai" }))
schedule_list() / schedule_update(id, …) / schedule_delete(id)
```

到点由 DSH 的 `schedule` 服务把提醒投回**创建它的那条会话**。面板始终同一个会话，
所以提醒会回到面板里；鱼鱼收到提醒后再调用 `diary` 写当天日记。

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
node src/diary/tests/run-diary.mjs   # 8 个用例
npm test                            # 模块0 + 资源 + 人格 + 主动消息 + 日记
```
