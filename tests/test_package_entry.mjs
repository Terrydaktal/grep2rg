// Exercise the installed public executables, with GNU grep as a byte/status oracle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(process.env.GREP2RG_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL('../', import.meta.url)));
const cli = process.env.GREP2RG_TEST_ENTRY_BIN ?? join(root, 'bin/grep2rg');
const prefixCli = process.env.GREP2RG_TEST_PREFIX_BIN ?? join(root, 'bin/grep2rg-shell-prefix.mjs');
const baseEnv = { ...process.env, LC_ALL: 'C', LANG: 'C', TERM: 'xterm', GREP_COLORS: '', GREP_COLOR: '' };
delete baseEnv.POSIXLY_CORRECT;

function invoke(program, args, cwd, { input, env = baseEnv } = {}) {
  const result = spawnSync(program, args, { cwd, env, input, timeout: 10000, maxBuffer: 2 * 1024 * 1024, argv0: program === '/usr/bin/grep' ? 'grep' : undefined });
  assert.equal(result.error, undefined, `${program}: ${result.error?.message}`);
  assert.equal(result.signal, null, `${program}: ${result.signal}`);
  return result;
}
function exact(actual, expected, label) {
  assert.equal(actual.status, expected.status, `${label}: status`);
  assert.deepEqual(actual.stdout, expected.stdout, `${label}: stdout`);
  assert.deepEqual(actual.stderr, expected.stderr, `${label}: stderr`);
}
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-entry-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'first.txt'), 'head\nneedle needle\nother\nneedle\ntail');
  writeFileSync(join(cwd, 'second.txt'), 'other\nneedle\n');
  writeFileSync(join(cwd, 'binary'), Buffer.from('none\0needle\n'));
  writeFileSync(join(cwd, 'nul'), Buffer.from('other\0needle needle\0tail\0'));
  writeFileSync(join(cwd, 'patterns'), 'needle\nother\n');
  writeFileSync(join(cwd, 'child.sh'), '#!/usr/bin/env bash\ntype -t grep\ngrep -aFl needle first.txt\n', { mode: 0o700 });
  const bin = join(cwd, 'trace-bin'), trace = join(cwd, 'trace');
  mkdirSync(bin);
  writeFileSync(join(bin, 'rg'), '#!/usr/bin/env bash\nprintf "rg\\n" >> "$GREP2RG_ENTRY_TRACE"\nexec /usr/bin/rg "$@"\n', { mode: 0o700 });
  const env = { ...baseEnv, PATH: `${bin}:${process.env.PATH ?? ''}`, GREP2RG_ENTRY_TRACE: trace };
  return { cwd, env, calls: () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').length : 0 };
}

function prefix(program, cwd, env) {
  const result = invoke(program, [], cwd, { env });
  assert.equal(result.status, 0);
  assert.equal(result.stderr.length, 0);
  return result.stdout.toString();
}
const bash = (command, current) => invoke('/usr/bin/bash', ['--noprofile', '--norc', '-c', command], current.cwd, { env: current.env });

test('installed grep2rg preserves GNU arguments, binary stdout, diagnostics, status and stdin', (t) => {
  const current = fixture(t), { cwd } = current;
  const stdin = Buffer.from('head\nneedle needle\nother\nneedle\ntail');
  const cases = [
    ['--help'], ['--version'], ['--definitely-invalid'], ['-m'], [],
    ['-aF', 'needle', 'first.txt'], ['-aFnbo', 'needle', 'first.txt'],
    ['-aFHnC1', 'needle', 'first.txt', 'second.txt'], ['-aFc', 'needle', 'first.txt', 'first.txt'],
    ['-aFlZ', 'needle', 'first.txt', 'second.txt'], ['-aFL', 'needle', 'first.txt'],
    ['-aFq', 'needle', 'missing', 'first.txt'], ['-aFq', 'absent', 'missing', 'first.txt'],
    ['-aF', 'absent', 'first.txt'], ['-aF', 'needle', 'missing'],
    ['-F', 'needle', 'binary'], ['-aF', 'needle', 'binary'], ['-zFno', 'needle', 'nul'],
    ['-aF', '-f', 'patterns', 'first.txt'], ['-aF', '--label=stream', '-Hn', 'needle', '-'],
    ['-aF', 'needle'], ['-aF', '-m1', 'needle'], ['-aFl', 'needle'],
    ['-aF', '-f', '-', 'first.txt'], ['-aF', '-e', '', 'first.txt'],
  ];
  for (const argv of cases) {
    const input = argv.includes('-f') && argv.includes('-') ? Buffer.from('needle\n') : stdin;
    exact(invoke(cli, argv, cwd, { input }), invoke('/usr/bin/grep', argv, cwd, { input }), JSON.stringify(argv));
  }
  t.diagnostic(JSON.stringify({ campaign: 'package-entry', actualComparisons: cases.length, executable: cli }));
});

test('shell-prefix executable adapts private Bash calls and preserves native bypasses and child shells', (t) => {
  const current = fixture(t), helper = prefix(prefixCli, current.cwd, current.env);
  assert.equal(current.calls(), 0, 'printing the prefix never invokes either search engine');
  const adapted = bash(helper + "type -t grep; printf 'needle\\nother\\n' | grep -aF needle; (grep -aFn needle first.txt); for path in second.txt; do grep -aFl needle \"$path\"; done", current);
  assert.equal(adapted.status, 0);
  assert.deepEqual(adapted.stdout, Buffer.from('function\nneedle\n2:needle needle\n4:needle\nsecond.txt\n'));
  assert.equal(adapted.stderr.length, 0);
  assert.equal(current.calls(), 3, 'bare pipeline, subshell and loop calls execute the actual rg engine');
  const before = current.calls();
  const nativeCommand = "command grep -aFl needle first.txt; /usr/bin/grep -aFl needle first.txt; bash child.sh; bash -c 'type -t grep; grep -aFl needle first.txt'; export -pf | /usr/bin/grep '^declare -fx grep' || :; printenv | /usr/bin/grep '^BASH_FUNC_grep%%=' || :";
  exact(bash(helper + nativeCommand, current), bash(nativeCommand, current), 'native bypasses and non-exported descendants');
  assert.equal(current.calls(), before);
  const outside = bash('type -t grep; grep -aFl needle first.txt', current);
  assert.deepEqual(outside.stdout, Buffer.from('file\nfirst.txt\n'));
  assert.equal(current.calls(), before, 'a later ordinary shell remains native');
  const invalid = invoke(prefixCli, ['unexpected'], current.cwd);
  assert.equal(invalid.status, 2); assert.equal(invalid.stdout.length, 0); assert.match(invalid.stderr.toString(), /^Usage: grep2rg-shell-prefix\n$/);
  t.diagnostic(JSON.stringify({ campaign: 'package-prefix', actualRgInvocations: before, nativeScopeComparisons: 1 }));
});

test('shell-prefix safely quotes installed paths with spaces, apostrophes and shell substitutions', (t) => {
  const current = fixture(t), marker = join(current.cwd, 'should-never-exist');
  // If either shell substitution is executed, it only creates our owned marker.
  const tricky = join(current.cwd, "package ' $(touch should-never-exist) `touch should-never-exist`");
  mkdirSync(tricky);
  for (const directory of ['src', 'bin']) cpSync(join(root, directory), join(tricky, directory), { recursive: true });
  const isolatedHelper = prefix(join(tricky, 'bin/grep2rg-shell-prefix.mjs'), current.cwd, current.env);
  const result = bash(isolatedHelper + 'grep -aFn needle first.txt', current);
  exact(result, invoke('/usr/bin/grep', ['-aFn', 'needle', 'first.txt'], current.cwd, { env: current.env }), 'quoted package path');
  assert.equal(existsSync(marker), false, 'the helper never executes path metacharacters');
  assert.equal(current.calls(), 1);
  // An installed bin symlink retains the same public CLI behavior.
  const linked = join(current.cwd, 'linked grep2rg'); symlinkSync(cli, linked);
  const chained = join(current.cwd, 'second link'); symlinkSync(linked, chained);
  exact(invoke(chained, ['-aF', 'needle', 'first.txt'], current.cwd), invoke('/usr/bin/grep', ['-aF', 'needle', 'first.txt'], current.cwd), 'symlink chain to installed launcher');
  exact(invoke(join(tricky, 'bin/grep2rg'), ['-aF', 'needle', 'first.txt'], current.cwd), invoke('/usr/bin/grep', ['-aF', 'needle', 'first.txt'], current.cwd), 'launcher from quoted package path');
});

test('public Bash launcher preserves valid Unicode and invalid UTF-8 argument bytes', (t) => {
  const current = fixture(t), rawName = Buffer.from([0xff, 0xfe, ...Buffer.from('.txt')]);
  writeFileSync(Buffer.concat([Buffer.from(current.cwd + '/'), rawName]), Buffer.from('needle\nraw \xff\n', 'latin1'));
  writeFileSync(join(current.cwd, 'π.txt'), 'needle\ncafé\n');
  const cases = [
    [Buffer.from('-aHFn'), Buffer.from('needle'), rawName],
    [Buffer.from('-aHFn'), Buffer.from('needle'), Buffer.from('π.txt')],
    [Buffer.from('-aHFn'), Buffer.from('café'), Buffer.from('π.txt')],
    [Buffer.from('-aHFn'), Buffer.from([0xff]), rawName],
  ].map((argv) => argv.map((value) => value.toString('hex')));
  const script = `import base64,json,os,subprocess,sys
cases=json.loads(sys.argv[2]); output=[]
for encoded in cases:
    args=[bytes.fromhex(value) for value in encoded]
    actual=subprocess.run([os.fsencode(sys.argv[1]),*args],capture_output=True)
    expected=subprocess.run([b'grep',*args],executable=b'/usr/bin/grep',capture_output=True)
    pack=lambda result: [result.returncode,base64.b64encode(result.stdout).decode(),base64.b64encode(result.stderr).decode()]
    output.append({'actual':pack(actual),'expected':pack(expected)})
print(json.dumps(output))
`;
  const result = invoke('python3', ['-c', script, cli, JSON.stringify(cases)], current.cwd, { env: current.env });
  assert.equal(result.status, 0, result.stderr.toString());
  const comparisons = JSON.parse(result.stdout);
  assert.equal(comparisons.length, cases.length);
  for (const [index, comparison] of comparisons.entries()) assert.deepEqual(comparison.actual, comparison.expected, `raw argv case ${index}: ${JSON.stringify(cases[index])}`);
  assert.equal(current.calls(), 0, 'non-ASCII argv remain native before Node can decode them');
  t.diagnostic(JSON.stringify({ campaign: 'package-argv-bytes', actualComparisons: comparisons.length, argvSource: 'Python byte argv to real executable' }));
});
