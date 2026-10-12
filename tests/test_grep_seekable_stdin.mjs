import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture } from './grep_extended_helpers.mjs';
import { withGrepWrapper } from '../src/grep-wrapper.mjs';

const launcher = fileURLToPath(new URL('../bin/grep2rg', import.meta.url));
const capture = String.raw`
import base64,hashlib,json,os,subprocess,sys
cfg=json.loads(sys.argv[1])
with open(cfg['path'],'rb',buffering=0) as stream:
    os.lseek(stream.fileno(),cfg['offset'],os.SEEK_SET)
    result=subprocess.run(cfg['command'],stdin=stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        cwd=cfg['cwd'],timeout=15)
    offset=os.lseek(stream.fileno(),0,os.SEEK_CUR)
    tail=stream.read()
    print(json.dumps(dict(status=result.returncode,stdout=base64.b64encode(result.stdout).decode(),
        stderr=base64.b64encode(result.stderr).decode(),offset=offset,remainingBytes=len(tail),
        remainingSHA256=hashlib.sha256(tail).hexdigest())))
`;

function compare(f, argv, { offset = 0, path = 'input', accelerated = true, route = 'public' } = {}) {
  const before = f.calls().length;
  const command = route === 'private' ? ['/usr/bin/bash', '--noprofile', '--norc', '-c',
    withGrepWrapper({ command: 'grep "$@"' }, '/usr/bin/bash').command, 'owned-seekable-stdin', ...argv] : [launcher, ...argv];
  const run = (command) => {
    const result = spawnSync('python3', ['-c', capture, JSON.stringify({ command, path: isAbsolute(path) ? path : join(f.cwd, path),
      cwd: f.cwd, offset })], { env: f.env, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr.toString());
    return JSON.parse(result.stdout);
  };
  const expected = run(['/usr/bin/grep', ...argv]);
  const actual = run(command);
  assert.deepEqual(actual, expected, JSON.stringify({ argv, offset, route }));
  const calls = f.calls().slice(before), searches = calls.filter((call) => call.engine === 'rg' && call.argv.includes('--json'));
  const native = calls.filter((call) => call.engine === 'grep' && call.argv.at(-1) !== '/dev/null' &&
    !/\/grep2rg-posix-[^/]+\/candidate-records$/.test(call.argv.at(-1)));
  if (accelerated) { assert.ok(searches.length > 0, `real rg must select stdin records: ${JSON.stringify(argv)}`); assert.equal(native.length, 0); }
  else { assert.equal(searches.length, 0); assert.deepEqual(native.map((call) => call.argv), [argv]); }
  return { actualGNUComparisons: 1, actualRgSearchInvocations: searches.length, actualOriginalGNUInvocations: native.length };
}

function metrics() { return { actualGNUComparisons: 0, actualRgSearchInvocations: 0, actualOriginalGNUInvocations: 0 }; }
function add(into, value) { for (const key of Object.keys(into)) into[key] += value[key]; }

test('seekable explicit-text stdin preserves GNU max-count cursor and unread tail', (t) => {
  const f = fixture(t), evidence = metrics();
  f.put('input', 'prefix ignored\nhead\nneedle one\ncontext\nneedle two\nlast\n');
  const modes = [[], ['-n', '-b', '-H', '--label=owned-input'], ['-A3'], ['-B1', '-A2'], ['-c'], ['-o'], ['-v'], ['-v', '-o']];
  for (const offset of [0, Buffer.byteLength('prefix ignored\n')]) for (const maximum of [1, 2, 9])
    for (const flags of modes) add(evidence, compare(f, ['-aF', `-m${maximum}`, ...flags, 'needle'], { offset }));
  t.diagnostic(JSON.stringify({ campaign: 'seekable-stdin-LF-cursor', ...evidence,
    comparedFields: ['status', 'stdout', 'stderr', 'sharedOffset', 'remainingBytes', 'remainingSHA256'] }));
});

test('seekable stdin handles NUL records, unterminated records and POSIX span output', (t) => {
  const f = fixture(t), evidence = metrics();
  const prefix = 'unsearched\0';
  f.put('nul', prefix + 'head\0ab\naba\0context\0ab\naba\0tail');
  f.put('input', 'unsearched\nhead\nabab ab\ncontext\nababa\ntail');
  for (const offset of [0, Buffer.byteLength(prefix)]) for (const maximum of [1, 2, 9])
    for (const flags of [[], ['-A2'], ['-n', '-b', '-H'], ['-v'], ['-c'], ['-o']])
      add(evidence, compare(f, ['-azF', `-m${maximum}`, ...flags, 'ab'], { offset, path: 'nul' }));
  for (const maximum of [1, 2, 9]) for (const flags of [['-o'], ['-n', '-b', '--color=always', '-A2']])
    add(evidence, compare(f, ['-aE', `-m${maximum}`, ...flags, 'a|ab'], { offset: Buffer.byteLength('unsearched\n') }));
  for (const path of ['input', 'nul']) for (const flags of [[], ['-o'], ['-c'], ['-v']])
    add(evidence, compare(f, ['-aF', '-m1', ...(path === 'nul' ? ['-z'] : []), ...flags, '-e', ''], { path,
      accelerated: !flags.includes('-v') }));
  t.diagnostic(JSON.stringify({ campaign: 'seekable-stdin-record-and-span-cursor', ...evidence }));
});

test('private Pi shell wrapper preserves seekable stdin positions across large records', (t) => {
  const f = fixture(t), evidence = metrics(), prefix = Buffer.alloc(65537, 120);
  writeFileSync(join(f.cwd, 'input'), Buffer.concat([prefix, Buffer.from('\nneedle '), Buffer.alloc(131079, 121),
    Buffer.from('\ncontext\nneedle two\ntail\n')]));
  for (const offset of [0, prefix.length + 1]) for (const maximum of [1, 2]) for (const flags of [[], ['-A2']])
    add(evidence, compare(f, ['-aF', `-m${maximum}`, ...flags, 'needle', '-'], { offset, route: 'private' }));
  t.diagnostic(JSON.stringify({ campaign: 'seekable-stdin-private-large-record-cursor', ...evidence,
    ownedInputBytes: readFileSync(join(f.cwd, 'input')).length }));
});

test('unqualified stdin combinations retain untouched original GNU ownership', (t) => {
  const f = fixture(t), evidence = metrics();
  f.put('input', 'head\nneedle\ncontext\nneedle\ntail\n'); f.put('other', 'needle\n');
  for (const argv of [['-aF', '-m1', 'needle', '-', '-'], ['-aF', '-m1', 'needle', '-', 'other'],
    ['-aF', '-q', 'needle'], ['-aF', '-l', 'needle'], ['-aF', '-L', 'needle'],
    ['-F', '-m1', 'needle'], ['-aF', '-m0', 'needle']])
    add(evidence, compare(f, argv, { accelerated: false, offset: 5 }));
  f.compare(['-aF', '-m1', 'needle'], { input: Buffer.from('head\nneedle\ntail\n'), accelerated: false });
  t.diagnostic(JSON.stringify({ campaign: 'seekable-stdin-retained-native-boundaries', ...evidence,
    additionalPipeGNUComparisons: 1, originalPipeInvocations: 1 }));
});

test('a regular O_PATH stdin descriptor retains GNU unreadable-input diagnostics', (t) => {
  const f = fixture(t); f.put('input', 'needle\ntail\n');
  const code = String.raw`
import base64,json,os,subprocess,sys
cfg=json.loads(sys.argv[1]); fd=os.open(cfg['path'],os.O_PATH)
try:
    result=subprocess.run(['grep','-aF','-m1','needle'],executable=cfg['executable'],stdin=fd,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
    print(json.dumps(dict(status=result.returncode,stdout=base64.b64encode(result.stdout).decode(),
        stderr=base64.b64encode(result.stderr).decode())))
finally: os.close(fd)
`;
  const run = (executable) => {
    const result = spawnSync('python3', ['-c', code, JSON.stringify({ executable, path: join(f.cwd, 'input') })],
      { cwd: f.cwd, env: f.env, timeout: 15000, maxBuffer: 65536 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr.toString());
    return JSON.parse(result.stdout);
  };
  const expected = run('/usr/bin/grep'), before = f.calls().length, actual = run(launcher);
  assert.equal(expected.status, 2); assert.deepEqual(actual, expected);
  const calls = f.calls().slice(before);
  assert.equal(calls.filter((call) => call.engine === 'rg' && call.argv.includes('--json')).length, 0);
  assert.deepEqual(calls.filter((call) => call.engine === 'grep').map((call) => call.argv), [['-aF', '-m1', 'needle']]);
  t.diagnostic(JSON.stringify({ campaign: 'seekable-stdin-unreadable-O_PATH', actualGNUComparisons: 1,
    actualRgSearchInvocations: 0, actualOriginalGNUInvocations: 1 }));
});

test('proc pseudo-files with synthetic sizes retain original GNU stream reads', (t) => {
  const f = fixture(t), evidence = metrics();
  for (const flag of ['-m1', '--max-count=1'])
    add(evidence, compare(f, ['-aF', flag, 'Linux'], { path: '/proc/version', accelerated: false }));
  t.diagnostic(JSON.stringify({ campaign: 'seekable-stdin-proc-size-boundary', ...evidence }));
});

test('cancellation stops a blocked private stdin feed without committing its cursor', { timeout: 20000 }, async (t) => {
  const f = fixture(t), ready = join(f.cwd, 'owned-rg-ready');
  f.put('input', Buffer.alloc(2 * 1024 * 1024, 120));
  const code = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));` +
    "process.on('SIGTERM',()=>process.exit(143));setTimeout(()=>process.exit(124),10000);setInterval(()=>{},1000);";
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(f.bin, 'rg'), `#!/usr/bin/bash\nexec ${quote(process.execPath)} -e ${quote(code)}\n`, { mode: 0o700 });
  const fd = openSync(join(f.cwd, 'input'), 'r');
  t.after(() => closeSync(fd));
  const child = spawn(launcher, ['-aF', '-m1', 'needle'], { cwd: f.cwd, env: f.env, stdio: [fd, 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdout.resume(); child.stderr.resume();
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(ready), 'the owned blocked-rg fixture must actually start');
  const pid = Number(readFileSync(ready, 'utf8'));
  child.kill('SIGTERM');
  const result = await Promise.race([exit, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('blocked stdin cancellation did not complete')), 5000); timer.unref();
  })]);
  assert.deepEqual(result, { code: 143, signal: null });
  assert.match(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'), /^pos:\s*0$/m, 'uncompleted RG selection must not advance shared stdin');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'owned stalled child must be gone');
  t.diagnostic(JSON.stringify({ campaign: 'seekable-stdin-blocked-feed-cancellation', ownedFaultInvocations: 1,
    status: result.code, sharedOffsetUnchanged: true, ownedChildRemoved: true, actualRgAccelerationCredit: 0 }));
});
