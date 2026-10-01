import { spawnSync } from 'node:child_process';
import { constants, getPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const belowNormal = process.platform === 'win32' ? constants.priority.PRIORITY_BELOW_NORMAL : 1;

function run(preload: string) {
  return spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bin, 'docgen'],
    {
      encoding: 'utf8',
    },
  );
}

test('lowers CLI priority before commands run', () => {
  const result = run(`
    import { getPriority } from 'node:os';
    process.on('exit', () => console.error('priority=' + getPriority()));
  `);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).opencliVersion).toBeTruthy();
  expect(result.stderr).toContain(`priority=${Math.max(getPriority(), belowNormal)}`);
});

test('preserves an already lower inherited priority', () => {
  const result = run(`
    import { constants, getPriority, setPriority } from 'node:os';
    setPriority(constants.priority.PRIORITY_LOW);
    process.on('exit', () => console.error('priority=' + getPriority()));
  `);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain(`priority=${constants.priority.PRIORITY_LOW}`);
});

test('continues running commands when priority adjustment is denied', () => {
  const result = run(`
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    os.getPriority = () => 0;
    os.setPriority = () => { throw new Error('priority denied'); };
    syncBuiltinESMExports();
  `);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).opencliVersion).toBeTruthy();
  expect(result.stderr).toContain('Unable to lower CLI CPU priority:');
  expect(result.stderr).toContain('priority denied');
});
