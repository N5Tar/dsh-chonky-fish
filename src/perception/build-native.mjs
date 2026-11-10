import { spawnSync } from 'node:child_process';
import { mkdirSync, chmodSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('The macOS collector requires the macOS SDK');
const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.some((arg) => !['--all', '--arch=arm64', '--arch=x64', '--clt-modulemap-workaround'].includes(arg))) throw new Error('Usage: build-native.mjs [--all | --arch=arm64 | --arch=x64] [--clt-modulemap-workaround]');
const compilerFlags = [];
if (args.includes('--clt-modulemap-workaround')) {
  const located = spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (located.status !== 0) throw new Error('Unable to locate Swift compiler');
  const include = join(dirname(dirname(located.stdout.trim())), 'include', 'swift');
  const redundant = join(include, 'module.modulemap');
  const current = join(include, 'bridging.modulemap');
  const declarations = (path) => readFileSync(path, 'utf8').replace(/\/\/[^\n]*/g, '').trim();
  if (declarations(redundant) !== declarations(current)) throw new Error('CLT workaround refused: module maps differ');
  const buildRoot = join(root, 'native', '.build'); mkdirSync(buildRoot, { recursive: true });
  const temporary = mkdtempSync(join(buildRoot, 'modulemap-'));
  const empty = join(temporary, 'empty.modulemap'); writeFileSync(empty, '// Redundant map hidden only in this compiler process.\n');
  const overlay = join(temporary, 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ version: 0, roots: [{ type: 'file', name: redundant, 'external-contents': empty }] }));
  compilerFlags.push('-vfsoverlay', overlay, '-Xcc', '-ivfsoverlay', '-Xcc', overlay, '-module-cache-path', join(temporary, 'cache'));
  console.log('Using explicitly requested process-private duplicate SwiftBridging module-map workaround');
}
const architectures = args.includes('--all') ? ['arm64', 'x64'] : [args.find((arg) => arg.startsWith('--arch='))?.split('=')[1] ?? process.arch];
for (const architecture of architectures) {
  if (!['arm64', 'x64'].includes(architecture)) throw new Error('Unsupported macOS architecture');
  const target = architecture === 'x64' ? 'x86_64' : 'arm64';
  const output = join(root, 'native', 'macos', architecture, 'activity-collector');
  mkdirSync(dirname(output), { recursive: true });
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', ...compilerFlags, ...(process.env.SDKROOT ? ['-sdk', process.env.SDKROOT] : []), '-target', `${target}-apple-macosx11.0`,
    join(root, 'native', 'macos', 'ActivityCollector.swift'), '-o', output], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Swift ${architecture} build failed (${result.status})`);
  chmodSync(output, 0o755);
  console.log(`Built macOS ${architecture} collector (minimum deployment target 11.0; runtime compatibility requires separate verification)`);
}
