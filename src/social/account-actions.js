import { fail, plain } from './core.js'

/** QQ 账号操作目录：只暴露明确列出的动作，不接受任意 OneBot action。
 * 读操作可直接做；写操作由服务层限速，工具描述与 social preset 都要求“主人明确要求才做”。 */
const MAX_LIST = 80
const MAX_QZONE = 20
const MAX_RESULT_CHARS = 12000

function bad() { fail('SOCIAL_INVALID_INPUT') }
function has(value) { return value !== undefined && value !== null }
function only(input, allowed) {
  if (!plain(input) || Object.keys(input).some(key => !allowed.includes(key))) bad()
}
function int(value, min, max, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    bad()
  }
  let number = NaN
  if (typeof value === 'number') number = value
  else if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) bad()
  return number
}
function qq(value) { return int(value, 1, Number.MAX_SAFE_INTEGER) }
function optionalQq(value) { return has(value) && value !== '' ? qq(value) : undefined }
function string(value, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim().length === 0)) bad()
  return allowEmpty ? value : value.trim()
}
function optionalString(value, max, options) { return has(value) ? string(value, max, options) : undefined }
function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') bad()
  return value
}
function images(value) {
  if (!has(value)) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > 9) bad()
  return value.map(item => string(item, 4096))
}
function uins(value, { required = false } = {}) {
  if (!has(value)) {
    if (required) bad()
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) bad()
  return value.map(item => qq(item))
}
function ugcRight(value, targetUins) {
  const right = int(value, 1, 128, 1)
  if (![1, 4, 16, 64, 128].includes(right)) bad()
  if ((right === 16 || right === 128) && (!Array.isArray(targetUins) || targetUins.length === 0)) bad()
  return right
}
function atLeastOne(input, names) {
  if (!names.some(name => has(input[name]))) bad()
}

function truncate(value, max) {
  return typeof value === 'string' && value.length > max ? value.slice(0, max) + '…' : value
}
function pick(source, keys) {
  const out = {}
  if (!plain(source)) return out
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

function friendSummary(row) { return pick(row, ['user_id', 'nickname', 'remark']) }
function groupSummary(row) { return pick(row, ['group_id', 'group_name', 'group_remark', 'member_count', 'max_member_count']) }
function memberSummary(row) { return pick(row, ['user_id', 'nickname', 'card', 'role', 'join_time', 'last_sent_time']) }
function groupInfoSummary(row) {
  return pick(row, ['group_id', 'group_name', 'group_remark', 'member_count', 'max_member_count', 'group_create_time', 'group_memo', 'group_description', 'group_all_shut'])
}
function profileSummary(row) {
  return pick(row, ['user_id', 'qid', 'nickname', 'remark', 'sex', 'age', 'long_nick', 'qq_level', 'level', 'reg_time', 'is_vip', 'is_years_vip', 'vip_level'])
}
function qzoneProfileSummary(row) { return pick(row, ['name', 'description']) }

function listSummary(data, input, mapper) {
  if (!Array.isArray(data)) return data
  const offset = input.offset || 0
  const limit = input.limit || MAX_LIST
  const items = data.slice(offset, offset + limit).map(mapper)
  return { total: data.length, offset, returned: items.length, items, truncated: offset + items.length < data.length }
}

function qzoneMessage(row) {
  if (!plain(row)) return row
  return {
    ...pick(row, ['tid', 'time', 'comment_num', 'is_private']),
    content: truncate(row.content, 500),
    images: Array.isArray(row.images) ? row.images.slice(0, 3) : [],
  }
}
function qzoneComment(row) {
  if (!plain(row)) return row
  const out = { ...pick(row, ['comment_id', 'uin', 'name', 'time']), content: truncate(row.content, 300) }
  if (Array.isArray(row.replies) && row.replies.length > 0) {
    out.replies = row.replies.slice(0, 5).map(reply => ({
      ...pick(reply, ['comment_id', 'uin', 'name', 'time', 'parent_comment_id', 'parent_comment_uin']),
      content: truncate(reply.content, 200),
    }))
  }
  return out
}
function qzoneFeed(row) {
  if (!plain(row)) return row
  return {
    ...pick(row, ['uin', 'name', 'tid', 'time']),
    content: truncate(row.content, 500),
    images: Array.isArray(row.images) ? row.images.slice(0, 3) : [],
  }
}

export const ACCOUNT_ACTIONS = Object.freeze({
  get_self_profile: {
    readOnly: true,
    allowed: [],
    validate: input => { only(input, []); return {} },
    // 自己的 QQ 号来自已核验身份，不接受模型传入。
    run: (entry) => entry.driver.callAction('get_stranger_info', { user_id: qq(entry.verified.identity.protocolUserId) }),
    summarize: profileSummary,
  },
  get_stranger_info: {
    readOnly: true,
    allowed: ['user_id'],
    validate: input => { only(input, ['user_id']); return { user_id: qq(input.user_id) } },
    run: (entry, params) => entry.driver.callAction('get_stranger_info', params),
    summarize: profileSummary,
  },
  get_friend_list: {
    readOnly: true,
    allowed: ['offset', 'limit'],
    validate: input => { only(input, ['offset', 'limit']); return { offset: int(input.offset, 0, 100000, 0), limit: int(input.limit, 1, MAX_LIST, MAX_LIST) } },
    run: entry => entry.driver.callAction('get_friend_list'),
    summarize: (data, input) => listSummary(data, input, friendSummary),
  },
  get_group_list: {
    readOnly: true,
    allowed: ['no_cache', 'offset', 'limit'],
    validate: input => {
      only(input, ['no_cache', 'offset', 'limit'])
      return { no_cache: bool(input.no_cache), offset: int(input.offset, 0, 100000, 0), limit: int(input.limit, 1, MAX_LIST, MAX_LIST) }
    },
    run: (entry, input) => entry.driver.callAction('get_group_list', { no_cache: input.no_cache }),
    summarize: (data, input) => listSummary(data, input, groupSummary),
  },
  get_group_member_list: {
    readOnly: true,
    allowed: ['group_id', 'offset', 'limit'],
    validate: input => {
      only(input, ['group_id', 'offset', 'limit'])
      return { group_id: qq(input.group_id), offset: int(input.offset, 0, 100000, 0), limit: int(input.limit, 1, MAX_LIST, MAX_LIST) }
    },
    run: (entry, input) => entry.driver.callAction('get_group_member_list', { group_id: input.group_id }),
    summarize: (data, input) => listSummary(data, input, memberSummary),
  },
  get_group_member_info: {
    readOnly: true,
    allowed: ['group_id', 'user_id'],
    validate: input => { only(input, ['group_id', 'user_id']); return { group_id: qq(input.group_id), user_id: qq(input.user_id) } },
    run: (entry, params) => entry.driver.callAction('get_group_member_info', params),
    summarize: memberSummary,
  },
  get_group_info: {
    readOnly: true,
    allowed: ['group_id'],
    validate: input => { only(input, ['group_id']); return { group_id: qq(input.group_id) } },
    run: (entry, params) => entry.driver.callAction('get_group_info', params),
    summarize: groupInfoSummary,
  },
  get_profile_like: {
    readOnly: true,
    allowed: ['user_id', 'start', 'count'],
    validate: input => {
      only(input, ['user_id', 'start', 'count'])
      const params = { start: int(input.start, 0, 100000, 0), count: int(input.count, 1, 50, 10) }
      const user = optionalQq(input.user_id)
      if (user !== undefined) params.user_id = user
      return params
    },
    run: (entry, params) => entry.driver.callAction('get_profile_like', params),
    summarize: data => {
      if (!plain(data)) return data
      const trimUsers = list => Array.isArray(list) ? list.slice(0, 20) : list
      return {
        favoriteInfo: plain(data.favoriteInfo) ? {
          total_count: data.favoriteInfo.total_count,
          last_time: data.favoriteInfo.last_time,
          today_count: data.favoriteInfo.today_count,
          userInfos: trimUsers(data.favoriteInfo.userInfos),
        } : undefined,
        voteInfo: plain(data.voteInfo) ? {
          total_count: data.voteInfo.total_count,
          new_count: data.voteInfo.new_count,
          new_nearby_count: data.voteInfo.new_nearby_count,
          last_visit_time: data.voteInfo.last_visit_time,
          userInfos: trimUsers(data.voteInfo.userInfos),
        } : undefined,
      }
    },
  },
  get_qzone_profile: {
    readOnly: true,
    allowed: [],
    validate: input => { only(input, []); return {} },
    run: entry => entry.driver.callAction('get_qzone_profile'),
    summarize: qzoneProfileSummary,
  },
  get_qzone_msg_list: {
    readOnly: true,
    allowed: ['target_uin', 'pos', 'num'],
    validate: input => {
      only(input, ['target_uin', 'pos', 'num'])
      const params = { pos: int(input.pos, 0, 100000, 0), num: int(input.num, 1, MAX_QZONE, MAX_QZONE) }
      const target = optionalQq(input.target_uin)
      if (target !== undefined) params.target_uin = target
      return params
    },
    run: (entry, params) => entry.driver.callAction('get_qzone_msg_list', params),
    summarize: data => {
      if (!plain(data)) return data
      const list = Array.isArray(data.msglist) ? data.msglist : []
      return { total: data.total, returned: Math.min(list.length, MAX_QZONE), items: list.slice(0, MAX_QZONE).map(qzoneMessage) }
    },
  },
  get_qzone_msg_detail: {
    readOnly: true,
    allowed: ['tid', 'target_uin', 'pos', 'num'],
    validate: input => {
      only(input, ['tid', 'target_uin', 'pos', 'num'])
      const params = { tid: string(input.tid, 256), pos: int(input.pos, 0, 100000, 0), num: int(input.num, 1, MAX_QZONE, MAX_QZONE) }
      const target = optionalQq(input.target_uin)
      if (target !== undefined) params.target_uin = target
      return params
    },
    run: (entry, params) => entry.driver.callAction('get_qzone_msg_detail', params),
    summarize: data => {
      if (!plain(data)) return data
      return {
        ...pick(data, ['tid', 'comment_num']),
        content: truncate(data.content, 500),
        comments: Array.isArray(data.comments) ? data.comments.slice(0, 30).map(qzoneComment) : [],
      }
    },
  },
  get_qzone_feeds: {
    readOnly: true,
    allowed: ['page_num', 'count', 'cursor'],
    validate: input => {
      only(input, ['page_num', 'count', 'cursor'])
      const params = { page_num: int(input.page_num, 1, 10000, 1), count: int(input.count, 1, MAX_QZONE, 10) }
      const cursor = optionalString(input.cursor, 1024)
      if (cursor !== undefined) params.cursor = cursor
      return params
    },
    run: (entry, params) => entry.driver.callAction('get_qzone_feeds', params),
    summarize: data => {
      if (!plain(data)) return data
      return {
        feeds: Array.isArray(data.feeds) ? data.feeds.slice(0, 10).map(qzoneFeed) : [],
        has_more: data.has_more,
        next_cursor: data.next_cursor,
      }
    },
  },
  set_qq_profile: {
    readOnly: false,
    allowed: ['nickname', 'personal_note', 'sex'],
    validate: input => {
      only(input, ['nickname', 'personal_note', 'sex'])
      atLeastOne(input, ['nickname', 'personal_note', 'sex'])
      const params = {}
      if (has(input.nickname)) params.nickname = string(input.nickname, 80)
      if (has(input.personal_note)) params.personal_note = string(input.personal_note, 200, { allowEmpty: true })
      if (has(input.sex)) params.sex = int(input.sex, 0, 2)
      return params
    },
    run: (entry, params) => entry.driver.callAction('set_qq_profile', params),
  },
  set_qq_avatar: {
    readOnly: false,
    allowed: ['file'],
    validate: input => { only(input, ['file']); return { file: string(input.file, 4096) } },
    run: (entry, params) => entry.driver.callAction('set_qq_avatar', params),
  },
  set_self_longnick: {
    readOnly: false,
    allowed: ['long_nick'],
    validate: input => { only(input, ['long_nick']); return { long_nick: string(input.long_nick, 200, { allowEmpty: true }) } },
    run: (entry, params) => entry.driver.callAction('set_self_longnick', params),
  },
  set_qzone_profile: {
    readOnly: false,
    allowed: ['name', 'description'],
    validate: input => {
      only(input, ['name', 'description'])
      atLeastOne(input, ['name', 'description'])
      const params = {}
      if (has(input.name)) params.name = string(input.name, 80, { allowEmpty: true })
      if (has(input.description)) params.description = string(input.description, 200, { allowEmpty: true })
      return params
    },
    run: (entry, params) => entry.driver.callAction('set_qzone_profile', params),
  },
  send_qzone_msg: {
    readOnly: false,
    allowed: ['content', 'images', 'ugc_right', 'target_uins'],
    validate: input => {
      only(input, ['content', 'images', 'ugc_right', 'target_uins'])
      const targetUins = uins(input.target_uins)
      const params = { content: string(input.content, 5000), ugc_right: ugcRight(input.ugc_right, targetUins) }
      const pictureList = images(input.images)
      if (pictureList !== undefined) params.images = pictureList
      if (targetUins !== undefined) params.target_uins = targetUins
      return params
    },
    run: (entry, params) => entry.driver.callAction('send_qzone_msg', params),
  },
  delete_qzone_msg: {
    readOnly: false,
    allowed: ['tid'],
    validate: input => { only(input, ['tid']); return { tid: string(input.tid, 256) } },
    run: (entry, params) => entry.driver.callAction('delete_qzone_msg', params),
  },
  set_qzone_msg_right: {
    readOnly: false,
    allowed: ['tid', 'ugc_right', 'target_uins'],
    validate: input => {
      only(input, ['tid', 'ugc_right', 'target_uins'])
      const targetUins = uins(input.target_uins)
      return { tid: string(input.tid, 256), ugc_right: ugcRight(input.ugc_right, targetUins), ...(targetUins !== undefined ? { target_uins: targetUins } : {}) }
    },
    run: (entry, params) => entry.driver.callAction('set_qzone_msg_right', params),
  },
  like_qzone: {
    readOnly: false,
    allowed: ['tid', 'target_uin', 'abstime'],
    validate: input => {
      only(input, ['tid', 'target_uin', 'abstime'])
      const params = { tid: string(input.tid, 256), abstime: int(input.abstime, 0, 4102444800, 0) }
      const target = optionalQq(input.target_uin)
      if (target !== undefined) params.target_uin = target
      return params
    },
    run: (entry, params) => entry.driver.callAction('like_qzone', params),
  },
  unlike_qzone: {
    readOnly: false,
    allowed: ['tid', 'target_uin', 'abstime'],
    validate: input => {
      only(input, ['tid', 'target_uin', 'abstime'])
      const params = { tid: string(input.tid, 256), abstime: int(input.abstime, 0, 4102444800, 0) }
      const target = optionalQq(input.target_uin)
      if (target !== undefined) params.target_uin = target
      return params
    },
    run: (entry, params) => entry.driver.callAction('unlike_qzone', params),
  },
  comment_qzone: {
    readOnly: false,
    allowed: ['tid', 'content', 'target_uin', 'comment_id', 'comment_uin', 'reply_uin', 'reply_name', 'images'],
    validate: input => {
      only(input, ['tid', 'content', 'target_uin', 'comment_id', 'comment_uin', 'reply_uin', 'reply_name', 'images'])
      if (has(input.comment_id) !== has(input.comment_uin)) bad()
      if (has(input.reply_uin) !== has(input.reply_name)) bad()
      if (has(input.reply_uin) && !has(input.comment_id)) bad()
      const params = { tid: string(input.tid, 256), content: string(input.content, 5000) }
      const target = optionalQq(input.target_uin)
      if (target !== undefined) params.target_uin = target
      if (has(input.comment_id)) params.comment_id = string(input.comment_id, 64, { allowEmpty: true })
      if (has(input.comment_uin)) params.comment_uin = qq(input.comment_uin)
      if (has(input.reply_uin)) params.reply_uin = qq(input.reply_uin)
      if (has(input.reply_name)) params.reply_name = string(input.reply_name, 80)
      const pictureList = images(input.images)
      if (pictureList !== undefined) params.images = pictureList
      return params
    },
    run: (entry, params) => entry.driver.callAction('comment_qzone', params),
  },
})

export const ACCOUNT_ACTION_NAMES = Object.freeze(Object.keys(ACCOUNT_ACTIONS))

/** 兜底：单次工具结果不超过约 12k 字符，避免把受限会话的上下文撑爆。 */
export function capAccountResult(value) {
  let json
  try { json = JSON.stringify(value) } catch { return { truncated: true, note: '结果无法序列化' } }
  if (typeof json !== 'string' || json.length <= MAX_RESULT_CHARS) return value
  return { truncated: true, note: '结果过长，已截断；缩小 limit/count 或分页再看。', preview: json.slice(0, MAX_RESULT_CHARS) }
}
