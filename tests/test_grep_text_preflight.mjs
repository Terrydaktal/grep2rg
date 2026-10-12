// Independent GNU oracle plus executable recorders: a routing plan alone does
// not prove that the search reached rg or retained binary fallback.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../bin/grep2rg.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('../bin/grep2rg', import.meta.url));
const prefix = fileURLToPath(new URL('../bin/grep2rg-shell-prefix.mjs', import.meta.url));
const base = { ...process.env, LC_ALL: 'C', GREP_COLORS: '', GREP_COLOR: '', TERM: 'dumb' };
delete base.POSIXLY_CORRECT;
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-text-preflight-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, 'bin'), trace = join(cwd, 'calls.jsonl');
  mkdirSync(bin); writeFileSync(trace, '');
  const lookup = spawnSync('sh', ['-c', 'command -v rg'], { env: base, encoding: 'utf8' });
  assert.equal(lookup.status, 0, 'real rg engine is required');
  const realRg = lookup.stdout.trim();
  for (const [name, target] of [['rg', realRg], ['grep', '/usr/bin/grep']]) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nconst fs=require('node:fs');const {spawnSync}=require('node:child_process');const argv=process.argv.slice(2);fs.appendFileSync(process.env.GREP2RG_TRACE,JSON.stringify({engine:${JSON.stringify(name)},argv})+'\\n');const result=spawnSync(${JSON.stringify(target)},argv,{stdio:'inherit',argv0:${JSON.stringify(name)}});process.exitCode=result.status??2;\n`, { mode: 0o700 });
  }
  const env = { ...base, PATH: `${bin}:${process.env.PATH}`, GREP2RG_TRACE: trace };
  const calls = () => readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const put = (name, value) => writeFileSync(join(cwd, name), value);
  put('a.txt', 'head\nneedle needle\nother\nNEEDLE\nlast needle');
  put('b.txt', 'none\nneedle\n'); put('none.txt', 'nothing\n');
  put('patterns', 'needle\nother\n');
  return { cwd, env, calls, put };
}
function parity(f, argv, { locale = 'C', input } = {}) {
  const options = { cwd: f.cwd, env: { ...f.env, LC_ALL: locale }, input,
    timeout: 10000, maxBuffer: 2 * 1024 * 1024 };
  const before = f.calls().length;
  const expected = spawnSync('/usr/bin/grep', argv, { ...options, argv0: 'grep' });
  const actual = spawnSync(process.execPath, [entry, ...argv], options);
  for (const result of [expected, actual]) {
    assert.equal(result.error, undefined, `subprocess error: ${result.error?.code}`);
    assert.equal(result.signal, null, 'bounded complete command');
  }
  assert.equal(actual.status, expected.status, JSON.stringify(argv));
  assert.deepEqual(actual.stdout, expected.stdout, `stdout ${JSON.stringify(argv)}`);
  assert.deepEqual(actual.stderr, expected.stderr, `stderr ${JSON.stringify(argv)}`);
  return f.calls().slice(before);
}
function accelerated(calls, argv) {
  assert.ok(calls.some((call) => call.engine === 'rg' && call.argv.includes('--json')), `actual rg search: ${JSON.stringify(argv)}`);
  assert.equal(calls.filter((call) => call.engine === 'grep').length, 0, `no native fallback: ${JSON.stringify(argv)}`);
}
function native(calls, argv) {
  assert.equal(calls.filter((call) => call.engine === 'rg' && call.argv.includes('--json')).length, 0, 'no speculative search');
  assert.deepEqual(calls.filter((call) => call.engine === 'grep').map((call) => call.argv), [argv], 'exact original native argv once');
}

test('ordinary text searches without -a use actual rg across GNU output modes and locales', (t) => {
  const f = fixture(t);
  const flags = [[], ['-n'], ['-nbH'], ['-c'], ['-vc'], ['-L'], ['-vL'], ['-vl'], ['-Flv'], ['-q'],
    ['-C1'], ['-A2', '-B1'], ['-m1'], ['-m1', '-A2'], ['-F', '-o'], ['-I'],
    ['--binary-files=without-match'], ['--binary-files=binary'], ['--color=always']];
  let comparisons = 0;
  for (const locale of ['C', 'C.UTF-8']) for (const args of flags) {
    const argv = [...args, 'needle', 'a.txt', 'none.txt', 'b.txt'];
    // BRE highlighting retains GNU leftmost-longest fallback, independently of
    // the text preflight. Use fixed strings to isolate the classification path.
    if (args.includes('--color=always')) argv.unshift('-F');
    accelerated(parity(f, argv, { locale }), argv); comparisons++;
  }
  t.diagnostic(JSON.stringify({ campaign: 'default-text', actualGNUComparisons: comparisons, acceleratedCommands: comparisons }));
});

test('default-binary regex, pattern-file, recursive and symlink text searches qualify', (t) => {
  const f = fixture(t); mkdirSync(join(f.cwd, 'tree')); mkdirSync(join(f.cwd, 'tree/sub'));
  f.put('tree/one.txt', 'needle\n'); f.put('tree/sub/two.txt', 'other\nneedle\n');
  f.put('tree/.hidden.txt', 'needle\n'); f.put('tree/.gitignore', '*.txt\n');
  symlinkSync('a.txt', join(f.cwd, 'linked.txt'));
  const cases = [
    ['-En', '^needle.*', 'a.txt'], ['-G', 'needle\\{1,2\\}', 'a.txt'],
    ['-P', 'needle(?= needle)', 'a.txt'], ['-f', 'patterns', 'a.txt'],
    ['-rn', '--include=*.txt', 'needle', 'tree'], ['-Irc', 'needle', 'tree'],
    ['-n', 'needle', 'linked.txt'], ['-n', 'needle', 'a.txt', 'a.txt'],
    ['-i', 'needle', 'a.txt'],
  ];
  for (const argv of cases) accelerated(parity(f, argv), argv);
  t.diagnostic(JSON.stringify({ campaign: 'default-text-structure', actualGNUComparisons: cases.length, acceleratedCommands: cases.length }));
});

test('binary and invalid UTF-8 subjects retain native behavior before any search output', (t) => {
  const f = fixture(t);
  f.put('binary.txt', Buffer.from('needle\nother\0needle\n'));
  f.put('invalid.txt', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 10, 0xff, 10]));
  f.put('split-invalid.txt', Buffer.concat([Buffer.alloc(65535, 0x78), Buffer.from([0xc3, 0x28, 10]), Buffer.from('needle\n')]));
  let comparisons = 0;
  for (const locale of ['C', 'C.UTF-8']) for (const flags of [[], ['-I'], ['-c'], ['-v', '-C1'], ['-vl'], ['-Flv'], ['-q']]) {
    const argv = [...flags, 'needle', 'a.txt', 'binary.txt'];
    native(parity(f, argv, { locale }), argv); comparisons++;
  }
  for (const name of ['invalid.txt', 'split-invalid.txt']) for (const flags of [[], ['-I'], ['-n'], ['-c']]) {
    const argv = [...flags, 'needle', name];
    native(parity(f, argv, { locale: 'C.UTF-8' }), argv); comparisons++;
  }
  const byteArgv = ['-n', 'needle', 'invalid.txt'];
  accelerated(parity(f, byteArgv), byteArgv); comparisons++;
  t.diagnostic(JSON.stringify({ campaign: 'default-text-binary-guard', actualGNUComparisons: comparisons }));
});

test('complete UTF-8 classification preserves multibyte sequences split across read chunks', (t) => {
  const f = fixture(t);
  f.put('split-valid.txt', Buffer.concat([Buffer.alloc(65535, 0x78), Buffer.from('é\nneedle\n')]));
  f.put('bom.txt', Buffer.from('\ufeffneedle\nother\n'));
  for (const name of ['split-valid.txt', 'bom.txt']) {
    const argv = ['-n', 'needle', name];
    accelerated(parity(f, argv, { locale: 'C.UTF-8' }), argv);
  }
});

test('complete text above 16 MiB uses rg while stdin retains native input ownership', (t) => {
  const f = fixture(t);
  f.put('large.txt', Buffer.concat([Buffer.alloc(17 * 1024 * 1024, 0x78), Buffer.from('\nlate needle\n')]));
  let comparisons = 0, searches = 0;
  for (const flags of [[], ['-I'], ['-c']]) {
    const argv = [...flags, 'needle', 'large.txt'];
    const calls = parity(f, argv); accelerated(calls, argv); comparisons++;
    searches += calls.filter((call) => call.engine === 'rg' && call.argv.includes('--json')).length;
  }
  for (const flags of [[], ['-I'], ['-n'], ['-c'], ['-m1'], ['-q']]) {
    const argv = [...flags, 'needle'];
    native(parity(f, argv, { input: Buffer.from('before\nneedle\nafter\n') }), argv);
  }
  const mixed = ['-n', 'needle', 'a.txt', '-'];
  native(parity(f, mixed, { input: Buffer.from('needle\n') }), mixed);
  t.diagnostic(JSON.stringify({ campaign: 'text-stream-large-payload', actualGNUComparisons: comparisons, actualRgSearchInvocations: searches, subjectBytes: 17 * 1024 * 1024 + 13 }));
});

test('complete text across operands has no old aggregate 16 MiB payload cutoff', (t) => {
  const f = fixture(t);
  for (const name of ['eight-a.txt', 'eight-b.txt'])
    f.put(name, Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 0x78), Buffer.from('\n')]));
  const argv = ['-c', 'needle', 'eight-a.txt', 'eight-b.txt'];
  const calls = parity(f, argv); accelerated(calls, argv);
  t.diagnostic(JSON.stringify({ campaign: 'text-stream-aggregate-payload', actualGNUComparisons: 1,
    actualRgSearchInvocations: calls.filter((call) => call.engine === 'rg' && call.argv.includes('--json')).length }));
});

test('complete text above 4096 selected file occurrences reaches real rg', (t) => {
  const f = fixture(t); mkdirSync(join(f.cwd, 'many'));
  for (let index = 0; index < 4097; index++) f.put(`many/f${index.toString().padStart(4, '0')}`, '');
  const argv = ['-r', 'needle', 'many'];
  const calls = parity(f, argv); accelerated(calls, argv);
  t.diagnostic(JSON.stringify({ campaign: 'text-stream-many-files', actualGNUComparisons: 1, selectedFiles: 4097,
    actualRgSearchInvocations: calls.filter((call) => call.engine === 'rg' && call.argv.includes('--json')).length }));
});

test('the streaming proof still detects binary and invalid UTF-8 bytes after 16 MiB', (t) => {
  const f = fixture(t);
  const lead = Buffer.alloc(17 * 1024 * 1024, 0x78);
  f.put('late-nul', Buffer.concat([lead, Buffer.from('\nneedle\0tail\n')]));
  f.put('late-invalid', Buffer.concat([lead, Buffer.from('\nneedle\n'), Buffer.from([0xff, 10])]));
  let comparisons = 0;
  for (const flags of [[], ['-I'], ['-c']]) {
    const nul = [...flags, 'needle', 'late-nul']; native(parity(f, nul), nul); comparisons++;
    const invalid = [...flags, 'needle', 'late-invalid']; native(parity(f, invalid, { locale: 'C.UTF-8' }), invalid); comparisons++;
  }
  t.diagnostic(JSON.stringify({ campaign: 'text-stream-late-binary-guard', actualGNUComparisons: comparisons, actualRgSearchInvocations: 0 }));
});

test('an invalid UTF-8 cwd cannot classify a replacement-character decoy instead of the real operand', (t) => {
  const f = fixture(t);
  const script = `import json,os,subprocess,sys
base=os.fsencode(sys.argv[1]);raw=base+b'/raw-\\xff';decoy=base+'/raw-\\ufffd'.encode()
os.mkdir(raw);os.mkdir(decoy)
with open(raw+b'/input','wb') as out:out.write(b'needle\\x00tail\\n')
with open(decoy+b'/input','wb') as out:out.write(b'needle\\n')
def run(argv,**kw):
 p=subprocess.run(argv,cwd=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8,**kw)
 return {'status':p.returncode,'stdout':p.stdout.hex(),'stderr':p.stderr.hex()}
expected=run(['grep','-F','needle','input'],executable='/usr/bin/grep')
definition=subprocess.check_output([sys.argv[2],sys.argv[5]],timeout=8).decode()
actual=[run([sys.argv[2],sys.argv[3],'-F','needle','input']),run([sys.argv[4],'-F','needle','input']),run(['bash','-c',definition+'\\ngrep -F needle input'])]
print(json.dumps({'expected':expected,'actual':actual}))`;
  const result = spawnSync('python3', ['-c', script, f.cwd, process.execPath, entry, launcher, prefix],
    { cwd: f.cwd, env: { ...f.env, LC_ALL: 'C.UTF-8' }, timeout: 30000, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.expected.stdout, '', 'GNU does not publish binary content');
  assert.ok(report.expected.stderr.length > 0, 'GNU binary diagnostic is the oracle');
  for (const actual of report.actual) assert.deepEqual(actual, report.expected);
  assert.equal(f.calls().filter((call) => call.engine === 'rg').length, 0, 'raw cwd routes native before inspection');
  assert.equal(f.calls().filter((call) => call.engine === 'grep').length, 3);
});
