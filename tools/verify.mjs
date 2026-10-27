import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'Lint', command: 'pnpm lint' },
  { name: 'Type-check', command: 'pnpm type-check' },
  { name: 'Unit tests', command: 'pnpm test' },
  { name: 'Integration tests', command: 'pnpm test:int' },
];

if (!process.env.TEST_DATABASE_ADMIN_URL) {
  console.error(
    'verify needs TEST_DATABASE_ADMIN_URL pointing at a local Postgres admin database, the same variable the CI sets for the integration tests.',
  );
  process.exit(1);
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

const failed = steps.find((step) => !run(step));
if (failed) {
  console.error(`\nverify failed at: ${failed.name}`);
  process.exit(1);
}
console.log('\nverify passed');
