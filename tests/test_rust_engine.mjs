// GNU is the independent byte/status/diagnostic oracle. Route assertions are
// separate: delegating to GNU never earns native Rust search coverage.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BINARY = process.env.GREP2RG_RUST_BINARY || fileURLToPath(new URL('../rust/target/release/grep2rg-rust', import.meta.url));
const SEED = 0x728ca451;
const CAMPAIGN_CASES = 384;
const ERE_BOUNDARY_SEED = 0x45524531;
const ERE_BOUNDARY_CASES = 768;
const CONTRACT = JSON.parse(readFileSync(new URL('./rust-engine-contract.json', import.meta.url), 'utf8'));
const BASE_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C', TERM: 'dumb', GREP_COLORS: '', GREP_COLOR: '' };
for (const key of Object.keys(BASE_ENV)) if (key.startsWith('GREP2RG_')) delete BASE_ENV[key];
delete BASE_ENV.POSIXLY_CORRECT;
delete BASE_ENV.GREP_OPTIONS;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const resultSummary = (result) => ({ status: result.status, signal: result.signal,
  stdoutHex: result.stdout.subarray(0, 4096).toString('hex'), stderrHex: result.stderr.subarray(0, 4096).toString('hex'),
  stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length });

function fixture(t, seed = SEED) {
  assert.ok(existsSync(BINARY), `Build the real release artifact before qualification: ${BINARY}`);
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-rust-oracle-'));
  const artifactHash = digest(readFileSync(BINARY));
  const metrics = { seed: `0x${seed.toString(16)}`, comparisons: 0, rustSearches: 0, gnuFallbacks: 0, classes: {}, failures: [] };
  let sequence = 0;
  function put(name, bytes) { writeFileSync(join(cwd, name), bytes); }
  function invoke(program, argv, { input = Buffer.alloc(0), locale = 'C', pipe = false, report, transport } = {}) {
    const environment = { ...BASE_ENV, LC_ALL: locale, ...(report ? { GREP2RG_ENGINE_REPORT: report } : {}) };
    const options = { cwd, env: environment, timeout: 5000, maxBuffer: 8 * 1024 * 1024, argv0: 'grep' };
    let fd;
    if (!pipe) {
      const inputFile = join(cwd, '.oracle-stdin'); writeFileSync(inputFile, input);
      fd = openSync(inputFile, 'r'); options.stdio = [fd, 'pipe', 'pipe'];
    } else options.input = input;
    try {
      const script = transport === 'cursor'
        ? 'program=$1; shift; "$program" "$@"; status=$?; printf "\\nCURSOR-TAIL\\n"; /usr/bin/cat; exit "$status"'
        : transport === 'closed-output'
          ? 'set -o pipefail; program=$1; shift; "$program" "$@" | /usr/bin/head -c 1'
          : transport === 'limited-descriptors'
            ? 'ulimit -n 64; program=$1; shift; exec "$program" "$@"'
          : undefined;
      const result = script === undefined ? spawnSync(program, argv, options)
        : spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-c', script, 'owned-rust-stream-oracle', program, ...argv], options);
      assert.equal(result.error, undefined, `${program} execution failed: ${result.error?.message}`);
      assert.equal(result.signal, null, `${program} timed out or was signalled`);
      return result;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  function compare(id, argv, { native = false, ...options } = {}) {
    const reportPath = join(cwd, `.engine-report-${sequence++}.json`);
    const expected = invoke('/usr/bin/grep', argv, options);
    const actual = invoke(BINARY, argv, { ...options, report: reportPath });
    assert.ok(existsSync(reportPath), `${id}: execution route report is required`);
    const route = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.ok(['rust', 'gnu'].includes(route.engine), `${id}: unknown route ${JSON.stringify(route)}`);
    metrics.comparisons++;
    metrics[route.engine === 'rust' ? 'rustSearches' : 'gnuFallbacks']++;
    metrics.classes[id] = (metrics.classes[id] || 0) + 1;
    const witness = { id, argv, cwd, transport: options.transport || 'direct', stdinDescriptor: options.pipe ? 'pipe' : 'seekable file',
      locale: options.locale || 'C', stdinHex: (options.input || Buffer.alloc(0)).toString('hex'),
      route, GNU: resultSummary(expected), Rust: resultSummary(actual) };
    try {
      assert.equal(actual.status, expected.status, `${id}: status`);
      assert.ok(actual.stdout.equals(expected.stdout), `${id}: stdout bytes`);
      assert.ok(actual.stderr.equals(expected.stderr), `${id}: stderr bytes`);
      if (native) assert.equal(route.engine, 'rust', `${id}: genuine Rust search required`);
    } catch (error) {
      metrics.failures.push(witness);
      throw new Error(`${error.message}\n${JSON.stringify(witness)}`, { cause: error });
    }
    return route;
  }
  t.after(() => {
    const reportPath = join(cwd, 'oracle-results.json');
    writeFileSync(reportPath, JSON.stringify({ ...metrics, binary: BINARY, artifactSHA256: artifactHash }, null, 2) + '\n');
    t.diagnostic(JSON.stringify({ ...metrics, artifactSHA256: artifactHash, failures: metrics.failures.length,
      evidence: metrics.failures.length ? reportPath : undefined }));
    assert.equal(digest(readFileSync(BINARY)), artifactHash, 'release binary changed during qualification');
    if (!metrics.failures.length) rmSync(cwd, { recursive: true, force: true });
  });
  put('hit', 'head\nneedle needle\ntail\n');
  put('miss', 'head\nother\ntail\n');
  put('empty', '');
  put('unterminated', 'head\nneedle');
  put('nul-records', Buffer.from('head\0needle\0needle other\0tail'));
  put('binary', Buffer.from('head\0needle\n'));
  put('patterns', 'needle\nother\n');
  put('empty-patterns', '');
  put('blank-patterns', '\n');
  put('overlap', 'a aa aaa\nneedle needle_word (needle)\n');
  put('CRLF', 'needle\r\nother\r\nneedle');
  put('raw-records', Buffer.concat([Buffer.from([0xff]), Buffer.from('needle\nother\nneedle'), Buffer.from([0xfe])]));
  put('unicode', 'K\nK\nk\nİ\nI\ni\nı\nß\nẞ\n');
  mkdirSync(join(cwd, 'tree')); mkdirSync(join(cwd, 'tree', '.git')); mkdirSync(join(cwd, 'tree', 'nested'));
  writeFileSync(join(cwd, 'tree', '.gitignore'), '*.txt\n');
  writeFileSync(join(cwd, 'tree', '.hidden'), 'needle\n');
  writeFileSync(join(cwd, 'tree', '.git', 'synthetic'), 'needle\n');
  writeFileSync(join(cwd, 'tree', 'a.txt'), 'needle\nother\n');
  writeFileSync(join(cwd, 'tree', 'z.txt'), 'other\n');
  writeFileSync(join(cwd, 'tree', 'nested', 'b.txt'), 'needle\n');
  symlinkSync('../hit', join(cwd, 'tree', 'linked-file'));
  symlinkSync('nested', join(cwd, 'tree', 'linked-directory'));
  return { cwd, put, compare, metrics };
}

test('Rust release engine covers the 28 measured search classes against GNU', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  f.put('long-record', `${'x'.repeat(131072)}needle${'x'.repeat(131072)}\nother\n`);
  const explicit = ['tree/a.txt', 'tree/z.txt', 'tree/.hidden', 'tree/nested/b.txt'];
  const classes = [
    ['recursive-count', ['-arcF', 'needle', 'tree'], true],
    ['recursive-invert-count', ['-arcvF', 'needle', 'tree'], true],
    ['recursive-filenames-sparse', ['-rlF', 'needle', 'tree'], true],
    ['recursive-filenames-no-match', ['-rlF', 'absent', 'tree'], true],
    ['explicit-count', ['-acF', 'needle', ...explicit], true],
    ['explicit-filenames-sparse', ['-lF', 'needle', ...explicit], true],
    ['explicit-filenames-no-match', ['-lF', 'absent', ...explicit], true],
    ['single-large-count-native', ['-acF', 'needle', 'long-record'], true],
    ['small-file-native', ['-nF', 'needle', 'hit'], true],
    ['stdin-native', ['-nF', 'needle'], true, Buffer.from('head\nneedle\ntail\n')],
    ['regex-compatible-count', ['-acE', '(other|needle).*', ...explicit], true],
    ['recursive-dense-filenames-native', ['-rlF', 'needle', 'tree'], true],
    ['small-recursive-count-native', ['-arcF', 'needle', 'tree'], true],
    ['many-tiny-count-native', ['-arcF', 'needle', 'tree'], true],
    ['below-threshold-count-native', ['-arcF', 'needle', 'tree'], true],
    ['long-record-count-native', ['-acF', 'needle', 'long-record'], true],
    ['long-record-content-native', ['-anF', 'needle', 'long-record'], true],
    ['recursive-content', ['-arnF', 'needle', 'tree'], true],
    ['recursive-regex-content', ['-arnE', 'needle|absent', 'tree'], true],
    ['recursive-filter-native', ['-arlF', '--include=*.txt', 'needle', 'tree'], false],
    ['recursive-dereference-native', ['-arlRF', 'needle', 'tree'], true],
    ['word-extraction-native', ['-aFwo', 'needle', 'overlap'], true],
    ['null-records-native', ['-azFc', 'needle', 'nul-records'], true],
    ['pattern-file-native', ['-acF', '-f', 'patterns', 'hit'], true],
    ['quiet-native', ['-aqF', 'needle', 'hit'], true],
    ['binary-content-native', ['-nF', 'needle', 'binary'], false],
    ['unicode-folding-native', ['-aiF', 'K', 'unicode'], false],
    ['context-native', ['-aF', '-C', '3', 'needle', 'hit'], false],
  ];
  assert.equal(classes.length, 28);
  assert.deepEqual(classes.filter(([, , native]) => native).map(([id]) => id), CONTRACT.nativeRequiredClasses);
  assert.deepEqual(classes.filter(([, , native]) => !native).map(([id]) => id), CONTRACT.fallbackAllowedClasses);
  const failures = [];
  for (const [id, argv, native, input] of classes) {
    try { f.compare(id, argv, { native, input, pipe: id === 'stdin-native' }); } catch (error) { failures.push(error.message); }
  }
  assert.equal(failures.length, 0, failures.slice(0, 6).join('\n'));
});

test('Rust release engine preserves grep option interactions and input boundaries', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  const cases = [
    ['empty-record', ['-aF', '', 'hit']], ['empty-only-matching', ['-aFo', '', 'hit']],
    ['empty-invert', ['-aFv', '', 'hit']], ['empty-pattern-file', ['-aF', '-f', 'empty-patterns', 'hit']],
    ['blank-pattern-file', ['-aF', '-f', 'blank-patterns', 'hit']],
    ['mixed-empty-pattern', ['-aFn', '-e', 'absent', '-e', '', 'hit']],
    ['regression-empty-and-nonempty-extraction', ['-aFo', '-e', '', '-e', 'needle', 'hit']],
    ['multi-pattern-overlap', ['-aFo', '-e', 'a', '-e', 'aa', 'overlap']],
    ['ERE-longest', ['-aEo', 'a|aa', 'overlap']], ['ERE-longest-reverse', ['-aEo', 'aa|a', 'overlap']],
    ['newline-pattern', ['-aF', 'needle\nother', 'hit', 'miss']],
    ['whole-line', ['-aFx', 'needle', 'hit', 'unterminated']], ['word-boundary', ['-aFw', 'needle', 'overlap']],
    ['invert-word', ['-aFvw', 'needle', 'overlap']], ['invert-only-matching', ['-aFvo', 'needle', 'hit']],
    ['count-invert', ['-aFcv', 'needle', 'hit', 'miss']], ['count-empty', ['-aFc', '', 'empty', 'hit']],
    ['files-without-match-status-hit', ['-FL', 'needle', 'hit']], ['files-without-match-status-miss', ['-FL', 'needle', 'miss']],
    ['files-without-match-both', ['-FL', 'needle', 'hit', 'miss']], ['filename-nul', ['-FlZ', 'needle', 'hit', 'miss']],
    ['filename-header-nul', ['-aFnHZ', 'needle', 'hit']], ['filename-suppression', ['-aFnh', 'needle', 'hit', 'hit']],
    ['forced-filename', ['-aFH', 'needle', 'unterminated']], ['duplicate-operands', ['-aFn', 'needle', 'hit', 'hit', 'miss']],
    ['missing-final-newline', ['-aFn', 'needle', 'unterminated']], ['empty-input', ['-aFc', 'needle', 'empty']],
    ['CRLF-records', ['-aFn', 'needle', 'CRLF']], ['invalid-UTF8-records', ['-aFnH', 'needle', 'raw-records']],
    ['nul-final-record', ['-azFn', 'needle', 'nul-records']], ['nul-only-matching', ['-azFo', 'needle', 'nul-records']],
    ['nul-invert-count', ['-azFvc', 'needle', 'nul-records']], ['text-binary-bytes', ['-aFn', 'needle', 'binary']],
    ['missing-first', ['-F', 'needle', 'missing', 'hit']], ['missing-last', ['-F', 'needle', 'hit', 'missing']],
    ['quiet-missing-first', ['-qF', 'needle', 'missing', 'hit']], ['quiet-missing-last', ['-qF', 'needle', 'hit', 'missing']],
    ['quiet-miss-error', ['-qF', 'needle', 'miss', 'missing']], ['directory-error', ['-F', 'needle', 'tree']],
    ['stdin-explicit', ['-aFnH', 'needle', '-']], ['stdin-and-file', ['-aFn', 'needle', '-', 'hit']],
    ['repeated-stdin', ['-aFn', 'needle', '-', '-']], ['pattern-file-stdin', ['-aF', '-f', '-', 'hit']],
    ['invalid-ERE', ['-E', '[', 'hit']], ['unsupported-BRE-backref', ['-a', String.raw`\(a\)\1`, 'overlap']],
    ['unsupported-context', ['-aF', '-B', '1', '-A', '1', 'needle', 'hit']],
    ['unicode-case-folding', ['-aiF', 'k', 'unicode'], 'C.UTF-8'],
    ['unicode-word-boundary', ['-aFw', 'I', 'unicode'], 'C.UTF-8'],
  ];
  const failures = [];
  for (const [id, argv, locale] of cases) {
    const input = id === 'pattern-file-stdin' ? Buffer.from('needle\n') : Buffer.from('needle\nother\n');
    try { f.compare(id, argv, { input, locale }); } catch (error) { failures.push(error.message); }
  }
  assert.equal(failures.length, 0, failures.slice(0, 8).join('\n'));
});

function generator(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

test('seeded byte-record literal and safe-ERE campaign matches GNU', { timeout: 60000 }, (t) => {
  const f = fixture(t), random = generator(SEED);
  const literals = ['', 'a', 'aa', 'alpha', 'beta', 'word', '_', '.', 'a+b', 'needle', 'absent'];
  const expressions = ['', 'a', 'aa', '^a', 'a$', 'a+', 'a?', 'a{1,3}', '(a|b)+', '[ab]', '[^a]', '[a-z]', '[[:digit:]]', 'alpha|beta', '^.*$', 'a.*b'];
  const flags = [[], ['-n'], ['-c'], ['-v'], ['-l'], ['-L'], ['-H'], ['-h'], ['-w'], ['-x'], ['-o'], ['-v', '-c'], ['-n', '-o'], ['-w', '-o'], ['-x', '-v'], ['-Z', '-l']];
  const failures = [];
  for (let index = 0; index < CAMPAIGN_CASES; index++) {
    const fixed = Boolean(random() & 1), nul = random() % 5 === 0;
    const selected = flags[random() % flags.length];
    const count = 1 + random() % 3;
    const patterns = Array.from({ length: count }, () => { const values = fixed ? literals : expressions; return values[random() % values.length]; });
    const records = Array.from({ length: random() % 18 }, () => {
      const values = ['a', 'aa', 'ab', 'alpha', 'beta', 'word', 'sword', 'word_end', 'a+b', 'needle', '0123', '', 'x@y', 'foo\r'];
      return Array.from({ length: 1 + random() % 4 }, () => values[random() % values.length]).join(' ');
    });
    const delimiter = nul ? '\0' : '\n';
    const data = Buffer.from(records.join(delimiter) + (records.length && random() & 1 ? delimiter : ''));
    const name = `.campaign-${index}`; f.put(name, data);
    const argv = ['-a', fixed ? '-F' : '-E', ...(nul ? ['-z'] : []), ...selected,
      ...patterns.flatMap((pattern) => ['-e', pattern]), name];
    try { f.compare('seeded-campaign', argv); } catch (error) { failures.push(`seed=0x${SEED.toString(16)} index=${index}: ${error.message}`); }
  }
  assert.ok(f.metrics.rustSearches > 0, 'seeded campaign must execute actual Rust searches');
  assert.equal(failures.length, 0, failures.slice(0, 8).join('\n'));
});

test('recursive order preserves hidden, ignored, symlink, and raw filename bytes', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  const raw = Buffer.concat([Buffer.from(join(f.cwd, 'tree') + '/raw-'), Buffer.from([0xff, 0x09, 0x0a])]);
  writeFileSync(raw, 'needle\n');
  writeFileSync(join(f.cwd, 'tree', 'raw-�\t\n'), 'other\n');
  writeFileSync(join(f.cwd, 'tree', 'colon:name'), 'needle\n');
  writeFileSync(join(f.cwd, 'tree', '-leading space'), 'needle\n');
  for (const argv of [
    ['-arnF', 'needle', 'tree'], ['-arlFZ', 'needle', 'tree'], ['-arcF', 'needle', 'tree'],
    ['-arnRF', 'needle', 'tree'], ['-arlRFZ', 'needle', 'tree'],
    ['-arnF', 'needle', 'tree', 'tree/a.txt', 'tree'], ['-anF', 'needle', 'tree/linked-file'],
  ]) f.compare('raw-traversal', argv);
});

test('pipe input, quiet errors, and original GNU diagnostics remain intact', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  const input = Buffer.from('head\nneedle needle\ntail\n');
  for (const argv of [
    ['-aFn', 'needle'], ['-aFc', 'needle'], ['-aFo', 'needle'], ['-aqF', 'needle'],
    ['-aFn', 'needle', '-', 'hit'], ['-qF', 'needle', 'missing', '-'],
  ]) f.compare('pipe-input', argv, { input, pipe: true });
  for (const argv of [ ['--unknown-grep-option'], ['-e'], ['-f', 'missing-pattern-file', 'hit'], ['-E', '(', 'hit'] ])
    f.compare('GNU-diagnostic-fallback', argv);
  f.compare('seekable-stdin-cursor', ['-aFm', '1', 'needle'], { input, transport: 'cursor' });
  f.put('dense-output', 'needle\n'.repeat(100000));
  f.compare('closed-stdout', ['-aF', 'needle', 'dense-output'], { transport: 'closed-output' });
});

test('parallel Rust searches preserve GNU operand order and aggregate statuses', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, 'parallel'));
  const base = Buffer.from(('padding abcdefghijklmnopqrstuvwxyz 0123456789\n').repeat(3072));
  const paths = [];
  for (let index = 0; index < 80; index++) {
    const name = `parallel/${index % 4 === 0 ? '.' : ''}file-${String(index).padStart(3, '0')}.txt`;
    const data = Buffer.from(base);
    if (index % 3 === 0) data.write('needle', 0);
    f.put(name, data); paths.push(name);
  }
  const reversed = [...paths].reverse();
  const cases = [
    ['-acF', 'needle', ...reversed, paths[0]], ['-arcF', 'needle', 'parallel'],
    ['-arcvF', 'needle', 'parallel'], ['-arnF', 'needle', 'parallel'],
    ['-arlFZ', 'needle', 'parallel'], ['-arlF', 'absent', 'parallel'],
    ['-arcE', '(needle|absent).*', 'parallel'],
  ];
  for (const argv of cases) {
    const route = f.compare('parallel-release-search', argv, { native: true });
    assert.ok(['parallel-mmap', 'parallel-buffered'].includes(route.strategy), 'qualification must enter a known parallel release path');
    assert.ok(route.workers > 1, 'qualification must execute multiple Rust search workers');
  }
});

// Independent fixtures deliberately vary both work duration and rendered bytes:
// several empty/tiny files, many large misses, and a >256 KiB selected record.
// This catches both discovery/loading boundaries and ordered output that spills
// to disk; a filename/count-only fixture cannot establish those contracts.
function parallelBoundaryFiles(f) {
  mkdirSync(join(f.cwd, 'boundary-tree'));
  const paths = [];
  const padding = 'other abcdefghijklmnopqrstuvwxyz 0123456789\n'.repeat(4096);
  const smallSizes = [0, 1, 4095, 4096, 4097];
  for (let index = 0; index < 129; index++) {
    const path = `boundary-tree/${index % 7 === 0 ? '.' : ''}case-${String(index).padStart(3, '0')}.txt`;
    let data;
    if (index === 0) data = Buffer.from(`needle ${'x'.repeat(310000)}\nother\nneedle unterminated`);
    else if (index < smallSizes.length + 1) data = Buffer.alloc(smallSizes[index - 1], 0x78);
    else if (index % 17 === 0) data = Buffer.from(`needle first-${index}\n${padding}needle last-${index}`);
    else data = Buffer.from(padding);
    f.put(path, data); paths.push(path);
  }
  return paths;
}

test('uneven parallel file outputs preserve every GNU byte across discovery and output-spill boundaries', { timeout: 30000 }, (t) => {
  const f = fixture(t), paths = parallelBoundaryFiles(f);
  const reversed = [...paths].reverse();
  const cases = [
    ['-anF', 'needle', ...reversed, paths[0]],
    ['-anFZ', 'needle', ...paths, paths[0]],
    ['-anFh', 'needle', ...reversed],
    ['-anE', '(needle|absent).*', ...reversed],
    ['-acF', 'needle', ...reversed, paths[0]],
    ['-acvF', 'needle', ...reversed],
    ['-arnF', 'needle', 'boundary-tree', paths[0], 'boundary-tree'],
    ['-arlFZ', 'needle', 'boundary-tree'],
  ];
  for (const argv of cases) {
    const route = f.compare('parallel-variable-output-spill', argv, { native: true });
    assert.ok(route.workers > 1, 'large uneven fixtures must exercise multiple Rust workers');
  }
});

test('late discovery or read failure never duplicates native output or changes GNU quiet error ordering', { timeout: 30000 }, (t) => {
  const f = fixture(t), paths = parallelBoundaryFiles(f);
  symlinkSync('does-not-exist', join(f.cwd, 'dangling-input'));
  f.put('blocked-input', 'needle\n');
  chmodSync(join(f.cwd, 'blocked-input'), 0);
  const misses = paths.filter((_, index) => index !== 0 && index % 17 !== 0);
  const cases = [
    ['-anF', 'needle', ...paths, 'missing-after-many-files'],
    ['-anF', 'needle', ...paths.slice(0, 65), 'missing-middle', ...paths.slice(65)],
    ['-acF', 'needle', ...paths, 'dangling-input'],
    ['-anF', 'needle', ...paths, 'blocked-input'],
    ['-anFs', 'needle', ...paths, 'missing-after-many-files'],
    ['-aqF', 'needle', ...paths, 'missing-after-match'],
    ['-aqF', 'needle', 'missing-before-match', ...paths],
    ['-aqF', 'needle', ...misses, 'missing-after-no-match'],
    ['-anF', 'needle', ...paths, 'boundary-tree'],
  ];
  try {
    for (const argv of cases) f.compare('late-input-failure-and-quiet-order', argv);
  } finally {
    chmodSync(join(f.cwd, 'blocked-input'), 0o600);
  }
});

test('native parallel loading stays correct with more input files than available descriptors', { timeout: 30000 }, (t) => {
  const f = fixture(t), paths = parallelBoundaryFiles(f);
  for (const argv of [
    ['-acF', 'needle', ...paths],
    ['-anF', 'needle', ...paths.reverse()],
    ['-arlFZ', 'needle', 'boundary-tree'],
  ]) {
    const route = f.compare('bounded-input-descriptors', argv, { native: true, transport: 'limited-descriptors' });
    assert.ok(route.workers > 1, 'descriptor-limit qualification must retain native parallel searching');
  }
});

test('dense first-record filename shortcuts preserve complete-record word and anchor semantics', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  const padding = 'other '.repeat(16 * 1024);
  const trees = [['dense-LF', '\n'], ['dense-NUL', '\0']];
  const pathsByTree = new Map();
  for (const [tree, delimiter] of trees) {
    mkdirSync(join(f.cwd, tree));
    const paths = [];
    for (let index = 0; index < 96; index++) {
      const path = `${tree}/case-${String(index).padStart(3, '0')}`;
      let prefix;
      if (index < 8) prefix = `needle${delimiter}`;
      else switch (index % 8) {
        case 0: prefix = `needle${delimiter}`; break;
        case 1: prefix = `needlex${delimiter}`; break;
        case 2: prefix = `absent${delimiter}`; break;
        // The 4096-byte probe ends after "needle", but the record continues
        // with a word character. A truncated probe would invent a word/end
        // boundary which does not exist in the actual input.
        case 3: prefix = `${' '.repeat(4090)}needlex${delimiter}`; break;
        case 4: prefix = `needle${' '.repeat(6000)}suffix${delimiter}`; break;
        case 5: prefix = `absent${delimiter}needle${delimiter}`; break;
        case 6: prefix = `${delimiter}needle${delimiter}`; break;
        case 7: prefix = `needlex${'x'.repeat(6000)}`; break;
      }
      f.put(path, `${prefix}${padding}${index % 8 === 7 ? '' : delimiter}`);
      paths.push(path);
    }
    pathsByTree.set(tree, paths);
  }
  const LF = pathsByTree.get('dense-LF'), NUL = pathsByTree.get('dense-NUL');
  const cases = [
    ['-alF', 'needle', ...LF], ['-aLF', 'needle', ...LF],
    ['-alwF', 'needle', ...LF], ['-alxF', 'needle', ...LF],
    ['-alE', '^needle$', ...LF], ['-aLE', '^needle$', ...LF],
    ['-alE', 'needle$', ...LF],
    ['-azlF', 'needle', ...NUL], ['-azlFx', 'needle', ...NUL],
  ];
  for (const argv of cases) {
    const route = f.compare('parallel-dense-first-record-boundaries', argv, { native: true });
    assert.ok(['parallel-mmap', 'parallel-buffered'].includes(route.strategy), 'dense filename fixture must use a known parallel path');
    assert.ok(route.workers > 1, 'dense filename fixture must exercise multiple native Rust workers');
  }
});

test('whole-buffer ERE optimization preserves GNU record boundaries', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  const crlf = Buffer.from('a\r\na\n\r\n\nlast');
  const scenarios = [
    ['dot-does-not-cross-LF', 'a.*b', Buffer.from('a\nb\n')],
    ['negated-class-does-not-cross-LF', 'a[^x]+b', Buffer.from('a\nb\n')],
    ['CRLF-start-end-anchors', '^a$', crlf],
    ['CRLF-empty-line-anchor', '^$', crlf],
    ['unterminated-final-anchor', 'last$', crlf],
    ['empty-alternative-selects-existing-records', 'aba|', Buffer.from('ababa\nnone\n\ntail')],
    ['multiple-matches-count-one-record', 'aa', Buffer.from('aa aa\nnone\naa')],
    ['terminal-LF-has-no-phantom-record', '^$', Buffer.from('a\n')],
    ['empty-file-has-no-records', '|', Buffer.alloc(0)],
    ['NUL-record-dot-may-cross-LF', 'a.b', Buffer.from('a\nb\0a\0b\0'), true],
    ['negated-class-does-not-cross-NUL', 'a[^x]+b', Buffer.from('a\0b\0'), true],
    ['NUL-record-anchors-ignore-payload-LF', '^a$', Buffer.from('x\na\ny\0a\0a\n\0'), true],
    ['unterminated-NUL-record-anchor', 'last$', Buffer.from('a\0last'), true],
    ['terminal-NUL-has-no-phantom-record', '^$', Buffer.from('a\0'), true],
    ['native-alternation-counts-selected-records', 'needle|absent', Buffer.from('needle needle absent\nmiss\nneedle')],
    ['native-pattern-must-not-bridge-LF', '(padding|needle).*012', Buffer.from('padding aaa012\nneedle\n012\nneedle bbb012')],
  ];
  const flags = [[], ['-n'], ['-c'], ['-v', '-c'], ['-v', '-n'], ['-l'], ['-L'], ['-q']];
  const failures = [];
  for (const [index, [id, pattern, bytes, nul]] of scenarios.entries()) {
    const path = `.ERE-boundary-${index}`; f.put(path, bytes);
    for (const optionFlags of flags) {
      const argv = ['-aE', ...(nul ? ['-z'] : []), ...optionFlags, '-e', pattern, path];
      const native = pattern === 'needle|absent' || pattern === '(padding|needle).*012';
      try { f.compare(id, argv, { native }); } catch (error) { failures.push(error.message); }
    }
  }
  assert.equal(failures.length, 0, failures.slice(0, 8).join('\n'));
});

test('seeded ERE record-boundary campaign matches GNU byte output and counts', { timeout: 60000 }, (t) => {
  const f = fixture(t, ERE_BOUNDARY_SEED), random = generator(ERE_BOUNDARY_SEED);
  const patterns = ['', '|', '^$', '^a$', 'a$', '^a', 'a.*b', 'a[^x]b', 'a[^x]+b', '[^x]*',
    'a[[:space:]]b', '(a|b)+', '(a|)', 'a|aa', '(needle|)', 'needle|absent', '(padding|needle).*012'];
  const flags = [[], ['-n'], ['-c'], ['-v'], ['-v', '-c'], ['-v', '-n'], ['-l'], ['-L'], ['-q'],
    ['-n', '-H'], ['-c', '-H'], ['-l', '-Z']];
  const payloads = ['', 'a', 'b', 'aa', 'ab', 'axb', 'ayb', 'needle needle', 'absent', 'padding abc012',
    'needle012', '012', '\r', 'a\nb', 'needle\n012', 'x\na\ny'];
  const failures = [];
  for (let index = 0; index < ERE_BOUNDARY_CASES; index++) {
    const nul = random() % 3 === 0;
    const delimiter = nul ? '\0' : '\n';
    const records = Array.from({ length: random() % 20 }, () => payloads[random() % payloads.length]);
    let bytes = Buffer.from(records.join(delimiter) + (records.length && random() % 2 ? delimiter : ''));
    if (random() % 7 === 0) bytes = Buffer.concat([Buffer.from([0xff]), bytes]);
    const files = [`.ERE-seeded-${index}-a`, `.ERE-seeded-${index}-b`];
    f.put(files[0], bytes);
    f.put(files[1], Buffer.from(bytes).reverse());
    const selectedFlags = flags[random() % flags.length];
    const selectedPatterns = Array.from({ length: 1 + random() % 3 }, () => patterns[random() % patterns.length]);
    const argv = ['-aE', ...(nul ? ['-z'] : []), ...selectedFlags,
      ...selectedPatterns.flatMap((pattern) => ['-e', pattern]), ...files];
    try { f.compare('seeded-ERE-boundaries', argv); }
    catch (error) { failures.push(`seed=0x${ERE_BOUNDARY_SEED.toString(16)} index=${index}: ${error.message}`); }
  }
  assert.ok(f.metrics.rustSearches > 0, 'ERE campaign must include actual Rust searches');
  assert.equal(failures.length, 0, failures.slice(0, 8).join('\n'));
});
