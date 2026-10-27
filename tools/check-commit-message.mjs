import { readFileSync } from 'node:fs';
import process from 'node:process';

const FORBIDDEN = [/^co-authored-by:/i, /generated with.*claude/i];

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/check-commit-message.mjs <commit message file>');
  process.exit(2);
}

const offending = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter((line) => !line.startsWith('#'))
  .filter((line) => FORBIDDEN.some((pattern) => pattern.test(line.trim())));

if (offending.length > 0) {
  console.error('Commit rejected: remove these lines from the message.');
  for (const line of offending) {
    console.error(`  ${line.trim()}`);
  }
  process.exit(1);
}
