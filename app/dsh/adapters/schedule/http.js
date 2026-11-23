/**
 * 日程只读 HTTP：仅 GET。
 */

export async function handleScheduleRequest({ service, method }) {
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, body: { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' } } }
  }
  try {
    const listed = await service.list()
    return {
      status: 200,
      body: {
        ok: true,
        timezoneDefault: listed.timezoneDefault,
        items: listed.items.map((item) => ({
          id: item.id,
          enabled: item.enabled,
          title: item.title,
          prompt: item.prompt,
          recurrence: item.recurrence,
          at: item.at,
          timezone: item.timezone,
          daysOfWeek: Array.isArray(item.daysOfWeek) ? item.daysOfWeek : null,
          nextFireAt: item.nextFireAt ?? null,
          lastFiredAt: item.lastFiredAt ?? null,
          backoffUntil: item.backoffUntil ?? null,
          version: item.version,
        })),
      },
    }
  } catch (error) {
    return {
      status: 503,
      body: {
        ok: false,
        error: {
          code: error?.code || 'INTERNAL',
          message: error?.message || '日程不可用',
        },
      },
    }
  }
}
