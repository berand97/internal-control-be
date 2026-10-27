import { spawnSync } from 'node:child_process';

const MAX_LISTED_FILES = 150;

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function baseRef() {
  if (process.env.VERIFY_BASE) {
    return process.env.VERIFY_BASE;
  }
  if (process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}`;
  }
  const remoteHead = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
  if (remoteHead.status === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim();
  }
  console.error('verify:fast cannot tell the base branch. Set VERIFY_BASE, for example VERIFY_BASE=origin/develop.');
  process.exit(1);
}

function changedFiles(mergeBase) {
  const committedAndWorking = git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...committedAndWorking, ...untracked].filter(Boolean))];
}

function run(name, command) {
  console.log(`\n> ${name}\n$ ${command}`);
  const started = performance.now();
  const result = spawnSync(command, { stdio: 'inherit', shell: true });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const passed = result.status === 0;
  console.log(`${passed ? 'ok' : 'FAILED'} ${name} (${seconds} s)`);
  return passed;
}

const base = baseRef();
const mergeBase = git(['merge-base', 'HEAD', base]);
const changed = changedFiles(mergeBase);
console.log(`verify:fast against ${base} (merge-base ${mergeBase.slice(0, 7)}), ${changed.length} changed files`);

const lintable = changed.filter((file) => /^(src|test)\/.*\.ts$/.test(file));
const lintCommand =
  lintable.length > MAX_LISTED_FILES
    ? 'pnpm lint'
    : `pnpm exec oxlint -c oxlint.json --deny-warnings ${lintable.map((file) => `"${file}"`).join(' ')}`;

const steps = [
  ...(lintable.length > 0 ? [['Lint changed files', lintCommand]] : []),
  ['UI copy', 'node tools/check-ui-copy.mjs'],
  ['Type-check', 'pnpm type-check'],
  ['Unit tests related to the changes', `pnpm exec vitest run --changed ${mergeBase} --passWithNoTests`],
];

const failed = steps.find(([name, command]) => !run(name, command));
if (failed) {
  console.error(`\nverify:fast failed at: ${failed[0]}`);
  process.exit(1);
}
console.log('\nverify:fast passed. Run pnpm verify before opening or updating a PR.');
