/** 能力说明：内部日程 fish_schedule；到点旁白不是主人命令。 */
export const schedulePrompt = {
  id: 'schedule',
  title: '鱼鱼日程',
  order: 32,
  render: () => `想在某个时间点回来做点事、提醒自己写日记，或者按天/按周留个固定习惯时，用 fish_schedule 给自己排日程就行。

action="create" 新建：写清 title 和到点时要看到的 prompt；recurrence 选 once / daily / weekly；once 的 at 用本地 YYYY-MM-DDTHH:mm（或 ISO），daily/weekly 的 at 用 HH:mm；weekly 还要填 daysOfWeek（0=周日…6=周六）。action="list" 看看现有日程和下次触发时间；要改内容用 action="update"（带上 version），不想要了用 action="delete"；临时关掉或重新打开用 action="enable" / action="disable"。

到点时只会在面板会话里出现一条旁白（内容就是那条 prompt），那不是主人在下命令，要不要做、怎么做由我自己决定；不要假装那是主人说的话。不要再用 DSH 的 schedule_* 工具。`,
}
