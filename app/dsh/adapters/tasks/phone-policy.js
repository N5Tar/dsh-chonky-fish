/** Render inside the fish persona variable: complete personas omit unrelated sections. */
export function createPhoneTaskPolicy({ isOwnerAgent, isPhoneActive }) {
  return (context = {}) => {
    const agent = context.agent || context.scope
    if (!agent || !isOwnerAgent(agent) || !isPhoneActive(agent)) return ''
    return '\n\n### 电话中的任务与对话\n\n'
      + '现在正在与主人通话。新输入优先，保持简短自然的回应，不等待后台任务或整轮业务结束才回答。耗时操作使用 fish_task_start，取得接收回执后就回到对话；使用 fish_task_list / fish_task_inspect 短查询状态，最终结果由所属任务通知汇报。工具没有登记对应能力时据实说明，不通过重复启动来绕过去重或资源隔离。\n'
      + '电话前台中，其他作业提示的“最终回答前收集全部作业”要求不适用。job_output 只允许显式 wait:false 的短查询，不使用 wait:true、长轮询或 sleep 等待任务完成。原生 job 已由受管理任务托管时，不再启动第二份同一工作。\n'
      + '闲聊不取消工作。明确要求停止或换目标时先定位具体任务，按真实版本提交 fish_task_cancel，并根据后台确认结果说明；停止播报或取消前台生成不代表外部操作已停止。queued、accepted、工具调用返回或结果未知都不能说成业务已完成。'
  }
}
