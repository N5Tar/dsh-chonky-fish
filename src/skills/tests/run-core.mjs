import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, symlink, link, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillService, SKILL_LIMITS as limits } from '../core.js';

const tempParent = await realpath(os.tmpdir());
const root = await mkdtemp(path.join(tempParent, 'chonkyfish-skills-test-'));
const id = 'demo-skill';
const guide = '# 测试技能\n\n这是测试用的初始指南，只用于验证本地技能库。\n';
const createArgs = (skillId = id) => ({ action: 'create', skillId, title: '测试技能', description: '测试用技能', guide });
const create = (run, skillId = id) => run(createArgs(skillId));
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
  await test('library starts empty and create writes the first version', async () => {
    const run = runAt('catalog');
    const empty = await run({ action: 'list' });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.items, []);
    assert.deepEqual(await readdir(path.join(root, 'catalog')), []);
    const created = await create(run);
    assert.deepEqual(created, { skillId: id, revision: 1, action: 'create', title: '测试技能', description: '测试用技能' });
    const result = await run({ action: 'list' });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].skillId, id);
    assert.equal(result.items[0].title, '测试技能');
    assert.equal(result.items[0].description, '测试用技能');
    assert.equal(result.items[0].revision, 1);
    assert.equal(result.items[0].experienceCount, 0);
    assert.deepEqual(result.items[0].sections, ['guide', 'experiences']);
    assert.equal(result.nextOffset, null);
    assert.deepEqual(await readdir(path.join(root, 'catalog')), [`${id}.json`]);
    await assert.rejects(create(run), code('CONFLICT'));
    assert.equal((await run(readGuide)).content, guide);
    const reopened = runAt('catalog');
    assert.equal((await reopened({ action: 'history', skillId: id })).items[0].action, 'create');
  });
  await test('read section and record evidence references have bounded defaults', async () => {
    const run = runAt('defaults');
    await create(run);
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
    await create(run);
    let offset = 0;
    let content = '';
    do {
      const page = await run({ ...readGuide, offset, limit: 17 });
      assert.equal(page.offset, offset);
      assert.ok(page.content.length <= 17);
      content += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(content, guide);
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
    await create(run);
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
    await create(run);
    await run(record());
    await run(revise(2, 'New guide'));
    assert.equal((await run(readGuide)).content, 'New guide');
    const restored = await run({ action: 'rollback', skillId: id, revision: 1, expectedRevision: 3, reason: 'Restore initial snapshot' });
    assert.deepEqual(restored, { skillId: id, revision: 4, action: 'rollback', sourceRevision: 1 });
    assert.equal((await run({ ...readGuide, limit: limits.maxReadGuideChars })).content, guide);
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
    await create(a);
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
      { ...createArgs(), title: '' }, { ...createArgs(), title: 'x'.repeat(limits.maxTitleChars + 1) },
      { ...createArgs(), description: ' ' }, { ...createArgs(), guide: 'x'.repeat(limits.maxGuideChars + 1) },
      { ...createArgs('Bad Id') }, { ...createArgs(), reason: 'x'.repeat(limits.maxReasonChars + 1) },
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
    await assert.rejects(run(readGuide), code('NOT_FOUND'));
    await assert.rejects(run(record()), code('NOT_FOUND'));
    await create(run);
    for (const input of invalid) await assert.rejects(run(input), code('INVALID_ARGUMENT'));
    await assert.rejects(run({ ...readGuide, skillId: 'not-installed' }), code('NOT_FOUND'));
    await assert.rejects(run({ ...readGuide, revision: 2 }), code('NOT_FOUND'));
    await assert.rejects(run({ action: 'rollback', skillId: id, revision: 99, expectedRevision: 1, reason: 'bad target' }), code('NOT_FOUND'));
    assert.equal((await run(readGuide)).revision, 1);
    assert.deepEqual(await readdir(path.join(root, 'validation')), [`${id}.json`]);
    assert.throws(() => createSkillService(), code('INVALID_ARGUMENT'));
    assert.throws(() => createSkillService({ directory: path.join(root, 'x') + '/../escape' }), code('UNSAFE_PATH'));
  });
  await test('create accepts placeholder fields from sibling actions but keeps rejecting unknown ones', async () => {
    const run = runAt('create-placeholders');
    const payload = {
      section: 'guide', action: 'create', skillId: 'tieba-browsing',
      title: '逛贴吧（资料学习版）', description: '依据官方帮助学习浏览、搜索、关注与收藏。',
      guide: '# 逛贴吧\n\n资料学习，未实操验证。',
      claim: '', evidenceRefs: [], expectedRevision: 1, content: '', reason: '保存已查阅资料', revision: 1,
    };
    const created = await run(payload);
    assert.equal(created.skillId, 'tieba-browsing');
    assert.equal(created.revision, 1);
    const listed = await run({ action: 'list' });
    assert.equal(listed.items[0].title, '逛贴吧（资料学习版）');
    assert.equal((await run({ action: 'read', skillId: 'tieba-browsing' })).content, payload.guide);
    // A field outside every action's set is still rejected.
    await assert.rejects(run({ ...payload, unknownThing: true }), code('INVALID_ARGUMENT'));
    assert.equal((await run({ action: 'list' })).total, 1);
  });
  await test('malformed and invalid persisted states fail closed without overwrite', async () => {
    const directory = path.join(root, 'corrupt');
    const run = runAt('corrupt');
    await create(run);
    await run(record());
    const filename = path.join(directory, `${id}.json`);
    const original = await readFile(filename, 'utf8');
    const invalidStates = ['{', '{}', 'null', original.replace('"status":"observed"', '"status":"verified"'),
      original.replace('"revision":2', '"revision":9'), original.replace(`"skillId":"${id}"`, '"skillId":"other"')];
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
    await create(run);
    for (let i = 1; i < limits.maxRevisions; i++) await run(revise(i, `Guide ${i}`));
    const filename = path.join(root, 'revision-limit', `${id}.json`);
    const before = await readFile(filename, 'utf8');
    await assert.rejects(run(revise(limits.maxRevisions)), code('LIMIT_EXCEEDED'));
    assert.equal(await readFile(filename, 'utf8'), before);
    assert.equal((await run({ ...readGuide, revision: 1, limit: limits.maxReadGuideChars })).content, guide);
    assert.deepEqual(await readdir(path.dirname(filename)), [`${id}.json`]);
  });
  await test('aggregate byte cap is bounded and leaves the previous revision intact', async () => {
    const run = runAt('byte-limit');
    await create(run);
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
  await test('skill library capacity is bounded', async () => {
    const run = runAt('capacity');
    for (let index = 0; index < limits.maxSkills + 1; index++) {
      if (index === limits.maxSkills) {
        await assert.rejects(create(run, `skill-${index}`), code('LIMIT_EXCEEDED'));
        break;
      }
      await create(run, `skill-${index}`);
    }
    assert.equal((await run({ action: 'list', limit: limits.maxPageSize })).total, limits.maxSkills);
    assert.deepEqual((await readdir(path.join(root, 'capacity'))).length, limits.maxSkills);
  });
  await test('legacy seed state is migrated in place without losing content', async () => {
    const directory = path.join(root, 'legacy');
    await mkdir(directory);
    const legacyGuide = '# 旧版技能\n\n这是旧版指南正文。\n';
    const legacy = {
      format: 1,
      skillId: id,
      snapshots: [
        { revision: 1, action: 'seed', reason: 'Bundled initial guide', createdAt: '2026-11-07T09:21:00.000Z', guide: legacyGuide, experiences: [] },
        { revision: 2, action: 'record', reason: 'Recorded observation (not verified)', createdAt: '2026-11-07T09:22:00.000Z', guide: legacyGuide,
          experiences: [{ id: 'experience-2', claim: '旧经验', evidenceRefs: ['local:old'], status: 'observed', createdAt: '2026-11-07T09:22:00.000Z' }] },
      ],
    };
    const filename = path.join(directory, `${id}.json`);
    await writeFile(filename, JSON.stringify(legacy));
    const run = runAt('legacy');
    const listed = await run({ action: 'list' });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].title, '旧版技能');
    assert.equal(listed.items[0].description, '这是旧版指南正文。');
    assert.equal(listed.items[0].revision, 2);
    assert.equal(listed.items[0].experienceCount, 1);
    const history = await run({ action: 'history', skillId: id });
    assert.deepEqual(history.items.map((item) => item.action), ['create', 'record']);
    assert.equal((await run({ ...readGuide, revision: 1 })).content, legacyGuide);
    assert.equal((await run({ ...readGuide, section: 'experiences' })).items[0].claim, '旧经验');
    // Migration healed the file and kept every snapshot.
    const healed = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(healed.title, '旧版技能');
    assert.equal(healed.description, '这是旧版指南正文。');
    assert.equal(healed.snapshots.length, 2);
    assert.equal(healed.snapshots[0].action, 'create');
    assert.equal(healed.snapshots[1].experiences.length, 1);
    // A subsequent write keeps the upgraded shape.
    await run(record('迁移后经验'));
    const after = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(after.snapshots.length, 3);
    assert.equal(after.snapshots[2].experiences.length, 2);
  });
  await test('legacy state without a heading falls back to the skill id', async () => {
    const directory = path.join(root, 'legacy-no-heading');
    await mkdir(directory);
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      format: 1, skillId: id,
      snapshots: [{ revision: 1, action: 'seed', reason: '旧版', createdAt: '2026-11-07T09:21:00.000Z', guide: '没有标题的正文', experiences: [] }],
    }));
    const listed = await runAt('legacy-no-heading')({ action: 'list' });
    assert.equal(listed.items[0].title, id);
    assert.equal(listed.items[0].description, '没有标题的正文');
  });
  await test('legacy migration does not weaken corruption checks', async () => {
    const directory = path.join(root, 'legacy-corrupt');
    await mkdir(directory);
    const base = { format: 1, skillId: id, snapshots: [{ revision: 1, action: 'seed', reason: '旧版', createdAt: '2026-11-07T09:21:00.000Z', guide: '# 标题', experiences: [] }] };
    for (const broken of [
      { ...base, snapshots: [{ ...base.snapshots[0], action: 'record' }] },
      { ...base, snapshots: [{ ...base.snapshots[0], revision: 2 }] },
      { ...base, skillId: 'other-skill' },
      { ...base, snapshots: [{ ...base.snapshots[0], guide: '' }] },
    ]) {
      await writeFile(path.join(directory, `${id}.json`), JSON.stringify(broken));
      await assert.rejects(runAt('legacy-corrupt')({ action: 'list' }), code('CORRUPT_STATE'));
    }
  });
  await test('single skill archive round-trips all revisions, guides and observations', async () => {
    const source = runAt('export-source');
    await create(source);
    await source(record('经验 <script>纯文本</script>'));
    await source(revise(2, '历史指南 😀'));
    await source({ action: 'rollback', skillId: id, revision: 1, expectedRevision: 3, reason: '保留回退来源' });
    const archive = await source({ action: 'export', skillId: id });
    assert.equal(archive.snapshots.length, 4);
    assert.equal(archive.snapshots[1].experiences[0].claim, '经验 <script>纯文本</script>');
    const target = runAt('import-target');
    const result = await target({ action: 'import', archive });
    assert.equal(result.skillId, id);
    assert.equal(result.revisionCount, 4);
    assert.deepEqual(await target({ action: 'export', skillId: id }), archive);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'import-target', `${id}.json`))), archive);
    await assert.rejects(target({ action: 'import', archive }), code('CONFLICT'));
    assert.deepEqual(await target({ action: 'export', skillId: id }), archive);
    archive.snapshots[0].guide = 'caller mutation';
    assert.equal((await target({ ...readGuide, revision: 1 })).content, guide);
    await assert.rejects(source({ action: 'export', skillId: 'absent' }), code('NOT_FOUND'));
  });
  await test('archive validation rejects malformed, oversized, unsafe and batch imports without files', async () => {
    const source = runAt('archive-fixture');
    await create(source);
    await source(record());
    const archive = await source({ action: 'export', skillId: id });
    const run = runAt('invalid-imports');
    const variants = [null, [], [archive], {}, { ...archive, format: 99 }, { ...archive, skillId: '../escape' },
      { ...archive, extra: true }, { ...archive, snapshots: [] }, { ...archive, title: '' },
      { ...archive, snapshots: [{ ...archive.snapshots[0], revision: 2 }] },
      { ...archive, snapshots: [{ ...archive.snapshots[0], guide: 'x'.repeat(limits.maxGuideChars + 1) }] },
      { ...archive, snapshots: [{ ...archive.snapshots[0], createdAt: 'invalid' }] },
      { ...archive, snapshots: [archive.snapshots[0], { ...archive.snapshots[1], experiences: [{ ...archive.snapshots[1].experiences[0], status: 'verified' }] }] },
      { ...archive, snapshots: [archive.snapshots[0], { ...archive.snapshots[1], action: 'rollback', sourceRevision: 2 }] },
    ];
    for (const value of variants) await assert.rejects(run({ action: 'import', archive: value }), code('INVALID_ARGUMENT'));
    await assert.rejects(run({ action: 'import', archive, overwrite: true }), code('INVALID_ARGUMENT'));
    await assert.rejects(run({ action: 'import', archive: { ...archive, title: '界'.repeat(limits.maxFileBytes) } }), code('LIMIT_EXCEEDED'));
    assert.equal((await run({ action: 'list' })).total, 0);
    assert.deepEqual(await readdir(path.join(root, 'invalid-imports')), []);
    const filename = path.join(root, 'invalid-imports', `${id}.json`);
    await writeFile(filename, '{broken');
    await assert.rejects(run({ action: 'import', archive }), code('CONFLICT'));
    assert.equal(await readFile(filename, 'utf8'), '{broken');
  });
  await test('transfer actions ignore sibling placeholders without changing archive identity', async () => {
    const source = runAt('archive-fixture');
    const archive = await source({ action: 'export', skillId: id });
    assert.deepEqual(await source({ action: 'export', skillId: id, section: 'guide', revision: 1, offset: 0, limit: 10, archive: {}, title: '', description: '', guide: '', claim: '', content: '', reason: '', evidenceRefs: [], expectedRevision: 1 }), archive);
    const target = runAt('import-placeholders');
    const imported = await target({ action: 'import', archive, skillId: 'ignored-placeholder', title: '', description: '', guide: '', claim: '', evidenceRefs: [], expectedRevision: 1, section: 'guide', content: '', reason: '', revision: 1 });
    assert.equal(imported.skillId, id);
    assert.deepEqual(await target({ action: 'export', skillId: id }), archive);
    await assert.rejects(source({ action: 'export', skillId: id, batch: true }), code('INVALID_ARGUMENT'));
    await assert.rejects(target({ action: 'import', archive, overwrite: false }), code('INVALID_ARGUMENT'));
  });
  await test('concurrent imports publish once and preserve capacity limits', async () => {
    const source = runAt('archive-fixture');
    const archive = await source({ action: 'export', skillId: id });
    const attempts = await Promise.allSettled([runAt('import-race'), runAt('import-race')].map(run => run({ action: 'import', archive })));
    assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(value => value.status === 'rejected').reason.code, 'CONFLICT');
    assert.deepEqual(await readdir(path.join(root, 'import-race')), [`${id}.json`]);
    await assert.rejects(runAt('capacity')({ action: 'import', archive }), code('LIMIT_EXCEEDED'));
    await assert.rejects(runAt('unsafe-file')({ action: 'import', archive }), code('UNSAFE_PATH'));
    assert.equal(await readFile(path.join(root, 'outside', 'target'), 'utf8'), 'untouched');
  });
  console.log(`\n${passed} skill core tests passed`);
} finally {
  // Verify absolute cleanup target is exactly our newly-created test directory.
  assert.equal(path.dirname(root), tempParent);
  assert.ok(path.basename(root).startsWith('chonkyfish-skills-test-'));
  assert.equal(await realpath(root), root);
  await rm(root, { recursive: true, force: true });
}
