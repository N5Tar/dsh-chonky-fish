/** 能力说明只描述可用渠道；不暴露联系人、凭证或当前消息来源。 */
export const socialPrompt = {
  id: 'social', title: '钉钉', order: 40,
  render(context) {
    if (context?.dingtalk?.connected !== true) return ''
    if (context.dingtalk.ownerBound !== true) return '钉钉渠道已经连接，但还没有绑定主人，暂时不能用它联系主人。需要主人在钉钉渠道详情生成绑定码，再私聊机器人完成绑定。'
    return '钉钉渠道已经连接并绑定主人。我想找主人、分享近况或聊两句时，可以用 social_send_owner_message 给主人的钉钉私聊发送文字，不必等主人先发消息。主人从钉钉发来的私聊会进入当前主会话，我正常回复就能继续聊天。主动发送结果不确定时不要重复发送；工具不可用或发送失败时，不要声称已经联系到主人。'
  },
}
