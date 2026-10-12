import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { planGrep, withGrepWrapper } from '../src/grep-wrapper.mjs';

const launcher = fileURLToPath(new URL('../bin/grep2rg', import.meta.url));
const runtime = new URL('../src/grep-runtime.mjs', import.meta.url).href;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const nativeValues = [undefined, '', '0', 'true', 'yes', '2'];

function fixture(t, { historicalC = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-policy-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, 'bin'), trace = join(cwd, 'calls'); mkdirSync(bin);
  writeFileSync(join(cwd, 'text'), 'head\nneedle\ntail\n');
  writeFileSync(trace, '');
  writeFileSync(join(bin, 'grep'), `#!/usr/bin/bash\nprintf 'GNU\\n' >> "$POLICY_TRACE"\nexec -a grep /usr/bin/grep "$@"\n`, { mode: 0o700 });
  for (const name of ['rg', 'node']) writeFileSync(join(bin, name), `#!/usr/bin/bash\nprintf '${name}\\n' >> "$POLICY_TRACE"\nexit 99\n`, { mode: 0o700 });
  const environment = (value) => {
    const env = { ...process.env, LC_ALL: 'C', LANG: 'C', PATH: `${bin}:/usr/bin:/bin`, POLICY_TRACE: trace };
    delete env.GREP2RG_EXPERIMENTAL_RG;
    delete env.POSIXLY_CORRECT;
    if (historicalC) env.GREP2RG_ENGINE = 'c';
    if (value !== undefined) env.GREP2RG_EXPERIMENTAL_RG = value;
    return env;
  };
  const calls = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean);
  return { cwd, bin, trace, environment, calls };
}

function run(program, args, f, value, input) {
  const r = spawnSync(program, args, { cwd: f.cwd, env: f.environment(value), input, timeout: 10000,
    maxBuffer: 2 * 1024 * 1024, argv0: program === '/usr/bin/grep' ? 'grep' : undefined });
  assert.equal(r.error, undefined); assert.equal(r.signal, null); return r;
}
function exact(actual, expected) {
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
}

test('a public launcher without its native helper falls back to GNU without Node or rg', (t) => {
  const f = fixture(t), isolated = join(f.cwd, 'standalone'); mkdirSync(isolated);
  // Only the Bash entry exists here: loading any Node implementation would fail.
  const bin = join(isolated, 'grep2rg'); cpSync(launcher, bin);
  const cases = [['-aFn', 'needle', 'text'], ['-aF', 'absent', 'text'], ['-aF', 'needle', 'missing'],
    ['--help'], ['--version'], ['--invalid-owned-flag'], ['-m'], []];
  for (const value of nativeValues) for (const args of cases)
    exact(run(bin, args, f, value), run('/usr/bin/grep', args, f, value));
  assert.deepEqual(f.calls(), Array(cases.length * nativeValues.length).fill('GNU'));
  t.diagnostic(JSON.stringify({ campaign: 'default-GNU-policy-public', actualGNUComparisons: 48,
    actualRgInvocations: 0, actualNodeInvocations: 0, GNUPreparatoryProbes: 0, isolatedBashOnlyEntry: true }));
});

test('the JS planner and API do not select rg without exact experimental opt-in', (t) => {
  const f = fixture(t), args = ['-aFn', 'needle', 'text'];
  for (const value of nativeValues) {
    const p = planGrep(args, { env: f.environment(value), stat() { assert.fail('native routing must precede stat'); } });
    assert.equal(p.backend, 'grep'); assert.deepEqual(p.args, args);
    const code = `import {runGrep} from ${JSON.stringify(runtime)};process.exitCode=await runGrep(process.argv.slice(1));`;
    exact(run(process.execPath, ['--input-type=module', '-e', code, '--', ...args], f, value),
      run('/usr/bin/grep', args, f, value));
  }
  assert.deepEqual(f.calls(), Array(nativeValues.length).fill('GNU'));
  t.diagnostic(JSON.stringify({ campaign: 'default-GNU-policy-JS', actualGNUComparisons: 6, actualRgInvocations: 0 }));
});

test('the historical C private Bash route keeps small searches GNU without Node', (t) => {
  const f = fixture(t, { historicalC: true }), args = ['-aFn', 'needle', 'text'];
  const { command } = withGrepWrapper({ command: 'grep "$@"' }, '/usr/bin/bash');
  for (const value of nativeValues)
    exact(run('/usr/bin/bash', ['--noprofile', '--norc', '-c', command, 'owned-policy', ...args], f, value),
      run('/usr/bin/grep', args, f, value));
  assert.deepEqual(f.calls(), Array(nativeValues.length).fill('GNU'));
  t.diagnostic(JSON.stringify({ campaign: 'historical-C-GNU-policy-private', actualGNUComparisons: 6, actualRgInvocations: 0 }));
});

test('the exact experiment flag reaches the broader JavaScript rg path on a small search', (t) => {
  const f = fixture(t), record = join(f.cwd, 'rg-search');
  writeFileSync(join(f.bin, 'rg'), `#!/usr/bin/bash\nprintf 'rg\\n' >> ${quote(record)}\nexec /usr/bin/rg "$@"\n`, { mode: 0o700 });
  // The public launcher resolves Node through PATH only for an explicit experiment.
  writeFileSync(join(f.bin, 'node'), `#!/usr/bin/bash\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  const args = ['-aFn', 'needle', 'text'];
  exact(run(launcher, args, f, '1'), run('/usr/bin/grep', args, f, '1'));
  assert.ok(existsSync(record)); assert.equal(readFileSync(record, 'utf8'), 'rg\n');
  assert.deepEqual(f.calls(), []);
  t.diagnostic(JSON.stringify({ campaign: 'explicit-rg-experiment', actualGNUComparisons: 1,
    actualRgInvocations: 1, originalGNUInvocations: 0, universalSpeedClaim: false }));
});
