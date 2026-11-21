# 记忆

记忆是随包发布的 skill，加上 `$DSH_HOME/chonkyfish/memory/` 里的本地文件。鱼鱼用通用文件能力自己读、改、删这些文件。这里没有记忆数据库、记忆工具或写入代理。

宿主只做一件事：监听 `session/event`，把当天有 `user/message` 或 `assistant/message` 的鱼鱼会话记到 `memory/sessions/YYYY-MM-DD.md`。每行只有 sessionId 和当天首次、最近活动时间。这个目录由宿主写，鱼鱼只读，也不随迁移走。

常驻说明给出的是解析后的绝对 `memoryRoot`，以及 `fish_skill` 的读取入口：`action` 为 `read`，`skillId` 为 `memory`，`section` 为 `guide`。正文不注入常驻说明。

## 旧聊天

旧聊天仍在 DSH。需要回读时原样使用官方工具，不在本模块封装：

- `session_search`
- `session_event_search`
- `session_event_read`
- `session_trace`
- `session_event_trace`

它们由 Session search 插件挂到全局工具层，Web/Desktop 默认关闭，要在插件页启用。大肥鱼 preset 不单独挂载。工具不可用时，文件记忆和当天索引仍可用，但不能声称查过旧聊天。官方工具要求目标会话和调用者的 `header.cwd` 完全相同；索引可以包含工作区子目录，跨 cwd 时只能说明范围限制。

搜索结果和邻居行的时间是 UTC 字符串，`session_event_read` 目标 JSON 的 `time` 是 Unix 毫秒。对人说明时换算成 Asia/Shanghai。`current/shadowed` 不是可见性过滤。

## 运行

`memory.enabled` 关闭时不监听，也不写入技能库。开启时，若 `$DSH_HOME/chonkyfish/skills/memory.json` 不存在，用技能库现有的 `create` 写入一份，正文只来自 `SKILL.md`（frontmatter 之后的全文作为 guide）。文件已存在就保留，包括用户自定义和损坏文件，再次启动不会改写。不调用官方 `skills.register`，也不把正文复制到 `memory/`。`skills.enabled` 为关时 `fish_skill` 读不到它，只警告，索引照常写。技能目录无法写入时同样只警告。这不表示已经在真实 DSH 里验证过。

`sessionQuery` 缺失时同样只警告，索引照常写。

语音是否会落成上述两类消息、助手原文里 reasoning 块的呈现，都还没有用真实 DSH 核对。
