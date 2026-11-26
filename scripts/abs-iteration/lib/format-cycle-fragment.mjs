/**
 * @param {{ cycleId: string, capturedAt: string, abs: object, chatSummary: ReturnType<import('./summarize-chat-owner.mjs').summarizeChatOwner> }} input
 * @returns {string}
 */
export function formatCycleFragment({ cycleId, capturedAt, abs, chatSummary }) {
  const cfg = abs?.state?.config ?? abs?.config ?? {}
  const liveSocial = abs?.state?.drives?.social ?? {}
  const socialCfg = cfg.drives?.social ?? {}
  const socialSat = liveSocial.satisfaction ?? socialCfg.satisfaction
  const socialSet = liveSocial.setpoint ?? socialCfg.setpoint
  const socialDecay = liveSocial.decayPerHour ?? socialCfg.decayPerHour
  const lines = [
    `## Baseline fragment · ${cycleId}`,
    `- capturedAt: ${capturedAt}`,
    `- mode: ${cfg.mode ?? abs?.state?.mode ?? 'unknown'}`,
    `- timeScale: ${cfg.timeScale ?? abs?.state?.clockView?.timeScale ?? 'unknown'}`,
    `- reviewIntervalMinutes: ${cfg.reviewIntervalMinutes ?? 'unknown'}`,
    `- reviewMinRealGapMinutes: ${cfg.reviewMinRealGapMinutes ?? 'unknown'}`,
    `- restHours: ${cfg.restHours ? `${cfg.restHours.enabled} ${cfg.restHours.start}-${cfg.restHours.end}` : 'unknown'}`,
    `- social: sat=${socialSat ?? '?'} set=${socialSet ?? '?'} decay/h=${socialDecay ?? '?'}`,
    `- chat_owner enqueued: ${chatSummary.chatOwner.enqueued}`,
    `- chat_owner visibleReply: ${chatSummary.chatOwner.withVisibleReply}`,
    `- blockedOrSuppressed: ${chatSummary.blockedOrSuppressed}`,
    '',
    '### Samples (desensitized)',
  ]
  for (const sample of chatSummary.chatOwner.samples) {
    lines.push(
      `- ${sample.episodeId} @ ${sample.wakeAt}: choice="${sample.choiceSummary ?? ''}" visibleAt=${sample.visibleAt ?? 'null'} result=${sample.result ?? 'null'}`,
    )
  }
  lines.push('', '_Reply excerpts ≤80 chars: fill manually in cycle md; not present in ABS activities API._')
  return lines.join('\n')
}