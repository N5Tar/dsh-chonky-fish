/**
 * @param {{ episodes?: any[], summary?: any }} page activities HTTP 页（可带 ok 包装）
 */
export function summarizeChatOwner(page) {
  if (!page || typeof page !== 'object') throw new TypeError('activities page required')
  const episodes = Array.isArray(page.episodes) ? page.episodes : []
  const chatSamples = []
  const otherIntents = {}
  let blockedOrSuppressed = 0

  for (const episode of episodes) {
    const selection = episode?.actionSelection
    if (!selection) continue
    const intent = selection.intent
    const status = selection.dispatchStatus
    if (intent == null || status === 'suppressed') {
      blockedOrSuppressed += 1
      continue
    }
    if (intent !== 'chat_owner') {
      const bucket = otherIntents[intent] ?? { enqueued: 0, other: 0 }
      if (status === 'enqueued') bucket.enqueued += 1
      else bucket.other += 1
      otherIntents[intent] = bucket
      continue
    }
    if (status !== 'enqueued') continue
    chatSamples.push({
      episodeId: episode.id,
      wakeAt: episode.wakeAt ?? null,
      score: selection.score ?? null,
      reason: selection.reason ?? null,
      visibleAt: selection.visibleAt ?? null,
      resolutionReason: selection.resolutionReason ?? null,
      choiceSummary:
        typeof episode.choice?.summary === 'string' ? episode.choice.summary.slice(0, 80) : null,
      result: episode.result ?? episode.outcome ?? null,
    })
  }

  const withVisibleReply = chatSamples.filter((row) => row.visibleAt).length
  return {
    chatOwner: {
      enqueued: chatSamples.length,
      withVisibleReply,
      withoutVisibleReply: chatSamples.length - withVisibleReply,
      samples: chatSamples,
    },
    otherIntents,
    blockedOrSuppressed,
    pageSummary: page.summary ?? null,
  }
}