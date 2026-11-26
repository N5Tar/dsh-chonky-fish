#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeChatOwner } from './lib/summarize-chat-owner.mjs'
import { formatCycleFragment } from './lib/format-cycle-fragment.mjs'

const USAGE = `Usage: node scripts/abs-iteration/snapshot.mjs --date YYYY-MM-DD [--cycle ID] [--out path.json]
Requires env CHONKYFISH_HTTP_BASE (e.g. http://127.0.0.1:<dsh-port>), no default.`

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

function parseArgs(argv) {
  const out = { date: null, cycle: null, out: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--date') {
      out.date = argv[++i] ?? null
      continue
    }
    if (arg === '--cycle') {
      out.cycle = argv[++i] ?? null
      continue
    }
    if (arg === '--out') {
      out.out = argv[++i] ?? null
      continue
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    console.error(`Unknown argument: ${arg}`)
    console.error(USAGE)
    process.exit(2)
  }
  return out
}

function hostOnly(baseUrl) {
  const url = new URL(baseUrl)
  return url.port ? `${url.hostname}:${url.port}` : url.hostname
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200)
    throw Object.assign(new Error(`HTTP ${response.status} ${url}${body ? `: ${body}` : ''}`), {
      status: response.status,
    })
  }
  return response.json()
}

async function fetchActivities(base, date) {
  const episodes = []
  let summary = null
  let window = null
  let snapshotSeq = null
  let cursor = null
  const maxPages = 5

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const url = new URL(`${base.replace(/\/$/, '')}/chonkyfish/abs/activities`)
    url.searchParams.set('date', date)
    url.searchParams.set('limit', '100')
    if (cursor) {
      url.searchParams.set('beforeWakeAt', cursor.wakeAt)
      url.searchParams.set('beforeEpisodeId', cursor.episodeId)
      if (snapshotSeq != null) url.searchParams.set('snapshotSeq', String(snapshotSeq))
    }

    const page = await fetchJson(url.href)
    if (summary == null) summary = page.summary ?? null
    if (window == null) window = page.window ?? null
    if (Array.isArray(page.episodes)) episodes.push(...page.episodes)

    const pageMeta = page.page ?? {}
    if (snapshotSeq == null && pageMeta.snapshotSeq != null) snapshotSeq = pageMeta.snapshotSeq
    if (!pageMeta.hasMore) break
    const next = pageMeta.nextCursor
    if (!next?.wakeAt || !next?.episodeId) {
      throw new Error('activities page.hasMore without nextCursor')
    }
    cursor = next
    if (pageIndex === maxPages - 1 && pageMeta.hasMore) {
      console.error(`warning: stopped after ${maxPages} activities pages; more data may exist`)
    }
  }

  return { summary, episodes, window }
}

function writeAtomic(finalPath, payload) {
  mkdirSync(dirname(finalPath), { recursive: true })
  const tmpPath = `${finalPath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, finalPath)
}

async function main() {
  const base = process.env.CHONKYFISH_HTTP_BASE?.trim()
  if (!base) {
    console.error('Missing CHONKYFISH_HTTP_BASE')
    console.error(USAGE)
    process.exit(2)
  }

  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.error(USAGE)
    process.exit(2)
  }
  if (!args.date) {
    console.error('Missing required --date YYYY-MM-DD')
    console.error(USAGE)
    process.exit(2)
  }

  const cycleId = args.cycle || `${args.date}-R00`
  const outPath = args.out
    ? (args.out.startsWith('/') ? args.out : join(process.cwd(), args.out))
    : join(repoRoot, 'docs/abs-iteration/snapshots', `${cycleId}.json`)

  let inspect
  let activities
  try {
    inspect = await fetchJson(`${base.replace(/\/$/, '')}/chonkyfish/abs`)
    activities = await fetchActivities(base, args.date)
  } catch (err) {
    console.error(err?.message || String(err))
    process.exit(1)
  }

  const capturedAt = new Date().toISOString()
  const snap = {
    cycleId,
    capturedAt,
    httpBaseHostOnly: hostOnly(base),
    abs: {
      state: inspect.state ?? null,
      environment: inspect.environment ?? null,
    },
    activities: {
      summary: activities.summary,
      episodes: activities.episodes,
      window: activities.window,
    },
  }

  try {
    writeAtomic(outPath, snap)
  } catch (err) {
    console.error(err?.message || String(err))
    process.exit(1)
  }

  const chatSummary = summarizeChatOwner(snap.activities)
  const md = formatCycleFragment({
    cycleId: snap.cycleId,
    capturedAt: snap.capturedAt,
    abs: snap.abs,
    chatSummary,
  })
  process.stdout.write(md + '\n')
}

main().catch((err) => {
  console.error(err?.message || String(err))
  process.exit(1)
})
