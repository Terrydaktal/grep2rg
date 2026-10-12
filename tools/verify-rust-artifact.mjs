#!/usr/bin/env node
// Qualify the Rust source that npm actually ships, with an independent build
// target and packaged tests whose working directory is outside this checkout.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, accessSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const source = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
let output = join(source, 'artifacts', 'rust-artifact.json');
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '--output' || !args[index + 1]) throw Error('Expected --output FILE');
  output = resolve(args[++index]);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => sha(readFileSync(path));
const artifacts = join(source, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const owned = mkdtempSync(join(artifacts, 'rust-package-'));
const outside = mkdtempSync(join(tmpdir(), 'grep2rg-rust-package-cwd-'));
assert.ok(relative(source, realpathSync(outside)).startsWith('..'), 'Verification cwd must be outside the checkout');
const extraction = join(outside, 'extracted');
let target = join(owned, 'cargo-target');
const npmCache = join(owned, 'npm-cache');
const testTemporary = join(outside, 'test-temporary');
mkdirSync(extraction); mkdirSync(testTemporary);
writeFileSync(join(owned, 'npmrc'), '');
const baseEnvironment = { ...process.env, LC_ALL: 'C', LANG: 'C',
  npm_config_cache: npmCache, npm_config_userconfig: join(owned, 'npmrc'),
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
};
for (const key of Object.keys(baseEnvironment)) {
  if (key.startsWith('GREP2RG_') || ['POSIXLY_CORRECT', 'GREP_OPTIONS', 'GREP_COLORS', 'GREP_COLOR'].includes(key)) delete baseEnvironment[key];
}

const report = {
  schemaVersion: 1, createdAt: new Date().toISOString(), status: 'running',
  scope: 'Actual npm source archive, independently rebuilt Rust release, packaged full-byte GNU-oracle tests and CLI comparisons from outside the source checkout.',
  source, output, archiveDirectory: owned, workingDirectory: outside,
  isolation: { extractedSource: extraction, cargoTarget: target, npmCache,
    lifecycleScripts: 'disabled during npm pack', cargoBuild: 'release, locked, offline',
    testsWorkingDirectoryOutsideSource: true, originalRustTargetUsedForBuild: false },
  stages: [], failures: [],
};
let succeeded = false;
let activeChild;
let interrupted;
function interrupt(signal) {
  interrupted = signal;
  activeChild?.kill(signal);
}
const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);

function command(name, program, argv, { cwd = outside, environment = {}, input,
  argv0, timeoutMs = 60000, requireSuccess = true } = {}) {
  if (interrupted) throw Error(`Verification interrupted by ${interrupted}`);
  process.stdout.write(`${name}\n`);
  const entry = { name, program, argv, cwd, timeoutMs,
    environment: { LC_ALL: baseEnvironment.LC_ALL, LANG: baseEnvironment.LANG,
      npm_config_cache: npmCache, ...environment } };
  report.stages.push(entry);
  return new Promise((done, reject) => {
    const stdoutChunks = [], stderrChunks = [];
    let stdoutBytes = 0, stderrBytes = 0, failure, timedOut = false;
    const started = performance.now();
    const child = spawn(program, argv, { cwd, argv0,
      env: { ...baseEnvironment, ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChild = child;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const collect = (chunks, channel) => bytes => {
      chunks.push(bytes);
      if (channel === 'stdout') stdoutBytes += bytes.length; else stderrBytes += bytes.length;
      if (stdoutBytes > 32 * 1024 * 1024 || stderrBytes > 32 * 1024 * 1024) {
        failure = Error('Child output exceeded the bounded 32 MiB capture per channel'); child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', collect(stdoutChunks, 'stdout'));
    child.stderr.on('data', collect(stderrChunks, 'stderr'));
    child.once('error', error => { failure = error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error; });
    child.stdin.end(input);
    child.once('close', (status, signal) => {
      clearTimeout(timeout); activeChild = undefined;
      const stdout = Buffer.concat(stdoutChunks), stderr = Buffer.concat(stderrChunks);
      Object.assign(entry, { status, signal, timedOut, durationMs: performance.now() - started,
        error: failure ? { code: failure.code ?? null, message: failure.message } : null,
        stdoutBytes: stdout.length, stderrBytes: stderr.length,
        stdoutSHA256: sha(stdout), stderrSHA256: sha(stderr),
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
      const result = { status, signal, stdout, stderr, error: failure };
      if (failure || timedOut || signal || requireSuccess && status !== 0) {
        reject(Error(`${name} failed (${failure?.message ?? (timedOut ? 'timeout' : signal ?? status)}): ${stderr.toString('utf8').slice(-4096)}`));
      } else done(result);
    });
  });
}

function rustFiles(directory, prefix = 'rust') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['target', '.git', '.gitignore', '.npmignore'].includes(entry.name)) continue;
    const path = join(directory, entry.name), name = `${prefix}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), `Rust package source must be a regular file or directory: ${name}`);
    if (entry.isDirectory()) files.push(...rustFiles(path, name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

function sourceHashes(files, directory) {
  return Object.fromEntries(files.map(name => [name, fileHash(join(directory, name))]));
}

function parseTestEvidence(stdout, binaryHash, contract) {
  const text = stdout.toString('utf8');
  const diagnostics = [];
  for (const match of text.matchAll(/^\s*#\s*(\{.*\})\s*$/gm)) {
    try {
      const diagnostic = JSON.parse(match[1]);
      if (Number.isSafeInteger(diagnostic.comparisons)) diagnostics.push(diagnostic);
    } catch {}
  }
  const count = name => {
    const match = text.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const counts = Object.fromEntries(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, count(name)]));
  const fullGNUComparisons = diagnostics.reduce((sum, entry) => sum + entry.comparisons, 0);
  const rustSearches = diagnostics.reduce((sum, entry) => sum + entry.rustSearches, 0);
  const gnuFallbacks = diagnostics.reduce((sum, entry) => sum + entry.gnuFallbacks, 0);
  const classes = {};
  for (const diagnostic of diagnostics) {
    for (const [name, value] of Object.entries(diagnostic.classes || {})) classes[name] = (classes[name] || 0) + value;
  }
  const requiredClasses = [...contract.nativeRequiredClasses, ...contract.fallbackAllowedClasses];
  report.tests = { reporter: 'TAP', counts, diagnostics, fullGNUComparisons,
    rustSearches, gnuFallbacks, classes, requiredClasses,
    fullComparisonContract: ['all stdout bytes', 'all stderr bytes', 'exit status'],
    nativeRouteAssertionsSeparateFromFallback: true };
  assert.ok(counts.tests > 0, 'Packaged qualification executed no tests');
  assert.equal(counts.pass, counts.tests, 'Every packaged test must pass');
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(counts[name], 0, `Unexpected packaged ${name} tests`);
  assert.ok(diagnostics.length > 0 && fullGNUComparisons > 0, 'No full GNU comparison diagnostics were captured');
  assert.ok(rustSearches > 0, 'Packaged tests performed no native Rust searches');
  assert.equal(rustSearches + gnuFallbacks, fullGNUComparisons, 'Route counts must cover all full GNU comparisons');
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.artifactSHA256, binaryHash, 'Tests qualified a different release binary');
    assert.equal(diagnostic.failures, 0, 'Packaged GNU comparison failures');
    assert.equal(Object.values(diagnostic.classes).reduce((sum, value) => sum + value, 0), diagnostic.comparisons, 'Class counters must cover each GNU comparison');
  }
  for (const name of requiredClasses) assert.ok(classes[name] > 0, `Packaged tests missed historical class ${name}`);
}

function resultEvidence(result) {
  return { status: result.status, signal: result.signal,
    stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length,
    stdoutSHA256: sha(result.stdout), stderrSHA256: sha(result.stderr) };
}

try {
  const originalRustFiles = rustFiles(join(source, 'rust'));
  for (const required of ['rust/Cargo.lock', 'rust/Cargo.toml', 'rust/src/main.rs']) assert.ok(originalRustFiles.includes(required), `Missing required source ${required}`);
  const rustPublicationControls = ['rust/.npmignore', 'rust/.gitignore'].filter(name => existsSync(join(source, name)));
  const trackedFiles = [...originalRustFiles, ...rustPublicationControls, 'package.json', '.npmignore',
    'tests/test_rust_engine.mjs', 'tests/rust-engine-contract.json',
    'tests/test_benchmark_processes.mjs', 'tools/benchmark-processes.py',
    'tools/benchmark-rust-engine.mjs', 'tools/rust-benchmark-fixture.mjs',
    'tools/verify-rust-artifact.mjs', 'tools/build-rust.mjs', 'tests/test_rust_integration.mjs',
    'src/grep-wrapper.mjs', 'bin/grep2rg'];
  const originalHashes = sourceHashes(trackedFiles, source);
  const originalRelease = join(source, 'rust', 'target', 'release', 'grep2rg-rust');
  const originalReleaseHash = existsSync(originalRelease) ? fileHash(originalRelease) : null;
  const oracleHash = fileHash('/usr/bin/grep');
  report.sourceHashes = originalHashes;
  report.originalRelease = { path: originalRelease, SHA256: originalReleaseHash };

  const packed = await command('Pack the real npm distribution without lifecycle scripts', 'npm',
    ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', owned], { cwd: source });
  const manifest = JSON.parse(packed.stdout.toString('utf8'));
  const records = Array.isArray(manifest) ? manifest : Object.values(manifest);
  assert.equal(records.length, 1, 'npm pack must produce exactly one artifact');
  const record = records[0];
  assert.equal(record.filename, basename(record.filename), 'Unexpected npm archive filename');
  const archive = join(owned, record.filename);
  const packagedPaths = record.files.map(file => file.path).sort();
  assert.ok(packagedPaths.every(path => !isAbsolute(path) && !path.split('/').includes('..')), 'Unsafe package entry');
  assert.ok(!packagedPaths.some(path => /^rust\/target(?:\/|$)/.test(path)), 'Compiled Rust target content must not ship');
  assert.ok(!packagedPaths.some(path => /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/.test(path)), 'Python bytecode caches must not ship');
  const packagedRustFiles = packagedPaths.filter(path => path.startsWith('rust/'));
  assert.deepEqual(packagedRustFiles, originalRustFiles, 'The archive must contain all exact Rust source files and no build artifacts');
  for (const required of ['tests/test_rust_engine.mjs', 'tests/rust-engine-contract.json',
    'tests/test_benchmark_processes.mjs', 'tools/benchmark-processes.py',
    'tools/benchmark-rust-engine.mjs', 'tools/rust-benchmark-fixture.mjs',
    'tools/verify-rust-artifact.mjs', 'tools/build-rust.mjs', 'tests/test_rust_integration.mjs',
    'src/grep-wrapper.mjs', 'bin/grep2rg']) assert.ok(packagedPaths.includes(required), `Artifact omits ${required}`);
  report.packageArtifact = { filename: record.filename, SHA256: fileHash(archive),
    integrity: record.integrity, npmSHA1: record.shasum, fileCount: packagedPaths.length,
    sizeBytes: record.size, unpackedSizeBytes: record.unpackedSize,
    files: packagedPaths, rustFiles: packagedRustFiles, compiledTargetAbsent: true, pythonCacheAbsent: true };

  const listing = await command('Inspect the actual archive entries', 'tar', ['-tzf', archive]);
  const entries = listing.stdout.toString('utf8').split('\n').filter(Boolean);
  assert.ok(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..')), 'Unsafe archive path');
  assert.ok(!entries.some(path => /^package\/rust\/target(?:\/|$)/.test(path)), 'Archive includes compiled Rust target content');
  await command('Extract the source package outside the repository', 'tar', ['-xzf', archive, '-C', extraction]);
  const packageRoot = join(extraction, 'package');
  target = join(packageRoot, 'rust', 'target');
  report.isolation.cargoTarget = target;
  const extractedHashes = sourceHashes(originalRustFiles, packageRoot);
  assert.deepEqual(extractedHashes, sourceHashes(originalRustFiles, source), 'Packaged Rust source bytes differ from the working tree');
  for (const name of trackedFiles.filter(name => !/(?:^|\/)\.(?:npm|git)ignore$/.test(name))) assert.equal(fileHash(join(packageRoot, name)), originalHashes[name], `Packaged source changed: ${name}`);
  report.extractedRustSourceHashes = extractedHashes;

  const versions = {};
  for (const [name, program, argv] of [
    ['cargo', 'cargo', ['--version', '--verbose']],
    ['rustc', 'rustc', ['--version', '--verbose']],
    ['npm', 'npm', ['--version']],
    ['GNU', '/usr/bin/grep', ['--version']],
  ]) {
    const version = await command(`Record ${name} version`, program, argv);
    versions[name] = version.stdout.toString('utf8');
  }
  report.versions = { ...versions, node: process.version };
  await command('Build extracted Rust source through the installed build helper with locked offline dependencies', process.execPath,
    [join(packageRoot, 'tools', 'build-rust.mjs'), '--offline'],
    { environment: { CARGO_TARGET_DIR: target, CARGO_NET_OFFLINE: 'true' }, timeoutMs: 600000 });
  const binary = join(target, 'release', 'grep2rg-rust');
  accessSync(binary, constants.X_OK);
  const binaryHash = fileHash(binary);
  report.executable = { path: binary, SHA256: binaryHash,
    rebuiltFromExtractedSource: true, packagedPrebuiltBinaryUsed: false,
    GNUOraclePath: '/usr/bin/grep', GNUOracleSHA256: oracleHash };
  const contract = JSON.parse(readFileSync(join(packageRoot, 'tests', 'rust-engine-contract.json'), 'utf8'));
  const tests = await command('Run the packaged Rust GNU-oracle suite from an outside cwd', process.execPath,
    ['--test', '--test-reporter=tap', join(packageRoot, 'tests', 'test_rust_engine.mjs')],
    { environment: { GREP2RG_RUST_BINARY: binary, TMPDIR: testTemporary }, timeoutMs: 300000, requireSuccess: false });
  parseTestEvidence(tests.stdout, binaryHash, contract);
  assert.equal(tests.status, 0, 'Packaged Rust suite returned a nonzero exit status');

  const driverTests = await command('Run the packaged process-timer contract tests from an outside cwd', process.execPath,
    ['--test', '--test-reporter=tap', join(packageRoot, 'tests', 'test_benchmark_processes.mjs')],
    { environment: { TMPDIR: testTemporary }, timeoutMs: 30000, requireSuccess: false });
  const driverCounts = Object.fromEntries([...driverTests.stdout.toString('utf8')
    .matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)]
    .map(match => [match[1], Number(match[2])]));
  assert.equal(driverTests.status, 0, 'Packaged process-timer tests failed');
  assert.ok(driverCounts.tests >= 7 && driverCounts.pass === driverCounts.tests,
    'Packaged process-timer tests must execute a complete passing suite');
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(driverCounts[key], 0, `Unexpected process-timer ${key}`);
  report.benchmarkDriverTests = { counts: driverCounts, executedFromExtractedSource: true };

  const integration = await command('Run packaged default CLI and model Bash Rust integration checks', process.execPath,
    ['--test', '--test-reporter=tap', join(packageRoot, 'tests', 'test_rust_integration.mjs')],
    { environment: { TMPDIR: testTemporary }, timeoutMs: 30000, requireSuccess: false });
  const integrationCounts = Object.fromEntries([...integration.stdout.toString('utf8')
    .matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(match => [match[1], Number(match[2])]));
  assert.equal(integration.status, 0, 'Packaged default Rust integration tests failed');
  assert.equal(integrationCounts.tests, 5);
  assert.equal(integrationCounts.pass, 5);
  for (const key of ['fail','cancelled','skipped','todo']) assert.equal(integrationCounts[key], 0);
  report.integrationTests = { counts: integrationCounts, executedFromExtractedSource: true,
    fullGNUComparisons: 32, defaultCLIRustReceiptVerified: true, privateBashRustReceiptVerified: true,
    userBashAndChildShellsUnchanged: true, optionalMissingToolchainFallbackVerified: true };

  writeFileSync(join(outside, 'hit.txt'), 'head\nneedle needle\ntail\n');
  writeFileSync(join(outside, 'miss.txt'), 'head\nother\ntail\n');
  writeFileSync(join(outside, 'binary'), Buffer.from('head\0needle\n'));
  const cliCases = [
    ['content', ['-anF', 'needle', 'hit.txt']],
    ['count-zero', ['-acF', 'needle', 'miss.txt']],
    ['stdin', ['-anF', 'needle'], Buffer.from('head\nneedle\ntail\n')],
    ['ordered-operands', ['-anF', 'needle', 'miss.txt', 'hit.txt', 'hit.txt']],
    ['binary-diagnostic', ['-nF', 'needle', 'binary']],
    ['missing-file-diagnostic', ['-nF', 'needle', 'missing-file', 'hit.txt']],
  ];
  report.cli = { workingDirectory: outside, fullGNUComparisons: 0,
    packagedLauncher: join(packageRoot, 'bin', 'grep2rg'), rebuiltRustCLI: binary,
    launcherRustCoverageClaimed: true, observations: [] };
  for (const [id, argv, input = Buffer.alloc(0)] of cliCases) {
    const oracle = await command(`GNU CLI oracle: ${id}`, '/usr/bin/grep', argv,
      { input, argv0: 'grep', requireSuccess: false });
    for (const [label, program] of [['Rust', binary], ['packaged-launcher', report.cli.packagedLauncher]]) {
      const routeFile = join(outside, `route-${label}-${id}.json`);
      const actual = await command(`${label} CLI: ${id}`, program, argv,
        { input, argv0: 'grep', environment: { GREP2RG_ENGINE_REPORT: routeFile, GREP2RG_RUST_BINARY: binary }, requireSuccess: false });
      const route = existsSync(routeFile) ? JSON.parse(readFileSync(routeFile, 'utf8')) : null;
      const comparison = { id, label, argv, GNU: resultEvidence(oracle), actual: resultEvidence(actual),
        route, statusMatches: actual.status === oracle.status,
        fullStdoutMatches: actual.stdout.equals(oracle.stdout), fullStderrMatches: actual.stderr.equals(oracle.stderr) };
      report.cli.observations.push(comparison);
      report.cli.fullGNUComparisons++;
      assert.ok(comparison.statusMatches && comparison.fullStdoutMatches && comparison.fullStderrMatches, `${label} CLI disagreed with GNU for ${id}`);
      assert.ok(route && ['rust', 'gnu'].includes(route.engine), 'Direct and packaged CLI must report the rebuilt Rust engine route');
    }
  }
  assert.equal(fileHash(binary), binaryHash, 'Rebuilt release binary changed during qualification');
  assert.deepEqual(rustFiles(join(source, 'rust')), originalRustFiles, 'Rust source file inventory changed during artifact verification');
  assert.deepEqual(sourceHashes(trackedFiles, source), originalHashes, 'Source files changed during artifact verification');
  assert.deepEqual(sourceHashes(originalRustFiles, packageRoot), extractedHashes, 'Build/tests modified packaged Rust sources');
  const originalReleaseHashAfter = existsSync(originalRelease) ? fileHash(originalRelease) : null;
  assert.equal(originalReleaseHashAfter, originalReleaseHash, 'The original Rust release target changed during independent verification');
  assert.equal(fileHash('/usr/bin/grep'), oracleHash, 'The independent GNU oracle changed during qualification');
  assert.equal(fileHash(archive), report.packageArtifact.SHA256, 'The packed archive changed during qualification');
  report.sourceAndExecutableHashesStable = true;
  report.fullGNUComparisons = report.tests.fullGNUComparisons + report.cli.fullGNUComparisons + report.integrationTests.fullGNUComparisons;
  report.stageCount = report.stages.length;
  report.status = 'passed'; succeeded = true;
  process.stdout.write(`Extracted Rust package passed: ${report.tests.counts.pass} tests, ${report.fullGNUComparisons} full GNU comparisons, ${report.tests.rustSearches} native Rust suite searches.\n`);
} catch (error) {
  report.status = 'failed';
  report.failures.push({ name: error.name, message: error.message, stack: error.stack });
  report.stageCount = report.stages.length;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
  report.completedAt = new Date().toISOString();
  report.fullGNUComparisons = (report.tests?.fullGNUComparisons ?? 0) + (report.cli?.fullGNUComparisons ?? 0) + (report.integrationTests?.fullGNUComparisons ?? 0);
  report.cleanup = succeeded ? 'Owned archive/cache/build/extraction/outside-cwd directories removed after verification.' :
    'Owned archive/cache/build/extraction/outside-cwd directories retained for failure evidence.';
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (succeeded) {
    rmSync(owned, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}
