import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DRIVER = fileURLToPath(new URL('../tools/benchmark-processes.py', import.meta.url));
const PYTHON = '/usr/bin/python3';
const CHILD_ENV = { LC_ALL: 'C', PATH: '/usr/bin:/bin' };

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-process-driver-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function job(cwd, id, program, argv, options = {}) {
  return { id, round: 3, warmup: false, label: id, program, argv, cwd,
    env: CHILD_ENV, timeoutMs: 5000, maxCapturedBytesPerChannel: 32 * 1024 * 1024,
    ...options };
}

function rawBatch(manifest) {
  const result = spawnSync(PYTHON, [DRIVER], {
    input: typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stderr.length, 0);
  return { status: result.status, output: JSON.parse(result.stdout) };
}

function batch(jobs) {
  const result = rawBatch({ jobs });
  assert.equal(result.status, 0);
  assert.equal(result.output.observations.length, jobs.length);
  for (const [index, observed] of result.output.observations.entries()) {
    for (const key of ['id', 'round', 'warmup', 'label']) assert.deepEqual(observed[key], jobs[index][key]);
    assert.ok(Number.isFinite(observed.durationMs) && observed.durationMs >= 0);
  }
  return result.output.observations;
}

test('batch timer retains complete binary stdin, stdout, stderr and exit status', t => {
  const cwd = fixture(t);
  const data = Buffer.alloc(256 * 3000);
  for (let index = 0; index < data.length; index++) data[index] = index % 256;
  const script = 'import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.buffer.write(data[::-1]); sys.exit(7)';
  const [observed] = batch([job(cwd, 'binary', PYTHON, ['python3', '-c', script], {
    stdinBase64: data.toString('base64'), warmup: true,
  })]);
  assert.equal(observed.error, null);
  assert.equal(observed.status, 7);
  assert.equal(observed.signal, null);
  assert.ok(Buffer.from(observed.stdoutBase64, 'base64').equals(data));
  assert.ok(Buffer.from(observed.stderrBase64, 'base64').equals(Buffer.from(data).reverse()));
});

test('GNU argv0 and status one/two match independent direct GNU commands', t => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'input'), 'unrelated\n');
  const jobs = ['input', 'missing'].map(path => job(cwd, path, '/usr/bin/grep', ['grep', '-F', 'needle', path]));
  const observations = batch(jobs);
  for (const [index, observed] of observations.entries()) {
    const expected = spawnSync('/usr/bin/grep', jobs[index].argv.slice(1), {
      argv0: 'grep', cwd, env: CHILD_ENV,
    });
    assert.equal(expected.error, undefined);
    assert.equal(observed.error, null);
    assert.equal(observed.status, index + 1);
    assert.equal(observed.status, expected.status);
    assert.ok(Buffer.from(observed.stdoutBase64, 'base64').equals(expected.stdout));
    assert.ok(Buffer.from(observed.stderrBase64, 'base64').equals(expected.stderr));
  }
  assert.match(Buffer.from(observations[1].stderrBase64, 'base64').toString(), /^grep:/);
});

test('argv metacharacters remain literal and child environment is exact', t => {
  const cwd = fixture(t);
  const marker = join(cwd, 'never-created');
  const argumentsToPrint = [`$(touch ${marker})`, 'a; b', '$HOME', '`id`', 'quote"value', 'line\nbreak'];
  const jobs = [
    job(cwd, 'literal-args', PYTHON, ['python3', '-c', 'import json,sys; print(json.dumps(sys.argv[1:]))', ...argumentsToPrint]),
    job(cwd, 'exact-env', '/usr/bin/env', ['env'], { env: { EXACT_DRIVER_VALUE: 'kept literally;$HOME' } }),
  ];
  const [args, environment] = batch(jobs);
  assert.equal(args.error, null);
  assert.deepEqual(JSON.parse(Buffer.from(args.stdoutBase64, 'base64')), argumentsToPrint);
  assert.equal(environment.error, null);
  assert.equal(Buffer.from(environment.stdoutBase64, 'base64').toString(), 'EXACT_DRIVER_VALUE=kept literally;$HOME\n');
  assert.equal(existsSync(marker), false);
});

test('timeout kills the owned descendant group even when the direct child already exited', async t => {
  const cwd = fixture(t);
  const marker = join(cwd, 'should-not-appear');
  const script = 'import os,time,sys; child=os.fork();\nif child: os._exit(0)\ntime.sleep(0.3); open(sys.argv[1],"w").write("survived")';
  const [observed] = batch([job(cwd, 'timeout', PYTHON, ['python3', '-c', script, marker], { timeoutMs: 60 })]);
  assert.equal(observed.error.code, 'TIMEOUT');
  assert.ok(observed.durationMs >= 50 && observed.durationMs < 1500);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(existsSync(marker), false, 'owned descendant survived timeout');
});

test('early output EOF still waits for process exit without timeout polling sleeps', t => {
  const cwd = fixture(t);
  const child = job(cwd, 'early-eof', PYTHON, ['python3', '-c',
    'import os,time; os.close(1); os.close(2); time.sleep(0.01)']);
  const script = [
    'import importlib.util,json,subprocess,sys',
    'spec=importlib.util.spec_from_file_location("batch_driver",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'original=subprocess.Popen.wait; calls=[]',
    'def no_polling_wait(self,timeout=None):',
    ' assert timeout is None, "Timeout wait would introduce polling sleeps"',
    ' calls.append(timeout)',
    ' return original(self)',
    'subprocess.Popen.wait=no_polling_wait',
    'observation=module.run_job(json.loads(sys.argv[2]))',
    'print(json.dumps({"observation":observation,"waitCalls":len(calls)}))',
  ].join('\n');
  const [outer] = batch([job(cwd, 'wait-qualification', PYTHON,
    ['python3', '-c', script, DRIVER, JSON.stringify(child)])]);
  assert.equal(outer.error, null);
  const proof = JSON.parse(Buffer.from(outer.stdoutBase64, 'base64'));
  assert.equal(proof.observation.error, null);
  assert.equal(proof.observation.status, 0);
  assert.equal(proof.observation.signal, null);
  assert.ok(proof.observation.durationMs >= 10);
  assert.equal(proof.waitCalls, 1);
  assert.equal(proof.observation.stdoutBase64, '');
  assert.equal(proof.observation.stderrBase64, '');
});

test('output limits kill producers and retain bounded channel buffers', t => {
  const cwd = fixture(t);
  const script = 'import sys; sys.stdout.buffer.write(b"x"*8000000); sys.stderr.buffer.write(b"y"*8000000)';
  const [observed] = batch([job(cwd, 'bounded', PYTHON, ['python3', '-c', script], {
    maxCapturedBytesPerChannel: 1024,
  })]);
  assert.equal(observed.error.code, 'OUTPUT_LIMIT');
  assert.equal(observed.signal, 9);
  assert.equal(Buffer.from(observed.stdoutBase64, 'base64').length, 1024);
  assert.ok(Buffer.from(observed.stderrBase64, 'base64').length <= 1024);
});

test('spawn failures and natural signals do not lose following batch observations', t => {
  const cwd = fixture(t);
  const observations = batch([
    job(cwd, 'missing', join(cwd, 'no-such-program'), ['missing']),
    job(cwd, 'signalled', PYTHON, ['python3', '-c', 'import os,signal; os.kill(os.getpid(),signal.SIGTERM)']),
    job(cwd, 'after', '/usr/bin/true', ['true']),
  ]);
  assert.equal(observations[0].error.code, 'SPAWN_ERROR');
  assert.match(observations[0].error.message, /^ENOENT:/);
  assert.equal(observations[1].error, null);
  assert.equal(observations[1].status, null);
  assert.equal(observations[1].signal, 15);
  assert.equal(observations[2].error, null);
  assert.equal(observations[2].status, 0);
});

test('malformed manifests and invalid bounded jobs receive structured errors', t => {
  const cwd = fixture(t);
  for (const manifest of ['{invalid', '{}', '{"jobs":null}', { jobs: Array(10_001).fill(null) }]) {
    const observed = rawBatch(manifest);
    assert.equal(observed.status, 2);
    assert.equal(observed.output.error.code, 'INVALID_MANIFEST');
    assert.deepEqual(observed.output.observations, []);
  }
  const observations = batch([
    job(cwd, 'no-argv', '/usr/bin/true', []),
    job(cwd, 'bad-base64', '/usr/bin/true', ['true'], { stdinBase64: '!!' }),
    job(cwd, 'unbounded-output', '/usr/bin/true', ['true'], { maxCapturedBytesPerChannel: 64 * 1024 * 1024 }),
    job(cwd, 'bad-timeout', '/usr/bin/true', ['true'], { timeoutMs: 0 }),
  ]);
  for (const observed of observations) {
    assert.equal(observed.error.code, 'INVALID_JOB');
    assert.equal(observed.durationMs, 0);
  }
});
