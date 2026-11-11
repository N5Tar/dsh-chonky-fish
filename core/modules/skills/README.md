# 大肥鱼 · 活动技能框架

技能库没有预置内容：只有本地用 `create` 创建过的技能才会出现在目录里。本模块是知识和学习框架，不是网站部署器；没有授权状态、审批队列或定时器。

## 已实现

- `fish_skill`：list / read / history / export。
- `fish_skill_learn`：create / record / revise / rollback / import。
- 本地首版指南、观察经验、不可变历史快照、版本冲突检查、持久化和回退。
- 全局工具注册，不限制 preset、工作区或调用会话；`skills.enabled` 仍是动态模块总开关（默认 true）。
- 默认 read 章节为 guide；record 的 evidenceRefs 默认空数组。

模型从工具描述发现技能库，用 list 查看目录，再 read 按需读取。不会把全部技能正文注入人格。支持主体仍是同一只大肥鱼，不新增执行 Agent 或 ABS 决策逻辑。

## 存储

运行数据存于 `$DSH_HOME/chonkyfish/skills/<skillId>.json`。每个技能只有本地创建后才存在；`create` 写入首版，之后的 `record/revise/rollback` 追加新版本，更新插件不会覆盖已有内容。目录就是技能清单，不再有代码内置的初始技能。

旧版（内置 seed 时代）的 `<skillId>.json` 只有 `{format, skillId, snapshots}`，首版 action 为 `seed`。当前版本在读取时会**原地迁移**：从首版指南推导标题/描述（无标题时回退到 skillId），把 `seed` 改为 `create`，所有快照、经验和修订内容原样保留；迁移失败也只按内存中的升级结果提供读取，不重置文件。若旧文件本身结构仍然非法（版本号错乱、缺修订、空指南等），仍然 fail-closed 报 `CORRUPT_STATE`。

限制集中在 [资源规格](<../../contracts/spec.js>) 的 `SKILL_LIMITS`：64 个快照、128 条经验、512 KiB 文件；每次记录经验也产生新快照，总大小与版本数可能先达到上限。上限不自动删除历史；导出不会删除或改变技能内容。

`revise/rollback` 需要当前 expectedRevision。回退是用历史的指南与经验创建一个新快照，不是删除版本，也不是回滚线上网站。经验 status 固定为 observed，不宣称已验证结论。

业务核心只依赖技能仓储端口；本地文件实现位于 `app/shared/storage/skills-file.js`。同一进程共享串行队列；临时文件同步后原子替换。非法状态、超限、符号链接和硬链接拒绝读写；不支持跨进程并发写入，也不提供对外部恶意目录替换的完整防护。

分页 guide 使用字符偏移，其他使用条目偏移；nextOffset 为 null 才读完。连续读取应固定 revision，修订前读完整正文。

## 单技能 JSON 导入导出

UI 和工具共用 `service.run`，无批量、合并或覆盖模式：

- `GET /chonkyfish/skills?action=export&skillId=xxx` → `{ok:true,data:<archive>}`。
- `POST /chonkyfish/skills`，`Content-Type: application/json`，正文 `{action:'import',archive:<archive>}` → `{ok:true,data:{skillId,title,description,revision,sections,experienceCount,action:'import',revisionCount}}`。POST 不接受查询参数。
- 工具：`fish_skill({action:'export',skillId})`；`fish_skill_learn({action:'import',archive})`。导入身份以 archive.skillId 为准；共享工具 schema 的其他动作占位字段会被忽略，不会重命名存档。HTTP 正文仍只接受 action/archive。
- archive 直接是 `{format:1,skillId,title,description,snapshots:[...]}`，不是 HTTP 响应外壳。所有版本的完整 guide、experiences、时间戳、修改原因及回退来源均保留。导出无分页或截断；日常按需读取仍用 read/history。
- 保留现有 schema 和字段限额：64 个快照、每快照 128 条经验、库中最多 128 个技能；指南 16000、标题 200、描述 1000、经验 2000、原因 500 字符，最多 12 个证据引用、每项 500 字符。紧凑 JSON UTF-8 大小 ≤512 KiB；POST 原始正文（含包装与空白）≤1 MiB。HTTP 对流和 Content-Length 都设上限，拒绝非法 UTF-8。
- 同 ID 返回 `409 / CONFLICT`，即使已有普通文件损坏也不覆盖。导入临时文件同步后以独占发布方式落盘，竞争导入只有一方成功；不会追加导入版本或重写原始历史。
- 结构、未知字段、ID、版本顺序、时间戳、经验状态或回退引用无效：`400 / INVALID_ARGUMENT`；超限：`413 / LIMIT_EXCEEDED`；非 JSON 媒体类型：`415 / UNSUPPORTED_MEDIA_TYPE`。错误体为 `{ok:false,error:{code}}`，不泄露路径。
- 导出文件可能包含全部历史私密内容，分享前应检查；导入只保存知识，不执行指南、HTML 或任何外部指令，不提升经验的可信度。
- Host 认证和路由注册保持不变，不新增插件 token。模型工具受 enabled/ready/close 生命周期约束；主人 UI 管理和已有查看接口一样，关闭模型技能工具后仍可使用。

## 运行边界

- 按主人明确要求，已移除技能库的 preset／会话访问门禁和 HTTP 私有访问凭证。能连接 DSH 服务地址的客户端可读取技能内容；宿主自身的认证不由本模块更改。
- 总开关不是活动授权状态；无审批操作。
- `record/revise` 自主保存立即生效；框架不判断自然语言内容是否正确。
- 已核对主人提供的网站仓库 `/Users/jinyan/workspace/chonky-fish-site`：主站为 https://mingyue.novak.wang，纯静态，使用该仓库发布与验收脚本；同仓库 theme 子站不属于默认运营目标。初始指南包含实际入口及 dry-run/清理/公网验证边界。
- 以上是仓库核对，不是 SSH 或线上验收。换环境后路径需重新确认；已有持久化自学版本不自动覆盖，应通过修订合并新入口。
- 侧边栏「技能」页面，位于社交之后、ABS 之前：技能目录、使用指南、学习经验、版本历史与历史正文；支持刷新、分页、空状态、失败重试和中英文。
- 页面通过 `GET/HEAD /chonkyfish/skills` 读取、导出，通过 `POST` 导入；共用技能 service，不新增私有 token，不调用模型或发布官网。关闭技能工具后仍可查看和管理已有内容。
- 没有 UI 编辑/回退操作、调度器或平台发布工具；当前工具名不是 DSH 通用 skill 的替代。
- 页面样式使用宿主主题变量；正文作为纯文本渲染，不执行技能内容中的 HTML。切换或卸载时取消未完成读取。
- 未进行真实模型活动或官网发布验收。

## 测试

```bash
npm run test:skills
npm test
```

核心测试覆盖分页、持久化、默认参数、并发/CAS、回退、损坏、路径和容量，以及完整存档往返、拒绝覆盖、非法/超限/批量导入、并发导入和 sibling 占位字段。宿主模拟测试覆盖发现、身份、启停、注册/卸载、失败清理、readiness 等待和 HTTP/工具 transfer 一致性；HTTP 测试使用临时存储与临时本地服务验证流式大小限制、UTF-8、媒体类型和错误状态，不触碰真实技能数据。Host 实际认证仍由宿主管理，模拟测试不替代安装后的宿主验收。

本次工具 schema UTF-8 大小从 2948 到 3347 字节（+399）；离线测试未测量精确模型首轮 token 差值。开发已加载 cordis-plugin-development、agent-experience；未调用可用列表以外的子技能。

设计说明位于源码仓库的 [框架方案](<../../docs/skills-module-design-v1.md>)；方案文档不在运行包中。
