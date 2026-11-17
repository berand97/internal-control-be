import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const steps = [
  { name: 'Lint', command: 'bun run lint' },
  { name: 'UI copy', command: 'node tools/check-ui-copy.mjs' },
  { name: 'Type-check', command: 'bun run type-check' },
  { name: 'Unit tests', command: 'bun run test' },
  { name: 'Integration tests', command: 'bun run test:int' },
];

if (!process.env.TEST_DATABASE_ADMIN_URL) {
  process.env.TEST_DATABASE_ADMIN_URL =
    'postgres://postgres:postgres@localhost:5432/postgres';
  console.log(
    `TEST_DATABASE_ADMIN_URL not set; using ${process.env.TEST_DATABASE_ADMIN_URL}`,
  );
}
if (!process.env.GOTENBERG_URL) {
  process.env.GOTENBERG_URL = 'http://localhost:3100';
  console.log(`GOTENBERG_URL not set; using ${process.env.GOTENBERG_URL}`);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function changedTrackedFiles() {
  const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=no']).split('\0');
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    files.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') {
      index += 1;
    }
  }
  return files;
}

function trackedChanges() {
  const files = changedTrackedFiles();
  return new Map(
    files.map((file) => [
      file,
      existsSync(file) ? git(['hash-object', '--no-filters', '--', file]).trim() : 'MISSING',
    ]),
  );
}

function run(step) {
  console.log(`\n> ${step.name}\n$ ${step.command}`);
  const started = performance.now();
  const result = spawnSync(step.command, { stdio: 'inherit', shell: true });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const passed = result.status === 0;
  console.log(`${passed ? 'ok' : 'FAILED'} ${step.name} (${seconds} s)`);
  return passed;
}

function checkTrackedFilesUntouched(before) {
  console.log('\n> Tracked files untouched by verify');
  const after = trackedChanges();
  const touched = [...after.keys()].filter((file) => before.get(file) !== after.get(file));
  for (const file of before.keys()) {
    if (!after.has(file)) {
      touched.push(file);
    }
  }
  if (touched.length > 0) {
    console.error(`FAILED verify changed tracked files:\n${touched.map((file) => `  ${file}`).join('\n')}`);
    return false;
  }
  console.log('ok Tracked files untouched by verify');
  return true;
}

const before = trackedChanges();
const failed = steps.find((step) => !run(step));
if (failed) {
  console.error(`\nverify failed at: ${failed.name}`);
  process.exit(1);
}
if (!checkTrackedFilesUntouched(before)) {
  console.error('\nverify failed at: Tracked files untouched by verify');
  process.exit(1);
}
console.log('\nverify passed');
