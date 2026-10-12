// Cargo builds test artifacts; assertions about engine behavior live in Rust.
import assert from 'node:assert/strict';
import { join, relative, isAbsolute } from 'node:path';

export function parseTap(stdout) {
  const text = stdout.toString('utf8');
  const counts = Object.fromEntries(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => {
    const match = text.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
    return [name, match ? Number(match[1]) : null];
  }));
  assert.ok(counts.tests > 0, 'The test runner executed no tests');
  assert.equal(counts.pass, counts.tests, 'Every test must pass');
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(counts[name], 0, `Unexpected ${name} tests`);
  const diagnostics = [...text.matchAll(/^\s*#\s*(\{.*\})\s*$/gm)].map(match => JSON.parse(match[1]))
    .filter(value => Number.isSafeInteger(value.comparisons));
  return { counts, diagnostics };
}

export function parseRustUnits(stdout) {
  const text = stdout.toString('utf8');
  const results = [...text.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  assert.equal(results.length, 1, 'Expected exactly one Rust unit-test result');
  const [passed, failed, ignored, measured, filtered] = results[0].slice(1).map(Number);
  assert.ok(passed > 0, 'No Rust unit tests executed');
  assert.equal(failed + ignored + measured + filtered, 0, 'Rust units must pass without ignored or filtered tests');
  return { reporter: 'Rust libtest', passed, failed, ignored, measured, filtered };
}

export function parseRustOracle(stdout, binaryHash, contract, prefix) {
  const { counts, diagnostics } = parseTap(stdout);
  const reports = [...stdout.toString('utf8').matchAll(new RegExp(`^${prefix}_ENGINE_REPORT=(.*)$`, 'gm'))]
    .map(match => JSON.parse(match[1]));
  assert.equal(reports.length, 1, 'Expected one aggregate Rust GNU-oracle report');
  const aggregate = reports[0];
  const total = key => diagnostics.reduce((sum, row) => sum + (row[key] ?? 0), 0);
  const classes = {};
  assert.ok(diagnostics.length > 0, 'No Rust comparison campaigns were reported');
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.artifactSHA256, binaryHash, 'Campaign tested a different production release');
    assert.equal(diagnostic.failures, 0, 'GNU comparison failures');
    assert.ok(diagnostic.comparisons > 0, 'Empty GNU comparison campaign');
    for (const key of ['comparisons', 'rustSearches', 'gnuFallbacks', 'ioComparisons']) {
      const value = diagnostic[key] ?? (key === 'ioComparisons' ? 0 : NaN);
      assert.ok(Number.isSafeInteger(value) && value >= 0, `Invalid campaign ${key}`);
    }
    assert.equal(diagnostic.rustSearches + diagnostic.gnuFallbacks + (diagnostic.ioComparisons ?? 0),
      diagnostic.comparisons, 'Each campaign must account for its routes independently');
    assert.equal(Object.values(diagnostic.classes).reduce((sum, value) => sum + value, 0), diagnostic.comparisons, 'Class counters must cover each comparison');
    for (const [name, value] of Object.entries(diagnostic.classes)) {
      assert.ok(Number.isSafeInteger(value) && value > 0, 'Invalid comparison class count');
      classes[name] = (classes[name] ?? 0) + value;
    }
  }
  const fullGNUComparisons = total('comparisons'), rustSearches = total('rustSearches'),
    gnuFallbacks = total('gnuFallbacks'), ioComparisons = total('ioComparisons');
  assert.ok(rustSearches > 0, 'No native Rust engine searches executed');
  assert.equal(rustSearches + gnuFallbacks + ioComparisons, fullGNUComparisons, 'Route counts must cover every comparison');
  assert.equal(aggregate.artifactSHA256, binaryHash, 'Aggregate tested a different release');
  assert.equal(aggregate.failures, 0);
  for (const key of ['comparisons', 'rustSearches', 'gnuFallbacks', 'ioComparisons']) {
    const value = aggregate[key] ?? (key === 'ioComparisons' ? 0 : NaN);
    assert.ok(Number.isSafeInteger(value) && value >= 0, `Invalid aggregate ${key}`);
  }
  for (const [key, value] of Object.entries({ comparisons: fullGNUComparisons, rustSearches, gnuFallbacks, ioComparisons }))
    assert.equal(aggregate[key] ?? 0, value, `Aggregate ${key} disagrees with campaign accounting`);
  assert.deepEqual(aggregate.classes, classes, 'Aggregate class accounting differs from campaign reports');
  const requiredClasses = [...contract.nativeRequiredClasses, ...contract.fallbackAllowedClasses];
  for (const name of requiredClasses) assert.ok(classes[name] > 0, `Missing historical engine class ${name}`);
  return { reporter: 'Rust custom harness / TAP', counts, diagnostics, fullGNUComparisons,
    rustSearches, gnuFallbacks, ioComparisons, classes, requiredClasses, aggregate,
    fullComparisonContract: ['all stdout bytes', 'all stderr bytes', 'exit status'],
    nativeRouteAssertionsSeparateFromFallback: true };
}

export function cargoTestExecutable(stdout, targetName, kind, targetDirectory) {
  const records = stdout.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const matches = records.filter(record => record.reason === 'compiler-artifact' && record.executable &&
    record.target?.name === targetName && record.target.kind.includes(kind) &&
    (kind === 'test' ? record.target.test !== false : record.profile?.test));
  assert.equal(matches.length, 1, `Cargo must identify exactly one ${targetName} test executable`);
  const executable = matches[0].executable;
  const location = relative(targetDirectory, executable);
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location), 'Test executable escaped the owned build target');
  return executable;
}

export async function runRustQualification({ command, packageRoot, targetDirectory, binary, binaryHash, contract, prefix, temporary }) {
  const manifest = join(packageRoot, 'rust', 'Cargo.toml');
  const common = ['test', '--locked', '--offline', '--manifest-path', manifest, '--target-dir', targetDirectory,
    '--no-run', '--message-format=json'];
  const environment = { [`${prefix}_RUST_BINARY`]: binary, TMPDIR: temporary, CARGO_NET_OFFLINE: 'true' };
  const unitTests = {};
  for (const profile of ['debug', 'release']) {
    const compiled = await command(`Compile extracted ${profile} Rust unit tests`, 'cargo',
      [...common, ...(profile === 'release' ? ['--release'] : []), '--bin', `${prefix.toLowerCase()}-rust`],
      { environment, timeoutMs: 600000 });
    const executable = cargoTestExecutable(compiled.stdout, `${prefix.toLowerCase()}-rust`, 'bin', targetDirectory);
    const result = await command(`Run ${profile} Rust unit/property tests outside the checkout`, executable,
      ['--nocapture', '--test-threads=1'], { environment, timeoutMs: 60000 });
    unitTests[profile] = { ...parseRustUnits(result.stdout), executedFromExtractedSource: true };
  }
  const compiled = await command('Compile the extracted Rust release GNU-oracle harness', 'cargo',
    [...common, '--release', '--features', 'release-oracle', '--test', 'gnu_oracle'],
    { environment, timeoutMs: 600000 });
  const executable = cargoTestExecutable(compiled.stdout, 'gnu_oracle', 'test', targetDirectory);
  const result = await command('Run the Rust release GNU-oracle campaigns outside the checkout', executable,
    ['--nocapture'], { environment, timeoutMs: 300000, requireSuccess: false });
  const tests = parseRustOracle(result.stdout, binaryHash, contract, prefix);
  assert.equal(result.status, 0, 'Rust GNU-oracle harness returned a nonzero exit status');
  return { unitTests, tests };
}
