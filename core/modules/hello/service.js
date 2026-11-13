import { HELLO_PRESET, clone, fail, keys, validateDraft } from './schema.js'
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b)
const STEPS = ['panel','abs','perception']
export function createHelloService({ store, panel, abs, perception, social, isMigrationBusy = () => false, now = () => new Date().toISOString() }) {
  let chain = Promise.resolve(), closed = false
  const serial = fn => { if (closed) return Promise.reject(fail('HELLO_CLOSED')); const task = chain.then(() => { check(); return fn() }); chain = task.catch(() => {}); return task }
  const check = () => { if (closed) throw fail('HELLO_CLOSED'); if (isMigrationBusy()) throw fail('MIGRATION_BUSY') }
  async function current() { check(); return { panel: await panel.read(), abs: await abs.readSettings(), perception: await perception.inspect(), social: social ? await social.inspect() : null } }
  const sources = c => ({ panelGeneration: c.panel.generation, absRevision: c.abs.revision, perceptionRequested: c.perception.requested, perceptionControlRevision: c.perception.controlRevision ?? null })
  async function persist(state) { const revision = state.revision; state.revision++; await store.write(state, revision); return state }
  async function load() {
    let state = await store.read()
    if (!state) {
      const c = await current(), p = c.panel.state || {}
      // Any persisted panel data or requested perception protects an existing installation.
      const existing = Object.keys(p).length > 0 || c.panel.generation > 0 || c.perception.requested || Boolean(c.social?.configured || c.social?.dingtalk?.connected || c.social?.dingtalk?.ownerBound)
      state = { schemaVersion: 1, flowVersion: 'hello-v1', revision: 0, status: 'draft', step: 'welcome', entryKind: existing ? 'existing' : 'new', draft: { name: p.name || '大肥鱼', prompt: typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt : HELLO_PRESET.body, perceptionRequested: null, abs: { timeScale: c.abs.timeScale, restHours: clone(c.abs.restHours) } }, operations: [], baseCompletedAt: null, dingtalk: { status: 'not_started' } }
      validateDraft(state.draft); await store.write(state, null)
    }
    // A process may have died after its side effect and before journaling it.
    let changed = false
    for (const op of state.operations) for (const key of STEPS) if (op.steps[key].status === 'applying') { op.steps[key].status = 'unknown'; op.steps[key].error = 'HELLO_OUTCOME_UNKNOWN'; op.status = 'partial'; state.status = 'partial'; changed = true }
    if (changed) await persist(state)
    return state
  }
  const assertRevision = (s,r) => { if (s.revision !== r) throw fail('HELLO_STALE_REVISION') }
  const busy = s => s.operations.some(o => !['completed','abandoned'].includes(o.status))
  function getOperation(state, id) { const op = state.operations.find(o => o.id === id); if (!op) throw fail('HELLO_OPERATION_NOT_FOUND'); return op }
  async function execute(state, op) {
    try { return await run(state, op) }
    catch (error) { op.status = 'partial'; state.status = 'partial'; op.error = typeof error.code === 'string' ? error.code : 'HELLO_STEP_FAILED'; await persist(state); return clone(op) }
  }
  async function run(state, op) {
    for (const key of STEPS) {
      const step = op.steps[key]
      if (step.status === 'unknown') return clone(op)
      const c = await current()
      if (step.status === 'applied') {
        const observed = key === 'panel' ? c.panel : key === 'abs' ? c.abs : { requested: c.perception.requested, controlRevision: c.perception.controlRevision ?? null }
        if (!equal(observed, step.observed)) { step.error = 'HELLO_SOURCE_CHANGED'; op.status = 'partial'; state.status = 'partial'; await persist(state); return clone(op) }
        continue
      }
      if (key === 'panel' && c.panel.generation !== op.expectedSources.panelGeneration || key === 'abs' && c.abs.revision !== op.expectedSources.absRevision) { step.status = 'failed'; step.error = 'HELLO_SOURCE_CHANGED'; op.status = 'partial'; state.status = 'partial'; await persist(state); return clone(op) }
      if (key === 'perception' && (c.perception.requested !== op.expectedSources.perceptionRequested || (c.perception.controlRevision ?? null) !== op.expectedSources.perceptionControlRevision)) { step.status = 'failed'; step.error = 'HELLO_SOURCE_CHANGED'; op.status = 'partial'; state.status = 'partial'; await persist(state); return clone(op) }
      check(); step.status = 'applying'; delete step.error; await persist(state)
      try {
        check()
        if (key === 'panel') {
          const existing = c.panel.state?.prompt
          if (typeof existing === 'string' && existing.trim() && existing !== op.input.prompt) throw fail('HELLO_EXISTING_PERSONA_PROTECTED')
          await panel.patchIdentity({ expectedGeneration: c.panel.generation, name: op.input.name, ...(!(typeof existing === 'string' && existing.trim()) ? { prompt: op.input.prompt } : {}) })
          step.observed = await panel.read()
          if (step.observed.state.name !== op.input.name || (step.observed.state.prompt || '') !== (existing?.trim() ? existing : op.input.prompt)) throw fail('HELLO_VERIFY_FAILED','unknown')
        } else if (key === 'abs') {
          await abs.updateSettings({ expectedRevision: c.abs.revision, ...clone(op.input.abs) })
          step.observed = await abs.readSettings()
          if (step.observed.timeScale !== op.input.abs.timeScale || !equal(step.observed.restHours,op.input.abs.restHours) || step.observed.mode !== c.abs.mode) throw fail('HELLO_VERIFY_FAILED','unknown')
        } else {
          if (op.expectedSources.perceptionControlRevision !== null) await perception.setRequested(op.input.perceptionRequested, { expectedControlRevision: op.expectedSources.perceptionControlRevision, expectedRequested: op.expectedSources.perceptionRequested })
          else if (op.input.perceptionRequested || c.perception.requested) throw fail('HELLO_PERCEPTION_UNSUPPORTED')
          const p = await perception.inspect(); step.observed = { requested: p.requested, controlRevision: p.controlRevision ?? null }
          if (p.requested !== op.input.perceptionRequested || (p.requested && p.state !== 'running')) throw fail('HELLO_PERCEPTION_NOT_RUNNING','unknown')
        }
        step.status = 'applied'; await persist(state)
      } catch (error) {
        step.status = error.outcome === 'not_applied' ? 'failed' : 'unknown'
        step.error = typeof error.code === 'string' ? error.code : 'HELLO_STEP_FAILED'
        op.status = 'partial'; state.status = 'partial'; await persist(state); return clone(op)
      }
    }
    const final = await current()
    for (const key of STEPS) {
      const observed = key === 'panel' ? final.panel : key === 'abs' ? final.abs : { requested: final.perception.requested, controlRevision: final.perception.controlRevision ?? null }
      if (!equal(observed,op.steps[key].observed) || (key === 'perception' && op.input.perceptionRequested && final.perception.state !== 'running')) {
        op.steps[key].error = 'HELLO_SOURCE_CHANGED'; op.status = 'partial'; state.status = 'partial'; await persist(state); return clone(op)
      }
    }
    op.status = 'completed'; state.status = 'completed'; state.step = 'done'; state.baseCompletedAt = now(); await persist(state); return clone(op)
  }
  return {
    close: async () => { closed = true; await chain },
    bootstrap: () => serial(async () => { const state = await load(), c = await current(); return { state: clone(state), current: c, expectedSources: sources(c), presetPrompt: HELLO_PRESET.body, preset: HELLO_PRESET } }),
    saveDraft: input => serial(async () => {
      check(); const state = await load(); assertRevision(state,input.expectedRevision); if (busy(state)) throw fail('HELLO_OPERATION_PENDING')
      keys(input.patch,['name','prompt','perceptionRequested','abs']); const draft = { ...state.draft,...clone(input.patch) }; validateDraft(draft)
      const existing = (await panel.read()).state?.prompt
      if (existing?.trim()) {
        if (Object.hasOwn(input.patch, 'prompt') && existing !== input.patch.prompt) throw fail('HELLO_EXISTING_PERSONA_PROTECTED')
        // A draft is not authority to replace settings edited outside Hello.
        // Carry the current protected value forward when the client omits it.
        draft.prompt = existing
        validateDraft(draft)
      }
      if (input.step !== undefined && !['welcome','persona','perception','rhythm','review','done'].includes(input.step)) throw fail('HELLO_INVALID_STEP')
      state.draft = draft; state.step = input.step || state.step; if (state.status === 'completed') state.status = 'draft'
      await persist(state); return clone(state)
    }),
    applyBase: input => serial(async () => {
      check(); const state = await load()
      if (typeof input.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId)) throw fail('HELLO_INVALID_OPERATION_ID')
      const previous = state.operations.find(o => o.id === input.operationId)
      if (previous) { if (previous.requestRevision !== input.expectedRevision || !equal(previous.expectedSources,input.expectedSources)) throw fail('HELLO_OPERATION_CONFLICT'); return clone(previous) }
      assertRevision(state,input.expectedRevision); if (busy(state)) throw fail('HELLO_OPERATION_PENDING'); validateDraft(state.draft,true)
      const c = await current(); if (!equal(sources(c),input.expectedSources)) throw fail('HELLO_SOURCE_CHANGED')
      if (state.draft.perceptionRequested && !c.perception.supported) throw fail('HELLO_PERCEPTION_UNSUPPORTED')
      const op = { id: input.operationId, requestRevision: input.expectedRevision, input: clone(state.draft), expectedSources: clone(input.expectedSources), status: 'applying', steps: Object.fromEntries(STEPS.map(k => [k,{status:'pending'}])), createdAt: now() }
      // Keep all IDs to avoid replaying an evicted request; bounded capacity fails closed.
      if (state.operations.length >= 128) throw fail('HELLO_OPERATION_LIMIT')
      state.operations.push(op); state.status = 'applying'; await persist(state); return execute(state,op)
    }),
    resume: ({operationId}) => serial(async () => { check(); const s = await load(),op = getOperation(s,operationId); if (['completed','abandoned'].includes(op.status)) return clone(op); return execute(s,op) }),
    inspectOperation: input => serial(async () => clone(getOperation(await load(),typeof input === 'string' ? input : input.operationId))),
    abandon: ({operationId,expectedRevision}) => serial(async () => { const s = await load(); assertRevision(s,expectedRevision); const op = getOperation(s,operationId); if (op.status === 'completed') throw fail('HELLO_ALREADY_COMPLETED'); op.status = 'abandoned'; s.status = 'draft'; s.step = 'perception'; const c = await current(); s.draft = { name:c.panel.state.name || '大肥鱼',prompt:c.panel.state.prompt || HELLO_PRESET.body,perceptionRequested:null,abs:{timeScale:c.abs.timeScale,restHours:clone(c.abs.restHours)} }; await persist(s); return clone(s) }),
    skipDingtalk: ({expectedRevision}) => serial(async () => { const s = await load(); assertRevision(s,expectedRevision); s.dingtalk.status = 'skipped'; await persist(s); return clone(s) }),
  }
}
