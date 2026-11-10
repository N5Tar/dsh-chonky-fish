// Opt-in foreground validation. Never included in npm test; no window activation,
// user database writes, titles, URLs, or input contents. Observe natural switches.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, isAbsolute } from 'node:path'
import { createResources } from '../../resources/index.js'
const execute = promisify(execFile)
const options = process.argv.slice(2)
if (options.some(x => !/^--observe=\d+$/.test(x) && !x.startsWith('--baseline='))) throw new Error('Usage: run-live.mjs --observe=45 [--baseline=/absolute/old-collector]')
const seconds = Number(options.find(x => x.startsWith('--observe='))?.split('=')[1])
if (!Number.isInteger(seconds) || seconds < 15 || seconds > 120) throw new Error('Explicit --observe=15..120 required; this reads app identities only')
const target = createResources().perceptionCollector()
if (!target.supported) throw new Error('macOS foreground validation only')
const baselinePath = options.find(x => x.startsWith('--baseline='))?.slice('--baseline='.length)
if (baselinePath && !isAbsolute(baselinePath)) throw new Error('Baseline path must be absolute')
const children = [], pending = new Set(), records = []
let baseline = null, finish, fatal = null, stopped = false, previousCandidate = null, beforeQuery = null, beforeTimer
const done = new Promise(r => { finish = r })
const script = 'ObjC.import("AppKit"); var a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({id:ObjC.unwrap(a.bundleIdentifier),name:ObjC.unwrap(a.localizedName)})'
async function fresh() { return JSON.parse((await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 3000, maxBuffer: 16384 })).stdout) }
function launch(path, onSample) {
  const child = spawn(resolve(path), [], { stdio: ['pipe','pipe','pipe'], shell: false })
  const entry = { child, buffer: '', closed: false, expected: false }
  children.push(entry)
  child.stdout.setEncoding('utf8')
  child.stderr.resume()
  child.stdout.on('data', chunk => {
    entry.buffer += chunk
    if (entry.buffer.length > 65536) { fatal = new Error('Collector output overflow'); finish(); return }
    let index
    while ((index = entry.buffer.indexOf('\n')) !== -1) {
      const line = entry.buffer.slice(0,index); entry.buffer = entry.buffer.slice(index+1)
      try { onSample(JSON.parse(line)) } catch (error) { fatal = error; finish() }
    }
  })
  child.on('error', error => { fatal = error; finish() })
  entry.close = new Promise(r => child.once('close', (code, signal) => { entry.closed = true; if (!entry.expected && !stopped) { fatal = new Error(`Collector exited early: ${code}/${signal}`); finish() }; r() }))
}
async function captureBefore() {
  const app = await fresh()
  beforeQuery = { ...app, finishedAtMs: Date.now() }
}
async function observe(sample, before) {
  const first = await fresh(), second = await fresh()
  // Both queries used to run AFTER the sample: a real switch in that interval
  // could look like a defect. Require an independent query on each side now.
  const bracketed = before && before.finishedAtMs <= sample.observedAtMs && sample.observedAtMs - before.finishedAtMs < 7000
  const stable = Boolean(bracketed && before.id === first.id && first.id === second.id)
  const item = { checkedAt: new Date().toISOString(), seq: sample.seq, ageMs: Date.now()-sample.observedAtMs,
    candidate: sample.foregroundApp?.id ?? null, baseline: baseline?.foregroundApp?.id ?? null,
    systemBefore: before?.id ?? null, beforeQueryAtMs: before?.finishedAtMs ?? null,
    sampledAtMs: sample.observedAtMs, systemAfter: first.id, systemConfirm: second.id, stable,
    candidateMatches: stable ? sample.foregroundApp?.id === first.id : null }
  if (previousCandidate !== null && previousCandidate !== item.candidate) item.candidateSwitch = true
  previousCandidate = item.candidate
  records.push(item); console.log(JSON.stringify(item))
}
let timer
try {
  await captureBefore()
  if (baselinePath) launch(baselinePath, sample => { baseline = sample })
  launch(target.binaryPath, sample => {
    const task = observe(sample, beforeQuery).catch(error => { fatal=error;finish() }).finally(() => pending.delete(task))
    pending.add(task)
    clearTimeout(beforeTimer)
    beforeTimer = setTimeout(() => {
      if (stopped) return
      const pre = captureBefore().catch(error => { fatal=error;finish() }).finally(() => pending.delete(pre))
      pending.add(pre)
    }, 3500)
  })
  timer = setTimeout(finish, seconds*1000)
  await done
} finally {
  stopped = true; clearTimeout(timer); clearTimeout(beforeTimer)
  for (const entry of children) {
    entry.expected = true
    if (!entry.closed) entry.child.stdin.end()
  }
  const kill = setTimeout(() => { for(const entry of children) if(!entry.closed) entry.child.kill('SIGKILL') }, 3000)
  await Promise.all(children.map(x=>x.close));clearTimeout(kill)
  await Promise.all(pending)
}
if(fatal) throw fatal
const stable=records.filter(x=>x.stable), identities=[...new Set(stable.map(x=>x.systemBefore))]
const mismatch=stable.filter(x=>!x.candidateMatches)
const result={type:'result',samples:records.length,stableChecks:stable.length,systemIdentities:identities,candidateMismatches:mismatch.length,
  baselineMismatches:baselinePath?stable.filter(x=>x.baseline!==x.systemBefore).length:null,
  verdict:stable.length>=3&&identities.length>=2&&mismatch.length===0?'PASS_FOREGROUND_SWITCHES':mismatch.length?'MISMATCH':'INCONCLUSIVE_NO_NATURAL_SWITCH',
  realActivityMetadata:true,autoActivatedWindows:false,storedInUserDatabase:false}
console.log(JSON.stringify(result))
if (mismatch.length || stable.length < 3) process.exitCode=1
else if(identities.length<2) process.exitCode=2
