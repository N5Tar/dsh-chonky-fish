import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, symlink, link, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillService, SKILL_LIMITS as limits } from '../core.js';
import { BUILTIN_SKILLS } from '../bundled.js';

const tempParent = await realpath(os.tmpdir());
const root = await mkdtemp(path.join(tempParent, 'chonkyfish-skills-test-'));
const id = 'homepage-operations';
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
const runAt = (name) => createSkillService({ directory: path.join(root, name) }).run;
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };
const readGuide = { action: 'read', skillId: id, section: 'guide' };
const revise = (expectedRevision, content = 'Updated local guide') => ({ action: 'revise', skillId: id, section: 'guide', content, reason: 'Test local revision', expectedRevision });
const record = (claim = 'Observed test result') => ({ action: 'record', skillId: id, claim, evidenceRefs: ['local:test-log'] });
try {
  await test('catalog exposes a Chinese homepage guide and no live integration', async () => {
    assert.equal(BUILTIN_SKILLS.length, 1);
    assert.equal(BUILTIN_SKILLS[0].id, id);
    assert.match(BUILTIN_SKILLS[0].guide, /待配置/);
    assert.match(BUILTIN_SKILLS[0].guide, /observed/);
    assert.match(BUILTIN_SKILLS[0].guide, /不执行发布/);
    assert.doesNotMatch(BUILTIN_SKILLS[0].guide, /贴吧|授权|审批/);
    assert.match(BUILTIN_SKILLS[0].guide, /https:\/\/mingyue\.novak\.wang/);
    assert.match(BUILTIN_SKILLS[0].guide, /\/Users\/jinyan\/workspace\/chonky-fish-site/);
    assert.match(BUILTIN_SKILLS[0].guide, /\.\/deploy\.sh --site mingyue --dry-run/);
    assert.match(BUILTIN_SKILLS[0].guide, /\.\/scripts\/verify-site\.sh mingyue/);
    assert.match(BUILTIN_SKILLS[0].guide, /不是纯离线预览/);
    assert.match(BUILTIN_SKILLS[0].guide, /不是原子发布/);
    assert.match(BUILTIN_SKILLS[0].guide, /不包含独立 CSS\/JS/);
    assert.match(BUILTIN_SKILLS[0].guide, /非 DeepSeek 官方网站/);
    assert.match(BUILTIN_SKILLS[0].guide, /大肥鱼自主运营自己官网主页/);
    assert.match(BUILTIN_SKILLS[0].guide, /不得编造亲身经历/);
    assert.match(BUILTIN_SKILLS[0].guide, /发布回执/);
    const run = runAt('catalog');
    const result = await run({ action: 'list' });
    assert.equal(result.items[0].skillId, id);
    assert.equal(result.items[0].revision, 1);
    assert.deepEqual(result.items[0].sections, ['guide', 'experiences']);
    assert.equal(result.nextOffset, null);
    assert.deepEqual(await readdir(path.join(root, 'catalog')), []);
  });
  await test('read section and record evidence references have bounded defaults', async () => {
    const run = runAt('defaults');
    const implicit = await run({ action: 'read', skillId: id });
    assert.deepEqual(implicit, await run(readGuide));
    assert.equal(implicit.section, 'guide');
    assert.equal(implicit.limit, limits.defaultGuideChars);
    const result = await run({ action: 'record', skillId: id, claim: 'Observation without supporting references' });
    assert.deepEqual(result.experience.evidenceRefs, []);
    assert.equal(result.experience.status, 'observed');
    const reopened = runAt('defaults');
    assert.deepEqual((await reopened({ ...readGuide, section: 'experiences' })).items[0].evidenceRefs, []);
    await run(revise(2, 'x'.repeat(limits.maxGuideChars)));
    const bounded = await run({ action: 'read', skillId: id });
    assert.equal(bounded.content.length, limits.defaultGuideChars);
    assert.equal(bounded.nextOffset, limits.defaultGuideChars);
  });
  await test('bounded read pages can reconstruct the guide without silent truncation', async () => {
    const run = runAt('pages');
    let offset = 0;
    let content = '';
    do {
      const page = await run({ ...readGuide, offset, limit: 17 });
      assert.equal(page.offset, offset);
      assert.ok(page.content.length <= 17);
      content += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(content, BUILTIN_SKILLS[0].guide);
    const empty = await run({ ...readGuide, offset: 100000 });
    assert.equal(empty.content, '');
    assert.equal(empty.nextOffset, null);
    await run(revise(1, 'x'.repeat(limits.maxGuideChars)));
    const bounded = await run(readGuide);
    assert.equal(bounded.content.length, limits.defaultGuideChars);
    assert.equal(bounded.nextOffset, limits.defaultGuideChars);
  });
  await test('observations persist without verification and do not rewrite guide', async () => {
    const run = runAt('record');
    const initial = await run(readGuide);
    const result = await run(record());
    assert.equal(result.revision, 2);
    assert.equal(result.experience.status, 'observed');
    result.experience.claim = 'caller modification';
    const reopened = runAt('record');
    assert.equal((await reopened(readGuide)).content, initial.content);
    const entries = await reopened({ action: 'read', skillId: id, section: 'experiences' });
    assert.equal(entries.items[0].claim, 'Observed test result');
    assert.deepEqual(entries.items[0].evidenceRefs, ['local:test-log']);
    assert.equal(entries.items[0].status, 'observed');
    assert.equal((await reopened({ ...readGuide, section: 'experiences', revision: 1 })).total, 0);
    await reopened({ ...record('No evidence yet'), evidenceRefs: [] });
    const page = await reopened({ ...readGuide, section: 'experiences', limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.nextOffset, 1);
  });
  await test('revisions and rollback append immutable full snapshots', async () => {
    const run = runAt('versions');
    await run(record());
    await run(revise(2, 'New guide'));
    assert.equal((await run(readGuide)).content, 'New guide');
    const restored = await run({ action: 'rollback', skillId: id, revision: 1, expectedRevision: 3, reason: 'Restore initial snapshot' });
    assert.deepEqual(restored, { skillId: id, revision: 4, action: 'rollback', sourceRevision: 1 });
    assert.equal((await run({ ...readGuide, limit: limits.maxReadGuideChars })).content, BUILTIN_SKILLS[0].guide);
    assert.equal((await run({ ...readGuide, section: 'experiences' })).total, 0);
    assert.equal((await run({ ...readGuide, revision: 3 })).content, 'New guide');
    assert.equal((await run({ ...readGuide, revision: 2, section: 'experiences' })).total, 1);
    const history = await run({ action: 'history', skillId: id, limit: 2, offset: 1 });
    assert.equal(history.total, 4);
    assert.equal(history.nextOffset, 3);
    assert.deepEqual(history.items.map((item) => item.action), ['record', 'revise']);
    assert.ok(history.items.every((item) => !('guide' in item) && !('experiences' in item)));
  });
  await test('single-process serialization spans service instances and catches stale revisions', async () => {
    const a = runAt('concurrency');
    const b = runAt('concurrency');
    const attempts = await Promise.allSettled([a(revise(1, 'A')), b(revise(1, 'B'))]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'CONFLICT');
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b)(record(`Observation ${i}`))));
    const entries = await a({ ...readGuide, section: 'experiences', limit: 50 });
    assert.equal(entries.total, 12);
    assert.equal(entries.revision, 14);
    assert.equal(new Set(entries.items.map((item) => item.id)).size, 12);
    await assert.rejects(a({ ...record(), expectedRevision: 1 }), code('CONFLICT'));
    await assert.rejects(a({ action: 'rollback', skillId: id, revision: 1, expectedRevision: 1, reason: 'stale' }), code('CONFLICT'));
    assert.equal((await a(readGuide)).revision, 14);
  });
  await test('invalid inputs, unknown skills and revision targets fail without state changes', async () => {
    const run = runAt('validation');
    const invalid = [null, {}, { action: 'publish' }, { action: 'toString' },
      { ...readGuide, skillId: '../escape' }, { ...readGuide, skillId: '/absolute' },
      { ...readGuide, offset: -1 }, { ...readGuide, limit: 0 }, { ...readGuide, limit: limits.maxReadGuideChars + 1 },
      { ...readGuide, offset: 0.5 }, { ...readGuide, revision: '1' }, { ...readGuide, section: 'secret' },
      { action: 'list', limit: limits.maxPageSize + 1 }, { action: 'list', extra: true },
      { ...revise(1), expectedRevision: undefined }, { ...revise(1), content: '' },
      { ...revise(1), reason: ' ' }, { ...revise(1), section: 'experiences' },
      { ...revise(1), content: 'x'.repeat(limits.maxGuideChars + 1) },
      { ...revise(1), reason: 'x'.repeat(limits.maxReasonChars + 1) },
      { ...record(), claim: 'x'.repeat(limits.maxClaimChars + 1) },
      { ...record(), evidenceRefs: 'not-an-array' }, { ...record(), evidenceRefs: [12] },
      { ...record(), evidenceRefs: ['x'.repeat(limits.maxEvidenceRefChars + 1)] },
      { ...record(), evidenceRefs: Array(limits.maxEvidenceRefs + 1).fill('ref') },
      { ...record(), status: 'verified' },
    ];
    for (const input of invalid) await assert.rejects(run(input), code('INVALID_ARGUMENT'));
    await assert.rejects(run({ ...readGuide, skillId: 'not-installed' }), code('NOT_FOUND'));
    await assert.rejects(run({ ...readGuide, revision: 2 }), code('NOT_FOUND'));
    await assert.rejects(run({ action: 'rollback', skillId: id, revision: 99, expectedRevision: 1, reason: 'bad target' }), code('NOT_FOUND'));
    assert.equal((await run(readGuide)).revision, 1);
    assert.deepEqual(await readdir(path.join(root, 'validation')), []);
    assert.throws(() => createSkillService(), code('INVALID_ARGUMENT'));
    assert.throws(() => createSkillService({ directory: path.join(root, 'x') + '/../escape' }), code('UNSAFE_PATH'));
  });
  await test('malformed and invalid persisted states fail closed without overwrite', async () => {
    const directory = path.join(root, 'corrupt');
    const run = runAt('corrupt');
    await run(record());
    const filename = path.join(directory, `${id}.json`);
    const original = await readFile(filename, 'utf8');
    const invalidStates = ['{', '{}', 'null', original.replace('"status":"observed"', '"status":"verified"'),
      original.replace('"revision":2', '"revision":9'), original.replace('"skillId":"homepage-operations"', '"skillId":"other"')];
    for (const invalid of invalidStates) {
      await writeFile(filename, invalid);
      await assert.rejects(run(readGuide), code('CORRUPT_STATE'));
      await assert.rejects(run(record()), code('CORRUPT_STATE'));
      await assert.rejects(run({ action: 'list' }), code('CORRUPT_STATE'));
      assert.equal(await readFile(filename, 'utf8'), invalid);
    }
    const invalidUtf8 = Buffer.from(original.replace('Observed test result', 'X'));
    invalidUtf8[invalidUtf8.indexOf(Buffer.from('"claim":"X"')) + '"claim":"'.length] = 0xff;
    await writeFile(filename, invalidUtf8);
    await assert.rejects(run(readGuide), code('CORRUPT_STATE'));
    assert.deepEqual(await readFile(filename), invalidUtf8);
    await writeFile(filename, 'x'.repeat(limits.maxFileBytes + 1));
    await assert.rejects(run(readGuide), code('CORRUPT_STATE'));
  });
  await test('symlink ancestors, symlink files, hard links and non-files are refused', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    const alias = path.join(root, 'alias');
    await symlink(outside, alias, 'dir');
    await assert.rejects(createSkillService({ directory: path.join(alias, 'child') }).run({ action: 'list' }), code('UNSAFE_PATH'));
    const directory = path.join(root, 'unsafe-file');
    await mkdir(directory);
    const target = path.join(outside, 'target');
    await writeFile(target, 'untouched');
    await symlink(target, path.join(directory, `${id}.json`));
    await assert.rejects(runAt('unsafe-file')(record()), code('UNSAFE_PATH'));
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    const hardDirectory = path.join(root, 'hardlink');
    await mkdir(hardDirectory);
    await link(target, path.join(hardDirectory, `${id}.json`));
    await assert.rejects(runAt('hardlink')(readGuide), code('UNSAFE_PATH'));
    await mkdir(path.join(root, 'not-file', `${id}.json`), { recursive: true });
    await assert.rejects(runAt('not-file')(readGuide), code('UNSAFE_PATH'));
  });
  await test('revision cap preserves all history and rejects overflow atomically', async () => {
    const run = runAt('revision-limit');
    for (let i = 1; i < limits.maxRevisions; i++) await run(revise(i, `Guide ${i}`));
    const filename = path.join(root, 'revision-limit', `${id}.json`);
    const before = await readFile(filename, 'utf8');
    await assert.rejects(run(revise(limits.maxRevisions)), code('LIMIT_EXCEEDED'));
    assert.equal(await readFile(filename, 'utf8'), before);
    assert.equal((await run({ ...readGuide, revision: 1, limit: limits.maxReadGuideChars })).content, BUILTIN_SKILLS[0].guide);
    assert.deepEqual(await readdir(path.dirname(filename)), [`${id}.json`]);
  });
  await test('aggregate byte cap is bounded and leaves the previous revision intact', async () => {
    const run = runAt('byte-limit');
    let revision = 1;
    let rejected = false;
    while (revision < limits.maxRevisions) {
      try { await run(revise(revision, '界'.repeat(limits.maxGuideChars))); revision++; }
      catch (error) { assert.equal(error.code, 'LIMIT_EXCEEDED'); rejected = true; break; }
    }
    assert.equal(rejected, true);
    assert.equal((await run(readGuide)).revision, revision);
    const filename = path.join(root, 'byte-limit', `${id}.json`);
    const persisted = await readFile(filename);
    assert.ok(persisted.length <= limits.maxFileBytes);
    assert.equal(JSON.parse(persisted).snapshots.length, revision);
    assert.deepEqual(await readdir(path.dirname(filename)), [`${id}.json`]);
  });
  console.log(`\n${passed} skill core tests passed`);
} finally {
  // Verify absolute cleanup target is exactly our newly-created test directory.
  assert.equal(path.dirname(root), tempParent);
  assert.ok(path.basename(root).startsWith('chonkyfish-skills-test-'));
  assert.equal(await realpath(root), root);
  await rm(root, { recursive: true, force: true });
}
