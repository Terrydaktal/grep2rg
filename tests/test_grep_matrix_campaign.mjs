// A deterministic differential campaign, not a claim of universal grep parity.
// Every comparison executes both the public Node CLI and GNU grep on synthetic
// data. The larger tier is explicit: GREP2RG_DEEP=1 node --test THIS_FILE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { planGrep } from '../src/grep-wrapper.mjs';
import { fixture as cliFixture } from './grep_extended_helpers.mjs';

const adapter = fileURLToPath(new URL('../src/grep-wrapper.mjs', import.meta.url));
const seed = 0xc0a7e512;
const comparisons = process.env.GREP2RG_DEEP === '1' ? 4096 : 1024;
const concurrency = 8;
const maximumOutput = 2 * 1024 * 1024;
const baseEnv = { ...process.env, LC_ALL: 'C', GREP_COLORS: '', GREP_COLOR: '', TERM: 'xterm' };
delete baseEnv.POSIXLY_CORRECT;

export const grepCampaignRequirements = [
  'records: LF, NUL, CRLF, missing terminators, empty files and malformed bytes',
  'matching: fixed, BRE, ERE, Perl, case/word/line flags and ordered -e lists',
  'output: counts, names, quiet, invert, fragments, n/b/H/h/T/Z, colors and contexts',
  'state: max-count, zero-width selection, duplicate operands, argument order and stdin',
  'execution: exact bytes/status, bounded subprocesses and verified rg invocation',
];

function generator(initial) {
  let state = initial >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-matrix-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const random = generator(seed ^ 0x71e5cafe), files = [], nullFiles = [], data = new Map();
  const fragments = ['foo', 'foo foo', 'alpha', 'bar', 'foo123', 'foobar', 'none', '', 'a+b', '@', 'x@y', '42', 'FOO', 'prefix foo suffix', 'éfoo', '🙂 foo', 'foo\r', 'quote "foo"', 'foo\talpha'];
  for (let index = 0; index < 24; index++) {
    const records = ['head', 'foo foo', 'alpha', '', 'foo123', 'foobar', 'a+b', 'last'];
    for (let line = 0; line < 56 + index; line++) records.splice(random() % records.length, 0, fragments[random() % fragments.length]);
    const regular = Buffer.from(records.join(index % 4 === 0 ? '\r\n' : '\n') + (index % 3 ? '\n' : ''));
    const nul = Buffer.from(records.join('\0') + (index % 3 ? '\0' : ''));
    // C-locale matching must preserve invalid UTF-8 bytes in printed records.
    const invalid = Buffer.from([0xff, ...Buffer.from(' foo\n'), 0xed, 0xa0, 0x80, 10]);
    const name = index % 5 === 0 ? `file ${index}.txt` : `file-${index}.txt`, nullName = `records-${index}.nul`;
    const bytes = index % 7 === 0 ? Buffer.concat([regular, invalid]) : regular;
    writeFileSync(join(cwd, name), bytes); writeFileSync(join(cwd, nullName), nul);
    files.push(name); nullFiles.push(nullName); data.set(name, bytes); data.set(nullName, nul);
  }
  writeFileSync(join(cwd, 'empty.txt'), ''); writeFileSync(join(cwd, 'absent.txt'), 'nothing matches here\n');
  return { cwd, files, nullFiles, data };
}

function execute(program, args, cwd, env, input) {
  return new Promise((resolve) => {
    const stdout = [], stderr = [];
    let outputBytes = 0, failure = null, closed = false;
    const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const terminate = (reason) => {
      failure ??= reason;
      if (!child.pid || closed) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure = `${reason}; ${error.code}`; }
    };
    const timer = setTimeout(() => terminate('subprocess exceeded 8 seconds'), 8000);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutput) terminate('subprocess exceeded 2 MiB capture limit');
      else chunks.push(chunk);
    });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') terminate(`stdin: ${error.code}`); });
    child.once('error', (error) => { failure = `spawn: ${error.code}`; });
    child.once('close', (status, signal) => {
      closed = true; clearTimeout(timer);
      resolve({ status, signal, failure, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}
const digest = (value) => ({ bytes: value.length, sha256: createHash('sha256').update(value).digest('hex'), leadingHex: value.subarray(0, 96).toString('hex') });
function difference(reference, actual, item) {
  if (reference.failure || actual.failure || reference.signal || actual.signal || reference.status !== actual.status || !reference.stdout.equals(actual.stdout) || !reference.stderr.equals(actual.stderr)) {
    return { seed: `0x${seed.toString(16)}`, index: item.index, argv: item.argv, env: item.env, stdin: item.input ? digest(item.input) : null,
      expected: { status: reference.status, signal: reference.signal, failure: reference.failure, stdout: digest(reference.stdout), stderr: digest(reference.stderr) },
      actual: { status: actual.status, signal: actual.signal, failure: actual.failure, stdout: digest(actual.stdout), stderr: digest(actual.stderr) } };
  }
  return null;
}

function cases(f) {
  const random = generator(seed), seen = new Set(), result = [];
  const matchers = [
    ['-F', ['foo']], ['-F', ['foo', 'alpha']], ['-F', ['a+b']], ['-F', ['not-found-xyz']],
    ['-F', ['']], ['-G', ['foo.*']], ['-G', ['^foo']], ['-G', ['foo\\+']],
    ['-G', ['\\<foo\\>']], ['-E', ['foo|alpha']], ['-E', ['^f(o+)']], ['-E', ['[[:digit:]]+']],
    ['-P', ['foo(?= )']], ['-P', ['\\d+']], ['-P', ['^.*$']], ['-P', ['(?<= )foo']],
  ];
  const modes = [[], ['-c'], ['-l'], ['-L'], ['-q'], ['-o'], ['-c', '-o'], ['-l', '-c'], ['-L', '-c'], ['-q', '-L', '-c'], ['-q', '-l'], ['-q', '-l', '-c']];
  const colors = ['', 'mt=1;33:fn=34:ln=36:bn=35:se=31:ne', 'sl=44:cx=42:ms=1;33:mc=1;35:ne', 'sl=44:cx=42:rv:ne', 'ms=:mc=:ne'];
  while (result.length < comparisons) {
    const argv = ['-a'], env = {}, [matcher, patterns] = matchers[random() % matchers.length];
    argv.push(matcher, ...modes[random() % modes.length]);
    const nullData = random() % 5 === 0;
    if (nullData) argv.push('-z');
    if (random() % 3 === 0) argv.push('-v');
    if (random() % 5 === 0) argv.push('-i');
    if (random() % 6 === 0) argv.push('-w');
    if (random() % 9 === 0) argv.push('-x');
    for (const flag of ['-n', '-b', '-T', '-Z']) if (random() & 1) argv.push(flag);
    const filename = random() % 3; if (filename === 1) argv.push('-H'); if (filename === 2) argv.push('-h');
    const context = random() % 5;
    if (context === 1) argv.push(`-C${random() % 4}`);
    if (context === 2) argv.push(`-A${random() % 4}`, `-B${random() % 4}`);
    if (context === 3) argv.push(`-${random() % 4}`);
    if (context === 4) argv.push('-C0', random() & 1 ? '--group-separator=next' : '--no-group-separator');
    if (random() % 3 === 0) argv.push(`-m${random() % 4}`);
    if (random() % 4 === 0) { argv.push('--color=always'); env.GREP_COLORS = colors[random() % colors.length]; }
    if (random() % 11 === 0) env.LC_ALL = 'C.UTF-8';
    for (const pattern of patterns) argv.push('-e', pattern);
    const pool = nullData ? f.nullFiles : f.files, first = pool[random() % pool.length], second = pool[random() % pool.length];
    const order = random() % 7;
    let paths = order === 0 ? [first] : order === 1 ? [second, first] : order === 2 ? [first, second, first] : order === 3 ? ['empty.txt', first, 'absent.txt'] : [first, second];
    let input;
    if (order === 4 || order === 5) {
      const source = pool[random() % pool.length]; input = f.data.get(source);
      paths = order === 4 ? [first, '-', second] : ['-'];
      argv.push('--label', `stream-${result.length % 19}`);
    }
    argv.push('--', ...paths);
    const identity = JSON.stringify([argv, env, input ? createHash('sha256').update(input).digest('hex') : null]);
    if (seen.has(identity)) continue;
    seen.add(identity); result.push({ index: result.length, argv, env, input });
  }
  return result;
}

async function compareNamed(t, name, content, argv, overrides = {}, extras = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-regression-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'input'), content);
  for (const [path, value] of Object.entries(extras)) writeFileSync(join(cwd, path), value);
  const env = { ...baseEnv, ...overrides };
  const [reference, actual] = await Promise.all([
    execute('grep', argv, cwd, env), execute(process.execPath, [adapter, ...argv], cwd, env),
  ]);
  assert.equal(difference(reference, actual, { index: name, argv, env: overrides }), null, name);
}

test('regression: quiet takes precedence over filenames in the fixed-string fast route', async (t) => {
  await compareNamed(t, 'quiet with filename output', 'foo\nbar\n', ['-aFql', 'foo', 'input']);
  t.diagnostic(JSON.stringify({ actualComparisons: 1 }));
});

test('regression: initial-tab width includes EOF and empty records omit the tab', async (t) => {
  for (const flags of ['-aFvnT', '-aFvnbTH']) {
    await compareNamed(t, flags, '\nbar\nfoo\n', [flags, 'foo', 'input']);
  }
  t.diagnostic(JSON.stringify({ actualComparisons: 2 }));
});

test('regression: CRLF line colors leave only an unmatched final CR uncolored', async (t) => {
  await compareNamed(t, 'inverse CRLF color', '\r\nbar\r\nbar\r\r\nfoo\r\n', ['-aFv', '--color=always', 'foo', 'input'], { GREP_COLORS: 'sl=44:ne' });
  for (const pattern of ['foo', 'foo\r']) {
    await compareNamed(t, `CR match ${JSON.stringify(pattern)}`, 'foo\r\n', ['-aF', '--color=always', pattern, 'input'], { GREP_COLORS: 'sl=44:ms=31:ne' });
  }
  t.diagnostic(JSON.stringify({ actualComparisons: 3 }));
});

test('regression: inverse-only-matching preserves context fragments and empty output groups', async (t) => {
  for (const flags of ['-aFvoC0', '-aFvnoC1', '-aFvnboC1']) {
    await compareNamed(t, flags, 'a\nfoo foo\nb\nfoo\nfoo\nfoo\nb\n', [flags, 'foo', 'input']);
  }
  await compareNamed(t, 'inverse context color', 'foo\nfoo\nbar\n', ['-aFvnoC1', '--color=always', 'foo', 'input'], { GREP_COLORS: 'ms=31:mc=35:ne' });
  await compareNamed(t, 'zero-width groups across operands', 'a\nb\n', ['-aEoC0', '^', 'input', 'other'], {}, { other: 'c\nd\n' });
  t.diagnostic(JSON.stringify({ actualComparisons: 5 }));
});

test('regression: inverse regex max-count ends after exactly the trailing context', async (t) => {
  const content = '@\nfoobar\nfoo alpha\nhead\nnone\nfoo\nnone\nnone\n';
  for (const [matcher, pattern] of [['-E', '^f(o+)'], ['-P', 'foo(?= )']]) {
    for (const context of ['-A3', '-C3', '-A0', '-B2']) {
      for (const mode of [[], ['-nb'], ['-o', '-nb']]) {
        const sample = context === '-B2' ? 'foo foo\nfoo foo\nfoo foo\nhead\nnone\nfoo\nnone\n' : content;
        await compareNamed(t, `${matcher} ${context} ${mode.join(' ')}`, sample, ['-a', matcher, '-v', '-m1', context, ...mode, pattern, 'input']);
      }
    }
  }
  t.diagnostic(JSON.stringify({ actualComparisons: 24 }));
});

test('regression: whole-line word spans retain GNU empty delimiters and empty match colors', (t) => {
  const f = cliFixture(t);
  for (const [nullData, content] of [[false, 'foo\nxx\nfoo\n42\n'], [true, 'foo\0xx\0foo\x0042\0']]) {
    const operand = nullData ? 'span-records.nul' : 'span-lines.txt'; f.put(operand, content);
    for (const matcher of ['G', 'E', 'F']) for (const colors of ['', 'ms=:mc=:ne']) {
      f.env.GREP_COLORS = colors;
      for (const output of [['-o', '-n', '-b'], ['--color=always', '-n', '-H']])
        f.compare(['-a', `-${matcher}`, ...(nullData ? ['-z'] : []), '-w', '-x', ...output,
          '-C0', '--no-group-separator', '-e', 'foo', '--', operand],
          { spanBroker: true });
    }
  }
  f.env.GREP_COLORS = 'ms=:mc=:ne';
  f.put('digits.txt', '42\nnone\n42\n');
  f.compare(['-aE', '-i', '-w', '-x', '-n', '-H', '-C0', '--no-group-separator', '--color=always',
    '-e', '[[:digit:]]+', '--', 'digits.txt'], { spanBroker: true });
  f.env.GREP_COLORS = ''; f.put('alternatives.txt', 'alpha\nnone\nfoo\n');
  f.compare(['-aE', '-o', '-w', '-x', '-C0', '--group-separator=next', '-e', 'foo|alpha',
    '--', 'alternatives.txt', 'alternatives.txt'], { spanBroker: true });
  t.diagnostic(JSON.stringify(f.diagnostic('matrix-whole-line-word-span-delimiters')));
});

test('regression: repeated NUL whole-record selections retain fixed-string extraction spans', (t) => {
  const f = cliFixture(t);
  f.put('repeated.nul', 'foo\0xx\0foo\0FOO\0foo\0'); f.put('empty.txt', '');
  for (const locale of ['C', 'C.UTF-8']) for (const fold of [[], ['-i']]) {
    for (const output of [[], ['-o'], ['-o', '-n', '-b', '-T', '-Z'], ['--color=always', '-n', '-b']])
      f.compare(['-aF', '-z', '-x', ...fold, ...output, '-C0', '-e', 'foo', '--',
        'empty.txt', 'repeated.nul', 'empty.txt'], { locale });
  }
  t.diagnostic(JSON.stringify(f.diagnostic('matrix-repeated-NUL-whole-record-spans')));
});

test(`generated GNU differential matrix (${comparisons} distinct actual CLI comparisons)`, { timeout: comparisons > 1024 ? 600000 : 180000 }, async (t) => {
  const f = fixture(t), items = cases(f), failures = [];
  let next = 0, completed = 0, mismatches = 0, rgPlans = 0, nativePlans = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const item = items[next++], env = { ...baseEnv, ...item.env };
      const routing = planGrep(item.argv, { env, stat: (path) => statSync(join(f.cwd, path)) });
      if (routing.backend === 'rg') rgPlans++; else nativePlans++;
      const [reference, actual] = await Promise.all([
        execute('grep', item.argv, f.cwd, env, item.input),
        execute(process.execPath, [adapter, ...item.argv], f.cwd, env, item.input),
      ]);
      const mismatch = difference(reference, actual, item);
      if (mismatch) { mismatches++; if (failures.length < 16) failures.push(mismatch); }
      completed++;
    }
  }));
  t.diagnostic(JSON.stringify({ seed: `0x${seed.toString(16)}`, actualComparisons: completed, distinctCases: items.length, mismatches, rgRoutingPlans: rgPlans, nativeRoutingPlans: nativePlans, concurrency }));
  assert.equal(completed, comparisons);
  assert.equal(items.length, comparisons);
  assert.ok(rgPlans >= comparisons / 4, 'campaign must exercise qualified rg routes, not only GNU fallback');
  assert.equal(mismatches, 0, `GNU parity failures (first ${failures.length}):\n${JSON.stringify(failures, null, 2)}`);
});

test('qualified matrix routes execute rg, verified by an owned executable recorder', { timeout: 30000 }, async (t) => {
  const f = fixture(t), bin = join(f.cwd, 'bin'), record = join(f.cwd, 'rg-invocations');
  mkdirSync(bin); symlinkSync(realpathSync('/usr/bin/grep'), join(bin, 'grep'));
  const actualRg = realpathSync('/usr/bin/rg');
  writeFileSync(join(bin, 'rg'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nfs.appendFileSync(process.env.GREP2RG_MATRIX_RECORD, 'rg\\n');\nconst result = spawnSync(${JSON.stringify(actualRg)}, process.argv.slice(2), { stdio: 'inherit' });\nprocess.exitCode = result.status ?? 2;\n`, { mode: 0o755 });
  const env = { ...baseEnv, PATH: bin, GREP2RG_MATRIX_RECORD: record };
  let count = 0;
  for (const options of [[], ['-n'], ['-b'], ['-Tnb'], ['-Znb'], ['-c'], ['-L'], ['-l'], ['-q'], ['-o'], ['-v'], ['-C0'], ['-C1'], ['-A2', '-B1'], ['-m1', '-c'], ['--color=always', '-Hnb']]) {
    const argv = ['-aF', ...options, 'foo', f.files[0], f.files[1]];
    assert.equal(planGrep(argv, { env, stat: (path) => statSync(join(f.cwd, path)) }).backend, 'rg');
    const before = count;
    const [reference, actual] = await Promise.all([execute('grep', argv, f.cwd, env), execute(process.execPath, [adapter, ...argv], f.cwd, env)]);
    assert.equal(difference(reference, actual, { index: count, argv, env: { PATH: 'owned recorder', LC_ALL: 'C' } }), null);
    count = readFileSync(record, 'utf8').split('\n').filter(Boolean).length;
    assert.ok(count > before, `rg must actually execute: ${JSON.stringify(argv)}`);
  }
  t.diagnostic(JSON.stringify({ actualComparisons: 16, actualRgInvocations: count }));
});
