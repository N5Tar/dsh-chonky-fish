# 通话中的原生星露谷陪伴

## 使用入口

主人主持一个真实 Co-op 游戏窗口，大肥鱼用另一游戏进程通过 LAN 加入，控制独立 farmhand。先分别读取新鲜的 `stardew_session_state` / `stardew_get_state`，确认同一 worldId、不同的 localFarmerId / hostId，以及客户端实际 `role=farmhand`。不要以 NPC、shadow farmer 或单人读档替代真实联机。

本机连接名为 `stardew`（主人主机）和 `stardew2`（AI 客户端）。两者必须配置不同的 `STARDEW_BRIDGE_PATH` / `STARDEW_ACTION_DIR`。本插件按同一 MCP 连接的完整 start/status/cancel 三组工具发现能力；原生联机、工具和走路协议仅信任这两个已支持的别名。

| 游戏实例 | DriveLocalPlayer | RunInBackground | AutoLoadLatestSave |
| --- | --- | --- | --- |
| 主人主机 | false | false | false |
| AI 客户端 | true | true | false |

`RunInBackground` 不是全局开关：只有已连接的真实 farmhand、匹配的 game/world/actor 租约及有效原生输入适配器能获得后台权限。`isFocused` 保留真实焦点；不通过激活窗口或 OS 全局按键控制 AI。普通单人与主人主机不获得这份后台输入权限。

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

标题页需要由 MCP 主持存档时，调用主机的 `stardew_session_start`，传 `mode: 'host_existing_save'` 及 availableSaves 中的真实 `saveFolder`。等待其实际 host/ready，再提交客户端加入。空 peer 主机仍是有效 server；不能用其他已连接玩家数量判断是否主持成功。

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
| 联机 | session_start / session_status / session_cancel | mode；主机可选 saveFolder，加入可选 LAN address 和精确 farmhandId/name；完成须有真实角色与身份 |
| 走路 | travel_task / travel_status / travel_cancel | 新鲜 worldId/actorId/dateKey、观察到的地图唯一名和目标 x/y；精确到达且输入释放后完成 |
| 工具 | tool_task / tool_task_status / cancel_tool_task | 新鲜 worldId/actorId/dateKey/location、tool、x/y；动画结束且 receipt.effectVerified 才完成 |
| 农活 | farm_task / task_status / cancel_task | operation、实测矩形与可选 seedId；检查实际 succeeded/failed/skipped |

完整工具名带 `stardew_`，上表为便于比较省略公共前缀。所有 scope ID 都是字符串。工具目标坐标必须是非负 Int32，并来自当前地图观察。原生工具枚举为 axe/pickaxe/hoe/watering_can/scythe/sword；本轮真实游戏验收覆盖 axe 与 hoe，其他类型不从这两项外推。

工具任务会用原生输入走到可达邻格，释放移动，再进入 `Farmer.BeginUsingTool` 与游戏动画回调。没有直接 `DoFunction/DoDamage` 捷径，也不写动画帧、位置或奖励来制造完成。树砍倒时可能把健康值重设为树桩值；倒伏/树桩转变也要记录为真实效果。

queued/running/settling 都不是完成。旅行的 rejected/interrupted 作为确定失败返回；原生 unknown 或缺少必要效果证明会保留 outcome-unknown 和资源隔离。只有信任协议、ID 匹配的显式 `{status:'rejected', notApplied:true}` 能证明命令在发送前被拒绝；普通 MCP 错误、写入失败或超时不能据此释放未知资源。已经开始的原生动画可以在取消请求后产生效果，不承诺回滚。

## 架构与后续桌面端

DSH 层只负责工具发现、稳定操作身份、后台观察、取消、资源互斥与会话通知。游戏侧的 session/action/input 控制器不依赖语音或 DSH；未来桌面端可以复用相同 MCP 生命周期与 native scope，替换宿主的任务和语音适配器。后台权限与真实焦点始终分开，不能把桌面窗口激活当作后台实现。

## 本轮验收

Windows，Stardew Valley 1.6.15.24356 / SMAPI 4.5.2。使用隔离数据目录与存档副本，两条原生/SMAPI 保存路径均经验证；13 个原始保存文件哈希保持不变。

- 无人工菜单/按键辅助的 native host + 后台 LAN join，真实独立 farmhand。
- AI 全程失焦从小屋走到农场；完整回归区间共 2,080 个更新采样、328 个不同的位置/地图观察。
- 成熟树及树桩共 15 次原生挥斧全部完成并验证效果；每次 30 个 UsingTool 采样，帧 66–70 全部推进。
- 主人前台实例接收到 479 个远端工具动画采样，包含上述斧头帧与锄头帧 48–52。
- 原生移动后锄地成功 1 格；途中取消在挥击前停稳；同 ID 重放返回 duplicate。
- 148 项 C# 检查、51 项 MCP 协议测试、后台输入清零/替换检查、4 项地图解析检查及 DSH task/foreground 检查通过。最终构建 0 warnings / 0 errors。

原生 DLL SHA-256：`5F3BDAEC0015FA9C38D9FA0F76A5CF1FDD24219832F9B99D921387F103645BC5`。已备份原 DLL/config，并将验收版本放入两个真实 Mods 目录；DSH 本地插件链接仍指向此仓库。陪玩技能也同步了新入口与后台范围。游戏退出后 bridge 文件会残留，不能以旧快照证明仍在线。

测试期间没有重启主 DSH、向主对话插入消息或打断用户语音通话。更新代码后重启 DSH 与两个游戏实例，让宿主重新加载适配器、MCP 工具列表和游戏 DLL。边框全屏窗口的桌面截图有时滞留旧帧，本轮动画结论来自实际游戏逐更新状态与主机收到的远端帧，不声称截图捕获链也已通过。硬件按键注入被 IME 截获的试验未计为通过；后台钓鱼、全部工具变体与联机过夜仍需各自场景验收。
