# 通话中的原生星露谷陪伴

## 使用入口

主人主持一个真实 Co-op 游戏窗口，大肥鱼用另一游戏进程通过 LAN 加入，控制独立 farmhand。先分别读取新鲜的 `stardew_session_state` / `stardew_get_state`，确认同一 worldId、不同的 localFarmerId / hostId，以及客户端实际 `role=farmhand`。不要以 NPC、shadow farmer 或单人读档替代真实联机。

本机连接名为 `stardew`（主人主机）和 `stardew2`（AI 客户端）。两者必须配置不同的 `STARDEW_BRIDGE_PATH` / `STARDEW_ACTION_DIR`。本插件按同一 MCP 连接的完整 start/status/cancel 三组工具发现能力；原生联机、工具和走路协议仅信任这两个已支持的别名。

| 游戏实例 | DriveLocalPlayer | RunInBackground | ExclusiveAiInput | AutoLoadLatestSave |
| --- | --- | --- | --- | --- |
| 主人主机 | false | false | false | false |
| AI 客户端 | true | true | true | false |

`RunInBackground` 不是全局开关：只有已连接的真实 farmhand、匹配的 game/world/actor 租约及有效原生输入适配器能获得后台权限。`isFocused` 保留真实焦点；不通过激活窗口或 OS 全局按键控制 AI。普通单人与主人主机不获得这份后台输入权限。

## 主人输入隔离

`ExclusiveAiInput` 默认关闭，且必须同时开启 `DriveLocalPlayer`、`RunInBackground` 才生效。只在 AI 专用进程开启：从标题画面到进入世界、断线与退出世界，持续隔离实体手柄、键鼠和文字事件，阻止手柄震动及系统光标移动；意外获得焦点也不会接收主人的设备输入。角色动作仍须取得精确 farmhand 租约。主机保持关闭，继续读取自己的实体设备。

新鲜状态中的 `runtime.backgroundExecution.physicalInputIsolation` 必须显示 `active=true`、`installed=true`、`installError=null`；本次支持的安装版本有 23 个设备及事件拦截入口。计数持续增加可证明拦截正在执行，但不能单凭计数代替真实手柄并行操作验收。不支持完整隔离的版本拒绝 AI 动作。

专用陪玩环境在 dashboard 插件行显式启用保护，让 MCP 启动失败、断线或尚未发布工具时也不能退回 shell 控制游戏：

```yaml
- id: chonkyfish-dashboard
  name: '@local/chonkyfish-dashboard'
  config:
    protectNativeCompanion: true
```

Host 同步安装执行门禁，覆盖 `chonkyfish` 主人会话、运行中的子代理和恢复的子会话。`stardew` 主机工具仅可读；AI 客户端只允许 `stardew2` 的已登记原生动作，`session_start` 仅可 `join_lan`。shell、任意代码/终端、任意文件写入、桌面控制、未知 MCP 动作及绕道后台任务均在执行前拒绝；不按脚本文本里的游戏名或 Windows API 关键字判断。原生动作和受支持的 `fish_task_start` 生命周期、文件读取/搜索、任务状态及日记等有界能力保留。与主人无关的其他 Agent 不受此门禁限制。

未显式配置时，发现 `stardew2` 完整的原生 session/tool/travel 生命周期工具，或恢复到已有原生调用记录的主人会话，也会启用保护。保护在当前宿主生命周期内随会话身份保留，MCP 暂时消失或 Agent 被压缩替换不会重新开放 shell。独立的通用命令工作应使用未配置陪玩的其他 Agent；门禁不撤销安装前已经启动的外部进程，也不限制宿主外部的其他桌面软件。

恢复子会话时，Host 通过 DSH `sessionPersistence.stat` 读取离线父会话的头部元数据来确认归属。配置了原生陪玩的环境中，父链尚未解析或读取失败时，先拒绝不安全能力；确认与主人无关后恢复通用工具。已有权限 `danger-full-access` 与后台任务的可信 signal 均不能豁免这层门禁。

## 通话调用示例

当前主机已经正常开放 Co-op 时，开始后台加入：

```js
fish_task_start({
  toolName: 'mcp__stardew2__stardew_session_start',
  arguments: {
    mode: 'join_lan',
    address: '127.0.0.1',
    farmhandId: '<新鲜 eligibleFarmhands 中的精确字符串 ID>',
  },
})
```

主人先在自己的游戏实例中开放真实 Co-op 主机，再让客户端加入。受保护的陪玩会话不能用主机 MCP 加载存档或把 AI 客户端改为 `host_existing_save`；没有可加入的主机时说明当前状态。空 peer 主机仍是有效 server；不能用其他已连接玩家数量判断是否主持成功。

加入完成后，读客户端新鲜 state 和 observed target，后台挥斧：

```js
fish_task_start({
  toolName: 'mcp__stardew2__stardew_tool_task',
  arguments: {
    worldId: state.worldId,
    actorId: state.actorId,
    dateKey: state.dateKey,
    location: state.locationId,
    tool: 'axe',
    x: observed.X,
    y: observed.Y,
  },
})
```

Host 生成稳定 requestId；调用者不用另传冲突 ID。收到 `fish_task_start` 的任务句柄后立刻回到对话，用 `fish_task_inspect` / `fish_task_list` 短查，最终结果由任务通知汇报。不要在前台循环等游戏操作完成。停止时先 inspect，再以 `taskId` / `expectedVersion` 调 `fish_task_cancel`；取得取消回执不等于已经停稳。

## 输入与结果

| 协议 | 原生 MCP 工具 | 必需输入 / 终态 |
| --- | --- | --- |
| 联机 | session_start / session_status / session_cancel | 客户端 mode=join_lan，可选 LAN address 和精确 farmhandId/name；完成须有真实角色与身份 |
| 走路 | travel_task / travel_status / travel_cancel | 新鲜 worldId/actorId/dateKey、观察到的地图唯一名和目标 x/y；精确到达且输入释放后完成 |
| 工具 | tool_task / tool_task_status / cancel_tool_task | 新鲜 worldId/actorId/dateKey/location、tool、x/y；动画结束且 receipt.effectVerified 才完成 |
| 农活 | farm_task / task_status / cancel_task | operation、实测矩形与可选 seedId；检查实际 succeeded/failed/skipped |

完整工具名带 `stardew_`，上表为便于比较省略公共前缀。所有 scope ID 都是字符串。工具目标坐标必须是非负 Int32，并来自当前地图观察。原生工具枚举为 axe/pickaxe/hoe/watering_can/scythe/sword；本轮真实游戏验收覆盖 axe 与 hoe，其他类型不从这两项外推。

工具任务会用原生输入走到可达邻格，释放移动，再进入 `Farmer.BeginUsingTool` 与游戏动画回调。没有直接 `DoFunction/DoDamage` 捷径，也不写动画帧、位置或奖励来制造完成。树砍倒时可能把健康值重设为树桩值；倒伏/树桩转变也要记录为真实效果。

queued/running/settling 都不是完成。旅行的 rejected/interrupted 作为确定失败返回；原生 unknown 或缺少必要效果证明会保留 outcome-unknown 和资源隔离。只有信任协议、ID 匹配的显式 `{status:'rejected', notApplied:true}` 能证明命令在发送前被拒绝；普通 MCP 错误、写入失败或超时不能据此释放未知资源。已经开始的原生动画可以在取消请求后产生效果，不承诺回滚。

## 架构与后续桌面端

DSH 层负责执行能力隔离、工具发现、稳定操作身份、后台观察、取消、资源互斥与会话通知。游戏侧的 session/action/input 控制器不依赖语音或 DSH；未来桌面端可以复用相同 MCP 生命周期与 native scope，替换宿主的任务和语音适配器。后台权限与真实焦点始终分开，不能把桌面窗口激活当作后台实现。

## 2026-11-16 输入隔离与 USB 手柄验收

两个真实客户端通过本机 LAN 加入同一世界，角色 ID 不同。主人实例保留实体输入，AI 实例启用 `ExclusiveAiInput`，使用存档副本和隔离 Mods。用户将 USB 手柄实际用于主人角色，并确认“正常，没有抢窗口或手柄”；两个游戏分别放在两个显示器，最终焦点留给主人。

- 60.491 秒并行区间，24 次 AI 原生移动全部完成。主人有 1,476 个实体手柄输入采样，配对的 AI 输入均被隔离；AI 的 3,630 个采样全部失焦，手柄可见采样为 0。
- 938 个配对更新同时观察到主人和 AI 的原生移动或工具动作；主人的有效手柄持续可用。
- 另一段后台工具试验完成 61 次效果验证成功的挥斧；下一棵树不可达时原生接口拒绝，不通过远距离施加效果补成成功。
- 实际安装程序集验证 23 个设备及事件入口，并覆盖 SMAPI `TrueUpdate`/`IsDown`、前后台合成输入、失效租约清零、世界退出、关闭隔离和释放恢复。DSH 策略及真实 Host 注册测试覆盖 shell-first、编码或间接脚本、可信任务 signal、子会话恢复、会话替换和 MCP 启动失败。

此版本正式 DLL SHA-256 为 `204D207BFFF5F24EDCD3BE77057C290E47D7D8DC8DB386355FF042FEA6B2B42C`，已部署至两个正式 Mods 目录并同步专用客户端配置与技能。DSH 显式保护配置已写入；用户按 Escape 停止电脑操作后，运行中的 DSH 热重载完成状态仍未确认。当前游戏验证使用隔离的 Mods 与存档副本，不能据此声称正式 DSH 会话已经加载最新门禁。

## 2026-11-15 原生 LAN 与动画验收

Windows，Stardew Valley 1.6.15.24356 / SMAPI 4.5.2。使用隔离数据目录与存档副本，两条原生/SMAPI 保存路径均经验证；13 个原始保存文件哈希保持不变。

- 无人工菜单/按键辅助的 native host + 后台 LAN join，真实独立 farmhand。
- AI 全程失焦从小屋走到农场；完整回归区间共 2,080 个更新采样、328 个不同的位置/地图观察。
- 成熟树及树桩共 15 次原生挥斧全部完成并验证效果；每次 30 个 UsingTool 采样，帧 66–70 全部推进。
- 主人前台实例接收到 479 个远端工具动画采样，包含上述斧头帧与锄头帧 48–52。
- 原生移动后锄地成功 1 格；途中取消在挥击前停稳；同 ID 重放返回 duplicate。
- 148 项 C# 检查、51 项 MCP 协议测试、后台输入清零/替换检查、4 项地图解析检查及 DSH task/foreground 检查通过。最终构建 0 warnings / 0 errors。

原生 DLL SHA-256：`5F3BDAEC0015FA9C38D9FA0F76A5CF1FDD24219832F9B99D921387F103645BC5`。已备份原 DLL/config，并将验收版本放入两个真实 Mods 目录；DSH 本地插件链接仍指向此仓库。陪玩技能也同步了新入口与后台范围。游戏退出后 bridge 文件会残留，不能以旧快照证明仍在线。

测试期间没有重启主 DSH、向主对话插入消息或打断用户语音通话。更新代码后重启 DSH 与两个游戏实例，让宿主重新加载适配器、MCP 工具列表和游戏 DLL。边框全屏窗口的桌面截图有时滞留旧帧，本轮动画结论来自实际游戏逐更新状态与主机收到的远端帧，不声称截图捕获链也已通过。硬件按键注入被 IME 截获的试验未计为通过；后台钓鱼、全部工具变体与联机过夜仍需各自场景验收。
