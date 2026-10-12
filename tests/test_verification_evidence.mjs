import assert from 'node:assert/strict';
import test from 'node:test';
import { cargoTestExecutable, parseRustOracle, parseRustUnits, parseTap } from '../tools/rust-verification.mjs';

const hash = 'a'.repeat(64);
const contract = { nativeRequiredClasses: ['literal'], fallbackAllowedClasses: ['unsupported'] };
const tap = '# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const rows = [
  { comparisons: 1, rustSearches: 1, gnuFallbacks: 0, ioComparisons: 0, failures: 0, artifactSHA256: hash, classes: { literal: 1 } },
  { comparisons: 1, rustSearches: 0, gnuFallbacks: 1, ioComparisons: 0, failures: 0, artifactSHA256: hash, classes: { unsupported: 1 } },
];
function report({ campaigns = rows, aggregate = {}, footer = tap } = {}) {
  const all = { comparisons: 2, rustSearches: 1, gnuFallbacks: 1, ioComparisons: 0,
    failures: 0, artifactSHA256: hash, classes: { literal: 1, unsupported: 1 }, ...aggregate };
  return Buffer.from(campaigns.map(row => `# ${JSON.stringify(row)}`).join('\n') + '\n' + footer +
    `TEST_ENGINE_REPORT=${JSON.stringify(all)}\n`);
}

test('Rust oracle evidence preserves separate native and delegated comparisons', () => {
  const result = parseRustOracle(report(), hash, contract, 'TEST');
  assert.equal(result.fullGNUComparisons, 2);
  assert.equal(result.rustSearches, 1);
  assert.equal(result.gnuFallbacks, 1);
});

test('a green exit or TAP summary cannot replace nonempty complete test evidence', () => {
  for (const changed of ['tests 0', 'pass 1', 'skipped 1', 'fail 1', 'cancelled 1', 'todo 1']) {
    const key = changed.split(' ')[0];
    assert.throws(() => parseTap(Buffer.from(tap.replace(new RegExp(`# ${key} \\d+`), `# ${changed}`))));
  }
  assert.throws(() => parseTap(Buffer.from('test result: ok.')));
});

test('wrong artifacts, routes, omitted classes and inconsistent aggregates fail qualification', () => {
  assert.throws(() => parseRustOracle(report(), 'b'.repeat(64), contract, 'TEST'));
  for (const aggregate of [{ comparisons: 3 }, { rustSearches: 2 }, { failures: 1 }, { classes: { literal: 2 } }])
    assert.throws(() => parseRustOracle(report({ aggregate }), hash, contract, 'TEST'));
  assert.throws(() => parseRustOracle(report(), hash, { ...contract, nativeRequiredClasses: ['missing'] }, 'TEST'));
  assert.throws(() => parseRustOracle(report({ campaigns: [] }), hash, contract, 'TEST'));
  const changed = rows.map(row => ({ ...row, gnuFallbacks: 0 }));
  assert.throws(() => parseRustOracle(report({ campaigns: changed }), hash, contract, 'TEST'));
  for (const invalid of [{ rustSearches: 2, gnuFallbacks: -1 }, { rustSearches: 0.5, gnuFallbacks: 0.5 },
    { rustSearches: 2, gnuFallbacks: 0 }, { rustSearches: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => parseRustOracle(report({ campaigns: [{ ...rows[0], ...invalid }, rows[1]] }), hash, contract, 'TEST'));
  }
  assert.throws(() => parseRustOracle(report({ campaigns: [
    { ...rows[0], rustSearches: 0 }, { ...rows[1], rustSearches: 1 },
  ] }), hash, contract, 'TEST'), 'opposing errors cannot hide in a correct aggregate');
});

test('engine campaign failure and a missing or duplicate aggregate fail qualification', () => {
  assert.throws(() => parseRustOracle(report({ campaigns: [{ ...rows[0], failures: 1 }, rows[1]] }), hash, contract, 'TEST'));
  const good = report();
  assert.throws(() => parseRustOracle(Buffer.from(good.toString().replace(/^TEST_ENGINE_REPORT=.*$/m, '')), hash, contract, 'TEST'));
  assert.throws(() => parseRustOracle(Buffer.concat([good, good]), hash, contract, 'TEST'));
});

test('Rust unit results reject empty, ignored, filtered and multiply reported suites', () => {
  const success = 'test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n';
  assert.equal(parseRustUnits(Buffer.from(success)).passed, 8);
  for (const invalid of [success.replace('8 passed', '0 passed'), success.replace('0 ignored', '1 ignored'),
    success.replace('0 filtered out', '1 filtered out'), success + success, ''])
    assert.throws(() => parseRustUnits(Buffer.from(invalid)));
});

test('Cargo metadata identifies an owned test executable without accepting production or escaped artifacts', () => {
  const artifact = { reason: 'compiler-artifact', executable: '/tmp/owned/debug/deps/test',
    target: { name: 'engine-rust', kind: ['bin'] }, profile: { test: true } };
  const bytes = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n'));
  assert.equal(cargoTestExecutable(bytes([artifact]), 'engine-rust', 'bin', '/tmp/owned'), artifact.executable);
  for (const changes of [{ executable: '/tmp/other/test' }, { profile: { test: false } }, { target: { name: 'wrong', kind: ['bin'] } }])
    assert.throws(() => cargoTestExecutable(bytes([{ ...artifact, ...changes }]), 'engine-rust', 'bin', '/tmp/owned'));
  assert.throws(() => cargoTestExecutable(bytes([artifact, artifact]), 'engine-rust', 'bin', '/tmp/owned'));
  const custom = { ...artifact, profile: { test: false }, target: { name: 'gnu_oracle', kind: ['test'], test: true } };
  assert.equal(cargoTestExecutable(bytes([custom]), 'gnu_oracle', 'test', '/tmp/owned'), custom.executable);
  assert.throws(() => cargoTestExecutable(bytes([{ ...custom, target: { ...custom.target, test: false } }]), 'gnu_oracle', 'test', '/tmp/owned'));

});
