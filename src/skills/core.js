import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILTIN_SKILLS } from './bundled.js';

import { SKILL_LIMITS, VERSIONS } from '../resources/spec.js';
export { SKILL_LIMITS };
export const LIMITS = SKILL_LIMITS;
const queues = new Map();
const catalog = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, skill]));
const own = (object, key) => Object.hasOwn(object, key);
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value, maximum, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    fail('INVALID_ARGUMENT', `${name} must be a nonempty string of at most ${maximum} characters`);
  }
  return value;
}
function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_ARGUMENT', `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    fail('INVALID_ARGUMENT', 'Unexpected argument or invalid object');
  }
}
function paginate(items, offset, limit) {
  return { offset, limit, total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit) };
}
async function serialize(directory, callback) {
  const previous = queues.get(directory) || Promise.resolve();
  const pending = previous.catch(() => {}).then(callback);
  queues.set(directory, pending);
  try { return await pending; }
  finally { if (queues.get(directory) === pending) queues.delete(directory); }
}
// Check every ancestor, including existing parents. Never traverse a symlink.
async function ensureDirectory(directory) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (creationError) { if (creationError.code !== 'EEXIST') throw creationError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_PATH', 'Storage ancestors must be real directories');
  }
}
async function checkFile(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_PATH', 'State must be a regular, unlinked file');
    if (info.size > LIMITS.maxFileBytes) fail('CORRUPT_STATE', 'Stored state exceeds the byte limit');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function seed(skill) {
  return { format: VERSIONS.skills, skillId: skill.id, snapshots: [{ revision: 1, action: 'seed', reason: 'Bundled initial guide',
    createdAt: '1970-01-01T00:00:00.000Z', guide: skill.guide, experiences: [] }] };
}
function validateState(state, id) {
  try {
    keys(state, ['format', 'skillId', 'snapshots']);
    if (state.format !== VERSIONS.skills || state.skillId !== id || !Array.isArray(state.snapshots)) throw new Error();
    integer(state.snapshots.length, 1, LIMITS.maxRevisions, 'snapshots');
    state.snapshots.forEach((snapshot, index) => {
      keys(snapshot, ['revision', 'action', 'reason', 'createdAt', 'guide', 'experiences', 'sourceRevision']);
      if (snapshot.revision !== index + 1 || !['seed', 'record', 'revise', 'rollback'].includes(snapshot.action)) throw new Error();
      if ((index === 0) !== (snapshot.action === 'seed')) throw new Error();
      text(snapshot.reason, LIMITS.maxReasonChars, 'reason');
      text(snapshot.guide, LIMITS.maxGuideChars, 'guide');
      if (typeof snapshot.createdAt !== 'string' || !Number.isFinite(Date.parse(snapshot.createdAt))) throw new Error();
      if (snapshot.action === 'rollback') integer(snapshot.sourceRevision, 1, index, 'sourceRevision');
      else if (own(snapshot, 'sourceRevision')) throw new Error();
      if (!Array.isArray(snapshot.experiences)) throw new Error();
      integer(snapshot.experiences.length, 0, LIMITS.maxExperiences, 'experiences');
      const ids = new Set();
      snapshot.experiences.forEach((entry) => {
        keys(entry, ['id', 'claim', 'evidenceRefs', 'status', 'createdAt']);
        if (typeof entry.id !== 'string' || !/^experience-[1-9][0-9]*$/.test(entry.id) || ids.has(entry.id)) throw new Error();
        ids.add(entry.id);
        if (entry.status !== 'observed' || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error();
        text(entry.claim, LIMITS.maxClaimChars, 'claim');
        validateRefs(entry.evidenceRefs);
      });
    });
  } catch { fail('CORRUPT_STATE', 'Invalid skill state; refusing to reset or overwrite it'); }
  return state;
}
function validateRefs(refs) {
  if (!Array.isArray(refs) || refs.length > LIMITS.maxEvidenceRefs) fail('INVALID_ARGUMENT', 'evidenceRefs must be a bounded string array');
  for (const ref of refs) text(ref, LIMITS.maxEvidenceRefChars, 'evidenceRefs item');
}
async function load(filename, skill) {
  if (!await checkFile(filename)) return seed(skill);
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) fail('UNSAFE_PATH', 'Unsafe state file');
    if (info.size > LIMITS.maxFileBytes) fail('CORRUPT_STATE', 'Stored state exceeds the byte limit');
    // Bounded even if an external writer grows the file after stat.
    const buffer = Buffer.alloc(LIMITS.maxFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > LIMITS.maxFileBytes) fail('CORRUPT_STATE', 'Stored state exceeds the byte limit');
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { fail('CORRUPT_STATE', 'Skill state is not valid JSON'); }
    return validateState(parsed, skill.id);
  } catch (error) {
    if (error.code === 'ELOOP') fail('UNSAFE_PATH', 'Symlink state file refused');
    throw error;
  } finally { await handle?.close(); }
}
async function persist(directory, filename, state) {
  const data = JSON.stringify(state);
  if (Buffer.byteLength(data) > LIMITS.maxFileBytes) fail('LIMIT_EXCEEDED', 'State byte limit reached; no changes saved');
  await ensureDirectory(directory);
  await checkFile(filename);
  // This checked directory and fixed generated basename are the only cleanup target.
  const temporary = path.join(directory, `.skill-${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await ensureDirectory(directory);
    await checkFile(filename);
    await rename(temporary, filename);
    created = false;
  } finally {
    await handle?.close();
    if (created) await unlink(temporary);
  }
}
function summary(skill, snapshot) {
  return { skillId: skill.id, title: skill.title, description: skill.description, revision: snapshot.revision,
    sections: ['guide', 'experiences'], experienceCount: snapshot.experiences.length };
}

/** Local knowledge only. Calls never publish, authorize actions, or verify claims. */
export function createSkillService({ directory } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) fail('INVALID_ARGUMENT', 'directory is required');
  if (directory.split(/[\\/]/).includes('..')) fail('UNSAFE_PATH', 'Parent traversal is not allowed');
  const root = path.resolve(directory);
  return {
    async run(args) {
      if (!object(args)) fail('INVALID_ARGUMENT', 'Expected an argument object');
      const allowed = {
        list: ['offset', 'limit'], read: ['skillId', 'section', 'revision', 'offset', 'limit'],
        history: ['skillId', 'offset', 'limit'], record: ['skillId', 'claim', 'evidenceRefs', 'expectedRevision'],
        revise: ['skillId', 'section', 'content', 'reason', 'expectedRevision'],
        rollback: ['skillId', 'revision', 'reason', 'expectedRevision'],
      };
      if (!own(allowed, args.action)) fail('INVALID_ARGUMENT', 'Unknown skill action');
      keys(args, ['action', ...allowed[args.action]]);
      // Copy before queuing so caller mutation cannot change validated arguments.
      const input = structuredClone(args);
      if (input.action === 'read') input.section ??= 'guide';
      if (input.action === 'record') input.evidenceRefs ??= [];
      let skill;
      if (input.action !== 'list') {
        if (typeof input.skillId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.skillId)) fail('INVALID_ARGUMENT', 'Invalid skillId');
        skill = catalog.get(input.skillId);
        if (!skill) fail('NOT_FOUND', 'Unknown skillId; use list to discover skills');
      }
      return serialize(root, async () => {
        await ensureDirectory(root);
        const guideRead = input.action === 'read' && input.section === 'guide';
        const offset = integer(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const limit = integer(input.limit ?? (guideRead ? LIMITS.defaultGuideChars : LIMITS.defaultPageSize), 1,
          guideRead ? LIMITS.maxReadGuideChars : LIMITS.maxPageSize, 'limit');
        if (input.action === 'list') {
          const entries = [];
          for (const entry of catalog.values()) {
            const state = await load(path.join(root, `${entry.id}.json`), entry);
            entries.push(summary(entry, state.snapshots.at(-1)));
          }
          return paginate(entries, offset, limit);
        }
        const filename = path.join(root, `${skill.id}.json`);
        const state = await load(filename, skill);
        const current = state.snapshots.at(-1);
        if (input.action === 'history') {
          return { skillId: skill.id, revision: current.revision, ...paginate(state.snapshots.map(({ guide, experiences, ...metadata }) =>
            ({ ...metadata, experienceCount: experiences.length })), offset, limit) };
        }
        if (input.action === 'read') {
          if (!['guide', 'experiences'].includes(input.section)) fail('INVALID_ARGUMENT', 'section must be guide or experiences');
          const revision = input.revision === undefined ? current.revision : integer(input.revision, 1, Number.MAX_SAFE_INTEGER, 'revision');
          const snapshot = state.snapshots[revision - 1];
          if (!snapshot) fail('NOT_FOUND', 'Revision not found');
          const base = { skillId: skill.id, revision, currentRevision: current.revision, section: input.section };
          if (input.section === 'experiences') return { ...base, ...paginate(snapshot.experiences, offset, limit) };
          const { items, ...page } = paginate(snapshot.guide, offset, limit);
          return { ...base, ...page, content: items };
        }
        if (input.action !== 'record' || input.expectedRevision !== undefined) {
          integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
          if (input.expectedRevision !== current.revision) fail('CONFLICT', `Expected revision ${input.expectedRevision}; current revision is ${current.revision}`);
        }
        if (state.snapshots.length >= LIMITS.maxRevisions) fail('LIMIT_EXCEEDED', 'Revision capacity reached; no changes saved');
        const snapshot = { revision: current.revision + 1, action: input.action, reason: 'Recorded observation (not verified)',
          createdAt: new Date().toISOString(), guide: current.guide, experiences: structuredClone(current.experiences) };
        let experience;
        if (input.action === 'record') {
          text(input.claim, LIMITS.maxClaimChars, 'claim');
          validateRefs(input.evidenceRefs);
          if (snapshot.experiences.length >= LIMITS.maxExperiences) fail('LIMIT_EXCEEDED', 'Experience capacity reached');
          experience = { id: `experience-${snapshot.revision}`, claim: input.claim, evidenceRefs: input.evidenceRefs,
            status: 'observed', createdAt: snapshot.createdAt };
          snapshot.experiences.push(experience);
        } else {
          snapshot.reason = text(input.reason, LIMITS.maxReasonChars, 'reason');
          if (input.action === 'revise') {
            if (input.section !== 'guide') fail('INVALID_ARGUMENT', 'Only guide can be revised');
            snapshot.guide = text(input.content, LIMITS.maxGuideChars, 'content');
          } else {
            integer(input.revision, 1, Number.MAX_SAFE_INTEGER, 'revision');
            const source = state.snapshots[input.revision - 1];
            if (!source) fail('NOT_FOUND', 'Rollback revision not found');
            snapshot.guide = source.guide;
            snapshot.experiences = structuredClone(source.experiences);
            snapshot.sourceRevision = source.revision;
          }
        }
        state.snapshots.push(snapshot);
        await persist(root, filename, state);
        return { skillId: skill.id, revision: snapshot.revision, action: input.action,
          ...(experience ? { experience } : {}), ...(input.action === 'rollback' ? { sourceRevision: snapshot.sourceRevision } : {}) };
      });
    },
  };
}
export default createSkillService;
