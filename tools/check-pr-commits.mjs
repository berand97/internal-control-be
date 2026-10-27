import { spawnSync } from 'node:child_process';
import process from 'node:process';

const FORBIDDEN = [/^co-authored-by:/i, /generated with.*claude/i];

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const base = process.argv[2];
if (!base) {
  console.error('Usage: node tools/check-pr-commits.mjs <base ref>');
  process.exit(2);
}

const mergeBase = git(['merge-base', 'HEAD', base]).trim();
const commits = git(['log', '--format=%H%n%B%x00', `${mergeBase}..HEAD`])
  .split('\0')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [hash = '', ...body] = entry.split(/\r?\n/);
    return { hash, body };
  });

const offending = commits.filter(({ body }) =>
  body.some((line) => FORBIDDEN.some((pattern) => pattern.test(line.trim()))),
);

if (offending.length > 0) {
  console.error('These commits carry a Co-Authored-By or "Generated with Claude" line:');
  for (const { hash } of offending) {
    console.error(`  ${hash}`);
  }
  console.error('Reword them and push again.');
  process.exit(1);
}
console.log(
  `Commit messages ok: ${String(commits.length)} commits checked against ${base} (merge-base ${mergeBase.slice(0, 7)}).`,
);
