import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { withGrepWrapper } from '../src/grep-wrapper.mjs';

const launcher = fileURLToPath(new URL('../bin/grep2rg', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-descriptors-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'bin'));
  writeFileSync(join(cwd, 'subject'), 'ababa needle\nnone\nabc needle\n'); writeFileSync(join(cwd, 'patterns'), 'a|ab\n');
  const trace = join(cwd, 'calls'); writeFileSync(trace, '');
  const realRg = spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-c', 'command -v rg'], { encoding: 'utf8' });
  assert.equal(realRg.status, 0, 'actual rg is mandatory');
  writeFileSync(join(cwd, 'bin/grep'), '#!/usr/bin/bash\nkind=native\nfor arg; do\n  case "$arg" in /dev/null) kind=validation ;; */grep2rg-posix-*/candidate-records) kind=broker ;; esac\ndone\nprintf "grep:%s\\n" "$kind" >> "$DESCRIPTOR_TRACE"\nexec -a grep /usr/bin/grep "$@"\n', { mode: 0o700 });
  writeFileSync(join(cwd, 'bin/rg'), `#!/usr/bin/bash\nkind=validation\nfor arg; do [[ $arg == --json ]] && kind=search; done\nprintf 'rg:%s\\n' "$kind" >> "$DESCRIPTOR_TRACE"\nexec ${quote(realRg.stdout.trim())} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', GREP_COLORS: '', GREP_COLOR: '', TERM: 'dumb', PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
    DESCRIPTOR_TRACE: trace, DESCRIPTOR_LAUNCHER: launcher, DESCRIPTOR_RESULT: join(cwd, 'result') };
  delete env.POSIXLY_CORRECT;
  const calls = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean);
  const metrics = { actualGNUComparisons: 0, actualRgSearchInvocations: 0, actualRgValidationInvocations: 0, actualGNUSpanBrokerInvocations: 0, actualGNUValidationInvocations: 0, actualOriginalGNUInvocations: 0 };
  function compare(command, route, { broker = false, native = false, record = true, successfulOutput = false } = {}) {
    const environment = record ? env : { ...env, PATH: process.env.PATH };
    const run = (body) => spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-c', `ulimit -Sn 4098 || exit 125\n${body}`], { cwd, env: environment, timeout: 10000, maxBuffer: 1024 * 1024 });
    const expected = run(`grep() { (exec -a grep /usr/bin/grep "$@"); }\n${command}`);
    const before = calls().length;
    const body = route === 'private' ? withGrepWrapper({ command }, '/usr/bin/bash').command
      : `grep() { command "$DESCRIPTOR_LAUNCHER" "$@"; }\n${command}`;
    const actual = run(body);
    for (const result of [expected, actual]) { assert.equal(result.error, undefined); assert.equal(result.signal, null); }
    assert.equal(actual.status, expected.status, `${route}: ${command}`);
    assert.deepEqual(actual.stdout, expected.stdout, `${route} stdout: ${command}`);
    assert.deepEqual(actual.stderr, expected.stderr, `${route} stderr: ${command}`);
    if (successfulOutput) { assert.equal(expected.status, 0, 'positive GNU descriptor witness must succeed'); assert.deepEqual(expected.stderr, Buffer.alloc(0)); assert.ok(expected.stdout.length > 0); }
    const invoked = calls().slice(before);
    metrics.actualGNUComparisons++;
    metrics.actualRgSearchInvocations += invoked.filter((call) => call === 'rg:search').length;
    metrics.actualRgValidationInvocations += invoked.filter((call) => call === 'rg:validation').length;
    metrics.actualGNUSpanBrokerInvocations += invoked.filter((call) => call === 'grep:broker').length;
    metrics.actualGNUValidationInvocations += invoked.filter((call) => call === 'grep:validation').length;
    metrics.actualOriginalGNUInvocations += invoked.filter((call) => call === 'grep:native').length;
    if (broker) { assert.ok(invoked.includes('rg:search')); assert.ok(invoked.includes('grep:broker')); assert.ok(!invoked.includes('grep:native')); }
    if (native) { assert.equal(invoked.filter((call) => call === 'grep:native').length, 1); assert.ok(!invoked.includes('rg:search')); }
  }
  return { compare, metrics };
}

test('public and private grep preserve caller FD3 operands and candidate span broker descriptors', (t) => {
  const f = fixture(t);
  for (const route of ['public', 'private']) {
    f.compare('exec 3<subject\ngrep -F needle /dev/fd/3', route);
    f.compare('exec 3<patterns\ngrep -aEo -f /dev/fd/3 subject', route, { broker: true });
    f.compare('exec 3>"$DESCRIPTOR_RESULT"\ngrep -aEo "a|ab" subject\nstatus=$?\nprintf "caller-fd3-still-open\\n" >&3\n/usr/bin/cat "$DESCRIPTOR_RESULT"\nexit "$status"', route, { broker: true });
  }
  t.diagnostic(JSON.stringify({ campaign: 'grep-caller-fd3', ...f.metrics, callerFD3AndPrivateSpoolIndependent: true }));
});

test('public and private grep preserve high descriptors and process substitution operands', (t) => {
  const f = fixture(t);
  const limit = spawnSync('/usr/bin/bash', ['-c', 'ulimit -Hn'], { encoding: 'utf8' });
  assert.equal(limit.status, 0); assert.ok(limit.stdout.trim() === 'unlimited' || Number(limit.stdout) > 4097, 'Linux hard descriptor limit must allow descriptor 4097');
  for (const route of ['public', 'private']) {
    f.compare('exec 4097<subject\ngrep -aFn needle /dev/fd/4097', route, { successfulOutput: true });
    f.compare('exec 4097<patterns\ngrep -aEo -f /dev/fd/4097 subject', route, { broker: true, successfulOutput: true });
    f.compare('grep -F needle <(printf "needle\\nnone\\n")', route, { native: true });
    f.compare('grep -aEo -f <(printf "a|ab\\n") subject', route);
  }
  t.diagnostic(JSON.stringify({ campaign: 'grep-high-fd-process-substitution', ...f.metrics, highDescriptor: 4097, successfulHighDescriptorOpenWitnesses: 4 }));
});

test('closed caller descriptors retain exact GNU grep errors', (t) => {
  const f = fixture(t);
  for (const route of ['public', 'private']) for (const descriptor of [3, 63])
    f.compare(`exec ${descriptor}<&-\ngrep -F needle /dev/fd/${descriptor}`, route, { native: true });
  t.diagnostic(JSON.stringify({ campaign: 'grep-closed-caller-fd', ...f.metrics }));
});

test('closed standard descriptors preserve GNU grep status, streams and stdin ownership', (t) => {
  const f = fixture(t);
  const cases = [
    'grep -F needle subject 1>&-',
    'grep -Fq needle subject 1>&-',
    'grep -F needle missing-owned-path 2>&-',
    'grep -F needle subject 2>&-',
    'grep -F needle subject 0<&-',
    'grep -F needle 0<&-',
  ];
  for (const route of ['public', 'private']) for (const command of cases) f.compare(command, route, { record: false });
  t.diagnostic(JSON.stringify({ campaign: 'grep-closed-standard-fds', actualGNUComparisons: f.metrics.actualGNUComparisons, closedDescriptors: [0, 1, 2], directExecutablesWithoutRecorder: true }));
});
