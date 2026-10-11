// The installed GNU executable is the independent oracle. Fixtures contain no
// user transcripts; every subprocess is bounded and every path is disposable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { planGrep, withGrepWrapper } from "../src/grep-wrapper.mjs";

const adapter = fileURLToPath(new URL("../src/grep-wrapper.mjs", import.meta.url));
const environment = { ...process.env, LC_ALL: "C", GREP_COLORS: "", GREP_COLOR: "", TERM: "xterm" };
delete environment.POSIXLY_CORRECT;
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "grep2rg-full-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const put = (name, value) => writeFileSync(join(cwd, name), value);
  mkdirSync(join(cwd, "tree")); mkdirSync(join(cwd, "tree/skip"));
  put("a.txt", "head\nfoo foo\nbar\nfoo123\nfoobar\nfoo\nlast");
  put("b.txt", "none\nFOO\nfoo\n"); put("none.txt", "nothing\n");
  put("empty.txt", ""); put("patterns", "foo\nbar\n"); put("empty-patterns", "");
  put("byte-patterns", Buffer.from([0xff, 10])); put("nul-patterns", Buffer.from("foo\0bar\n"));
  put("bytes.txt", Buffer.from([0xff, 10, ...Buffer.from("foo\n")]));
  put("nul.txt", Buffer.from("foo\0none\0foo foo\0end"));
  put("binary", Buffer.from("before\0foo\nafter\n"));
  put("tree/a.txt", "foo\n"); put("tree/b.py", "foo\n");
  put("tree/.hidden", "foo\n"); put("tree/.gitignore", "b.py\n");
  put("tree/skip/c.txt", "foo\n"); put("exclusions", "*.py\n.hidden\n");
  symlinkSync("../b.txt", join(cwd, "tree/linked.txt"));
  return { cwd, put };
}
function invoke(program, args, cwd, { input, env = {} } = {}) {
  const result = spawnSync(program, args, { cwd, env: { ...environment, ...env }, input,
    timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${program} failed: ${result.error?.code}`);
  assert.equal(result.signal, null, `${program} terminated: ${result.signal}`);
  return result;
}
function parity(argv, cwd, settings = {}) {
  const expected = invoke("grep", argv, cwd, settings);
  const actual = invoke(process.execPath, [adapter, ...argv], cwd, settings);
  assert.equal(actual.status, expected.status, `exit status ${JSON.stringify(argv)}`);
  assert.deepEqual(actual.stdout, expected.stdout, `stdout ${JSON.stringify(argv)}`);
  assert.deepEqual(actual.stderr, expected.stderr, `stderr ${JSON.stringify(argv)}`);
  return actual;
}
function plan(argv, cwd, env = {}) {
  return planGrep(argv, { env: { ...environment, ...env }, stat: (path) => statSync(join(cwd, path)) });
}

test("qualified regex, count and context calls actually route through rg", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [
    ['-aEn', '^foo.*', 'a.txt'], ['-a', '-C1', 'foo', 'a.txt'],
    ['-ac', 'foo', 'a.txt', 'none.txt'], ['-aL', 'foo', 'a.txt', 'none.txt'],
    ['-aP', 'foo(?=123)', 'a.txt'], ['-aF', 'foo', 'a.txt'],
  ]) {
    assert.equal(plan(argv, cwd).backend, 'rg', JSON.stringify(argv));
    parity(argv, cwd);
  }
});

test("all output modes, inversions, numeric prefixes and record terminators match GNU", (t) => {
  const { cwd } = fixture(t);
  for (const args of [
    [], ['-n'], ['-b'], ['-nH'], ['-nh'], ['-bnH'], ['-TbnH'], ['-ZbnH'],
    ['-c'], ['-vc'], ['-l'], ['-L'], ['-vL'], ['-vl'], ['-q'], ['-qLc'],
    ['-o'], ['-v', '-o'], ['-nbo'], ['-c', '-o'], ['-l', '-c'], ['-L', '-c'],
    ['-C0'], ['-C1'], ['-A2', '-B1'], ['-v', '-C1'], ['-o', '-C1'],
    ['-C0', '--group-separator=next'], ['-C0', '--group-separator='], ['-C0', '--no-group-separator'],
    ['-m1'], ['-m1', '-A2'], ['-m1', '-c'], ['-m0', '-c'], ['-m0', '-L'],
    ['--line-buffered'], ['--color=always', '-Hnb'], ['--color=never'],
  ]) parity(['-a', ...args, 'foo', 'a.txt', 'none.txt', 'b.txt'], cwd);
  for (const args of [[], ['-nb'], ['-onb'], ['-c'], ['-C1'], ['-Z', '-H']])
    parity(['-az', ...args, 'foo', 'nul.txt', 'none.txt'], cwd);
});

test("fixed/basic/extended/perl patterns, multiline pattern lists and word boundaries match GNU", (t) => {
  const { cwd, put } = fixture(t);
  put('syntax.txt', 'foo+\nfooo\nfoo123\nfoo bar\nfoobar\n@\nx@x\n42\n');
  for (const argv of [
    ['-aF', 'foo+', 'syntax.txt'], ['-aG', 'foo+', 'syntax.txt'], ['-aG', 'foo\\+', 'syntax.txt'],
    ['-aE', 'foo+', 'syntax.txt'], ['-aE', 'foo|bar', 'syntax.txt'],
    ['-aP', 'foo(?=123)', 'syntax.txt'], ['-aP', '\\d+', 'syntax.txt'],
    ['-aw', '@', 'syntax.txt'], ['-ax', 'foo', 'a.txt'], ['-aw', 'foo', 'a.txt'],
    ['-aFw', '@', 'syntax.txt'], ['-aFx', 'foo', 'a.txt'],
    ['-a', '-efoo', '-ebar', 'a.txt'], ['-a', '-e', 'foo\nbar', 'a.txt'],
    ['-a', '-i', 'foo', 'b.txt'], ['-a', '-y', 'foo', 'b.txt'],
    ['-ai', '--no-ignore-case', 'foo', 'b.txt'], ['-aEo', 'foo|foobar', 'a.txt'],
  ]) parity(argv, cwd);
});

test("pattern files preserve empty lists, invalid bytes and stdin ownership", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [
    ['-a', '-f', 'patterns', 'a.txt'], ['-a', '-f', 'empty-patterns', 'a.txt'],
    ['-av', '-f', 'empty-patterns', 'a.txt'], ['-ac', '-f', 'empty-patterns', 'a.txt', 'none.txt'],
    ['-ac', '-f', 'empty-patterns', 'missing'], ['-aL', '-f', 'empty-patterns', 'a.txt', 'none.txt'],
    ['-aF', '-f', 'byte-patterns', 'bytes.txt'], ['-aF', '-f', 'nul-patterns', 'binary'],
    ['-a', '-f', 'missing-patterns', 'a.txt'], ['-a', '-f', 'patterns', '-efoo', 'a.txt'],
  ]) parity(argv, cwd);
  parity(['-a', '-f', '-', 'a.txt'], cwd, { input: Buffer.from('foo\nbar\n') });
});

test("stdin filters and mixed operands retain labels and exact bytes", (t) => {
  const { cwd } = fixture(t), input = Buffer.from('head\nfoo foo\nother\nfoo');
  for (const args of [[], ['-n'], ['-Tnb'], ['-H', '--label=relay'], ['-Z', '-H', '--label=relay'], ['-v'], ['-o'], ['-c'], ['-P', 'foo(?= )']]) {
    const pattern = args[0] === '-P' ? args.pop() : 'foo';
    parity(['-a', ...args, pattern], cwd, { input });
  }
  for (const args of [[], ['-H', '--label=relay'], ['-c'], ['-C1'], ['-Znb']])
    parity(['-a', ...args, 'foo', 'a.txt', '-', 'none.txt'], cwd, { input });
  parity(['-a', 'foo', '-', '-'], cwd, { input });
});

test("repeated explicit operands are searched and formatted twice", (t) => {
  const { cwd } = fixture(t);
  for (const flags of [['-c'], ['-L'], ['-l'], ['-n'], ['-nC0'], ['-Tnb'], ['-o'], ['-Zc']])
    parity(['-a', ...flags, 'foo', 'a.txt', 'none.txt', 'a.txt', 'none.txt'], cwd);
});

test("recursive GNU traversal includes hidden files, ignores no git rules and honors exclusion order", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [
    ['-arn', 'foo', 'tree'], ['-aRn', 'foo', 'tree'], ['-arl', 'foo', 'tree'],
    ['-arL', 'foo', 'tree'], ['-arc', 'foo', 'tree'],
    ['-arn', '--include=*.txt', 'foo', 'tree'], ['-arn', '--exclude=*.txt', 'foo', 'tree'],
    ['-arn', '--exclude-dir=skip', 'foo', 'tree'], ['-arn', '--exclude-from=exclusions', 'foo', 'tree'],
    ['-arn', '--exclude=*', '--include=*.txt', 'foo', 'tree'],
    ['-arn', '--include=*.txt', '--exclude=*', 'foo', 'tree'],
    ['-a', '--directories=skip', 'foo', 'tree', 'a.txt'],
    ['-a', '--directories=recurse', 'foo', 'tree'], ['-a', '--devices=skip', 'foo', 'a.txt'],
  ]) parity(argv, cwd);
});

test("missing operands, quiet errors and directory diagnostics match GNU", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [
    ['-a', 'foo', 'missing'], ['-ac', 'foo', 'a.txt', 'missing', 'none.txt'],
    ['-aL', 'foo', 'missing', 'none.txt'], ['-aq', 'foo', 'missing', 'a.txt'],
    ['-aq', 'foo', 'a.txt', 'missing'], ['-as', 'foo', 'missing'],
    ['-a', 'foo', 'tree'], ['-ac', 'foo', 'tree', 'none.txt'],
    ['-aL', 'foo', 'tree', 'none.txt'], ['-asc', 'foo', 'tree', 'none.txt'],
  ]) parity(argv, cwd);
});

test("invalid GNU options and untranslatable semantics go unchanged to GNU", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [
    [], ['--definitely-invalid'], ['-J', 'foo', 'a.txt'], ['--count=yes', 'foo', 'a.txt'],
    ['--d', 'foo', 'a.txt'], ['-m'], ['-mno', 'foo', 'a.txt'], ['-C-1', 'foo', 'a.txt'],
    ['-dunknown', 'foo', 'a.txt'], ['-Dunknown', 'foo', 'a.txt'],
    ['--binary-files=unknown', 'foo', 'a.txt'], ['-F', '-E', 'foo', 'a.txt'],
    ['-a', '[', 'a.txt'], ['--color=invalid', 'foo', 'a.txt'],
    ['-U', 'foo', 'a.txt'], ['-I', 'foo', 'binary'], ['foo', 'binary'],
    ['-av', 'foo', 'binary'], ['-P', '-efoo', '-ebar', 'a.txt'],
  ]) parity(argv, cwd);
  for (const argv of [['--help'], ['--version']]) parity(argv, cwd);
  assert.equal(plan(['foo', 'binary'], cwd).backend, 'grep');
  assert.equal(plan(['-I', 'foo', 'binary'], cwd).backend, 'grep');
});

test("long forms, abbreviations, numeric contexts and POSIX argument ordering match GNU", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [
    ['--text', '--extended-regexp', '--line-number', '--regexp=^foo', 'a.txt'],
    ['--text', '--fixed-strings', '--ignore-case', '--no-filename', 'foo', 'a.txt', 'b.txt'],
    ['--text', '--context=0', '--with-filename', '--byte-offset', 'foo', 'a.txt'],
    ['--text', '--null-data', '--only-matching', '--null', 'foo', 'nul.txt'],
    ['--text', '--cou', 'foo', 'a.txt'], ['--text', '--colour=always', 'foo', 'a.txt'],
    ['-a1n', 'foo', 'a.txt'], ['-a', 'foo', 'a.txt', '-n'], ['-a', '--', 'foo', 'a.txt'],
  ]) parity(argv, cwd);
  parity(['-a', 'foo', 'a.txt', '-n'], cwd, { env: { POSIXLY_CORRECT: '1' } });
  parity(['-a', 'foo', 'a.txt', '-n'], cwd, { env: { POSIXLY_CORRECT: '' } });
});

test("color capabilities and default binary reporting remain byte-exact", (t) => {
  const { cwd } = fixture(t);
  for (const env of [
    { GREP_COLORS: 'ms=1;33:mc=34:sl=44:cx=42:fn=36:se=31:ne' },
    { GREP_COLORS: 'sl=44:cx=42:rv:ne' }, { GREP_COLOR: '33' },
  ]) parity(['-avC1', '--color=always', '-Hnb', 'foo', 'a.txt'], cwd, { env });
  for (const argv of [['foo', 'binary'], ['-c', 'foo', 'binary'], ['-l', 'foo', 'binary'], ['-I', 'foo', 'binary'], ['-az', 'foo', 'binary']]) parity(argv, cwd);
});

test("missing rg transparently preserves GNU output without an LLM retry", (t) => {
  const { cwd } = fixture(t), bin = join(cwd, 'bin'); mkdirSync(bin);
  symlinkSync(realpathSync('/usr/bin/grep'), join(bin, 'grep'));
  // The wrapper itself uses the absolute running Node executable; PATH contains
  // GNU alone so no accidental rg installation can satisfy this fault case.
  for (const argv of [['-aEn', '^foo.*', 'a.txt'], ['-ac', 'foo', 'a.txt', 'none.txt'], ['-Fl', 'foo', 'a.txt']])
    parity(argv, cwd, { env: { PATH: bin } });
});

test("fixed inverse empty patterns preserve GNU's count short circuit", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [['-aFvc', '', 'a.txt', 'none.txt'], ['-aFvc', '', 'missing'], ['-aFv', '', 'a.txt'], ['-aFvL', '', 'a.txt', 'none.txt']])
    parity(argv, cwd);
});

test("broken stdout exits cleanly and leaves no synthetic rg child behind", (t) => {
  const { cwd, put } = fixture(t);
  put('large.txt', 'foo\n'.repeat(262144));
  const command = '"$@" | head -n 1', args = ['-a', 'foo', join(cwd, 'large.txt')];
  const expected = invoke('/usr/bin/bash', ['-o', 'pipefail', '-c', command, 'grep-oracle', 'grep', ...args], cwd);
  const actual = invoke('/usr/bin/bash', ['-o', 'pipefail', '-c', command, 'grep-adapter', process.execPath, adapter, ...args], cwd);
  assert.equal(expected.status, 141, 'oracle must exercise a real closed pipe');
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
  assert.doesNotMatch(actual.stderr.toString(), /Unhandled|node:events|stack|EPIPE/);
  const ownPath = join(cwd, 'large.txt').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const remaining = spawnSync('pgrep', ['-f', ownPath], { timeout: 1000 });
  assert.equal(remaining.error, undefined);
  assert.equal(remaining.status, 1, 'no command consuming the owned fixture may survive the closed pipe');
});

test("Bash byte guard preserves invalid filename bytes and Unicode arguments without changing locale", (t) => {
  const { cwd, put } = fixture(t), bin = join(cwd, 'bin'), record = join(cwd, 'rg-record');
  mkdirSync(bin); symlinkSync(realpathSync('/usr/bin/grep'), join(bin, 'grep'));
  const actualRg = realpathSync('/usr/bin/rg');
  writeFileSync(join(bin, 'rg'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nfs.appendFileSync(process.env.GREP2RG_TEST_RECORD, 'rg\\n');\nconst result = spawnSync(${JSON.stringify(actualRg)}, process.argv.slice(2), { stdio: 'inherit' });\nprocess.exitCode = result.status ?? 2;\n`, { mode: 0o755 });
  writeFileSync(Buffer.concat([Buffer.from(cwd + '/'), Buffer.from([0xff]), Buffer.from('.txt')]), 'foo\n');
  put('π.txt', 'café\nfoo\n');
  const env = { PATH: bin, LC_ALL: 'C.UTF-8', GREP2RG_TEST_RECORD: record };
  for (const command of [
    String.raw`grep -aH foo $'\xff.txt'; printf '\nLC_ALL=%s\n' "$LC_ALL"`,
    String.raw`grep -aH café π.txt; printf '\nLC_ALL=%s\n' "$LC_ALL"`,
  ]) {
    const expected = invoke('/usr/bin/bash', ['-c', command], cwd, { env });
    const wrapped = withGrepWrapper({ command, cwd }, '/usr/bin/bash');
    const actual = invoke('/usr/bin/bash', ['-c', wrapped.command], cwd, { env });
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, expected.stdout);
    assert.deepEqual(actual.stderr, expected.stderr);
    assert.match(actual.stdout.toString(), /LC_ALL=C\.UTF-8\n$/);
    assert.equal(existsSync(record), false, 'non-ASCII argv must reach GNU before Node decodes it');
  }
  const command = String.raw`grep -an foo a.txt; printf '\nLC_ALL=%s\n' "$LC_ALL"`;
  const expected = invoke('/usr/bin/bash', ['-c', command], cwd, { env });
  const wrapped = withGrepWrapper({ command, cwd }, '/usr/bin/bash');
  const actual = invoke('/usr/bin/bash', ['-c', wrapped.command], cwd, { env });
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
  assert.match(readFileSync(record, 'utf8'), /^rg\n/, 'ordinary ASCII searches still execute rg');
});

test("UTF-8 Perl matching preserves GNU handling of malformed surrogate bytes", (t) => {
  const { cwd, put } = fixture(t);
  // This malformed UTF-8 sequence exposed a real GNU 3.11 / rg 14.1.1
  // discrepancy on the installed VM. Non-C Perl semantics require GNU rather
  // than inferring compatibility from ASCII patterns or locally valid inputs.
  put('surrogate.txt', Buffer.from([0xed, 0xa0, 0x80, 0x0a]));
  const argv = ['-aP', '^.*$', 'surrogate.txt'];
  assert.equal(plan(argv, cwd, { LC_ALL: 'C.UTF-8' }).backend, 'grep');
  parity(argv, cwd, { env: { LC_ALL: 'C.UTF-8' } });
  assert.equal(plan(argv, cwd, { LC_ALL: 'C' }).backend, 'rg');
  parity(argv, cwd, { env: { LC_ALL: 'C' } });
});
