import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { fixture } from './grep_extended_helpers.mjs';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const launcher = fileURLToPath(new URL('../bin/grep2rg', import.meta.url));

test('POSIX span replay waits for paused stdout and a no-drain mutant exceeds the bounded queue', async (t) => {
  const f = fixture(t); f.put('subject', 'aaaa aaaa line value\n'.repeat(20000));
  const argv = ['-aE', '--color=always', 'a+', 'subject'];
  const expected = spawnSync('/usr/bin/grep', argv, { cwd: f.cwd, env: f.env, argv0: 'grep', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(expected.error, undefined); assert.equal(expected.status, 0); assert.deepEqual(expected.stderr, Buffer.alloc(0));
  const copy = join(f.cwd, 'no-drain-source'); mkdirSync(copy);
  for (const name of readdirSync(source).filter((name) => name.endsWith('.mjs'))) writeFileSync(join(copy, name), readFileSync(join(source, name)));
  const spans = join(copy, 'grep-posix-spans.mjs'), original = readFileSync(spans, 'utf8');
  assert.equal(original.split('await waitForOutput();').length, 2, 'one narrow replay-drain mutation');
  writeFileSync(spans, original.replace('await waitForOutput();', '/* test-only omitted drain */'));
  const maximumQueue = 128 * 1024;
  async function observe(runtime, name) {
    const metricsPath = join(f.cwd, `${name}-queue.json`);
    // Observation occurs outside product source. The real Node writable stream,
    // rg, GNU span child and formatter keep their normal behavior.
    const harness = `import{writeFileSync}from'node:fs';import{runGrep}from${JSON.stringify(pathToFileURL(runtime).href)};let maximum=0,next=1,blocked=false;const write=process.stdout.write;process.stdout.write=function(...args){const ok=write.apply(this,args);maximum=Math.max(maximum,this.writableLength);if(!ok)blocked=true;if(maximum>=next||!ok){writeFileSync(process.env.GREP2RG_QUEUE_METRICS,JSON.stringify({maximumWritableLength:maximum,blockedWriteObserved:blocked}));next=Math.max(next*2,maximum+1);}return ok;};process.exitCode=await runGrep(process.argv.slice(1));writeFileSync(process.env.GREP2RG_QUEUE_METRICS,JSON.stringify({maximumWritableLength:maximum,blockedWriteObserved:blocked,completed:true}));`;
    const before = f.calls().length;
    const child = spawn(process.execPath, ['--input-type=module', '-e', harness, '--', ...argv], {
      cwd: f.cwd, env: { ...f.env, GREP2RG_QUEUE_METRICS: metricsPath }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stdout.pause();
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve({ status, signal })); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 12000);
    try {
      const deadline = Date.now() + 8000;
      const readMetrics = () => { try { return JSON.parse(readFileSync(metricsPath, 'utf8')); } catch { return undefined; } };
      let ready;
      while (!(ready = readMetrics())?.blockedWriteObserved && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(existsSync(metricsPath), 'owned replay reached a real stdout write');
      assert.equal(ready?.blockedWriteObserved, true, 'the synthetic consumer must exert backpressure');
      await new Promise((resolve) => setTimeout(resolve, 300));
      child.stdout.resume();
      assert.deepEqual(await completion, { status: 0, signal: null });
      assert.deepEqual(Buffer.concat(stdout), expected.stdout); assert.deepEqual(Buffer.concat(stderr), expected.stderr);
      const observed = JSON.parse(readFileSync(metricsPath, 'utf8'));
      assert.equal(observed.completed, true);
      const calls = f.calls().slice(before);
      assert.ok(calls.some((call) => call.engine === 'rg' && call.argv.includes('--json')));
      assert.ok(calls.some((call) => call.engine === 'grep' && /\/grep2rg-posix-[^/]+\/candidate-records$/.test(call.argv.at(-1))));
      return observed;
    } finally { clearTimeout(timer); if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }
  }
  const normal = await observe(join(source, 'grep-runtime.mjs'), 'normal');
  assert.ok(normal.maximumWritableLength <= maximumQueue, `normal replay queue ${normal.maximumWritableLength} exceeds ${maximumQueue}`);
  const mutant = await observe(join(copy, 'grep-runtime.mjs'), 'mutant');
  assert.ok(mutant.maximumWritableLength > maximumQueue, 'the no-drain negative control must reproduce the excess output queue');
  t.diagnostic(JSON.stringify({ campaign: 'extended-POSIX-replay-backpressure', actualGNUComparisons: 1, negativeControlGNUComparisons: 1,
    actualRgSearchInvocations: 1, negativeControlRgInvocations: 1, actualGNUSpanBrokerInvocations: 1, negativeControlSpanBrokerInvocations: 1,
    syntheticOutputBytesPerComparison: expected.stdout.length, maximumAllowedWritableLength: maximumQueue,
    normalMaximumWritableLength: normal.maximumWritableLength, noDrainMutantMaximumWritableLength: mutant.maximumWritableLength, semanticNegativeControlRejected: true }));
});

test('cancelling public and private POSIX replay exits despite unread stdout and removes owned spools', async (t) => {
  const f = fixture(t); f.put('subject', 'aaaa aaaa line value\n'.repeat(20000));
  const spools = join(f.cwd, 'paused-spools'); mkdirSync(spools);
  for (const route of ['public', 'private-wrapper']) for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const args = ['-aE', '--color=always', 'a+', 'subject'];
    const child = spawn(route === 'public' ? launcher : process.execPath, route === 'public' ? args : [join(source, 'grep-wrapper.mjs'), ...args], {
      cwd: f.cwd, env: { ...f.env, TMPDIR: spools }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, killed) => resolve({ code, killed })); });
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    let outputStarted = false, timeout;
    child.stdout.on('data', () => { outputStarted = true; child.stdout.pause(); });
    try {
      const deadline = Date.now() + 8000;
      while (!outputStarted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(outputStarted, true, 'public replay must publish real bytes before the consumer pauses');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(child.exitCode, null, 'paused synthetic stdout keeps the replay active');
      assert.ok(readdirSync(spools).some((name) => name.startsWith('grep2rg-posix-')));
      child.kill(signal);
      const result = await Promise.race([exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('CLI did not exit while stdout remained unread')), 5000); })]);
      assert.deepEqual(result, { code: status, killed: null });
      assert.deepEqual(readdirSync(spools), [], 'owned replay spool is removed before CLI exit');
      child.stdout.removeAllListeners('data'); child.stdout.resume(); await closed;
      assert.deepEqual(Buffer.concat(stderr), Buffer.alloc(0));
    } finally {
      clearTimeout(timeout); child.stdout.removeAllListeners('data'); child.stdout.resume();
      if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
  }
  t.diagnostic(JSON.stringify({ campaign: 'extended-POSIX-paused-replay-cancellation', CLIEntryRoutes: 2, handledSignalInvocations: 6, unreadStdoutExitStatuses: [130, 143, 129], ownedSpoolsRemoved: 6 }));
});
