#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createFixture, historicalClassIds, specifications } from './rust-benchmark-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const maxBuffer = 32 * 1024 * 1024;
const environment = { ...process.env, LC_ALL: 'C', LANG: 'C' };
for (const key of Object.keys(environment)) {
  if (key.startsWith('GREP2RG_') || key === 'POSIXLY_CORRECT' || key === 'RIPGREP_CONFIG_PATH') delete environment[key];
}

function positiveInteger(value, name, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw Error(`${name} must be a positive integer`);
  return number;
}

function resolveExecutable(name, override) {
  if (override) {
    if (!isAbsolute(override)) throw Error('Executable overrides must use an absolute path');
    accessSync(override, constants.X_OK); return realpathSync(override);
  }
  for (const directory of (process.env.PATH || '').split(':')) {
    const candidate = resolve(directory || '.', name);
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return realpathSync(candidate); } catch {}
  }
  throw Error(`Cannot resolve ${name} on PATH`);
}

function run(program, argv, row, extraEnvironment = {}) {
  return spawnSync(program, argv, {
    argv0: program === '/usr/bin/grep' ? 'grep' : undefined,
    input: row?.stdin, env: { ...environment, ...extraEnvironment },
    cwd: root, maxBuffer, timeout: 120000,
  });
}

function runProcessBatch(variants, row, warmups, repetitions, python) {
  const jobs = [];
  for (let round = 0; round < warmups + repetitions; round++) {
    const warmup = round < warmups;
    const measuredRound = round - warmups;
    const labels = Object.keys(variants), rotation = warmup ? 0 : measuredRound % labels.length;
    for (const label of labels.slice(rotation).concat(labels.slice(0, rotation))) {
      const program = variants[label];
      jobs.push({ id: row.id, label, round: warmup ? round : measuredRound, warmup,
        program, argv: [program === '/usr/bin/grep' ? 'grep' : program,
          ...(label === 'rg' ? row.rgArgv : row.grepArgv)],
        stdinBase64: (row.stdin ?? Buffer.alloc(0)).toString('base64'),
        env: environment, cwd: root, timeoutMs: 120000,
        maxCapturedBytesPerChannel: maxBuffer });
    }
  }
  const result = spawnSync(python, [join(root, 'tools/benchmark-processes.py')], {
    input: JSON.stringify({ jobs }), env: environment, cwd: root,
    maxBuffer: 256 * 1024 * 1024, timeout: 120000 * jobs.length,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw Error(`Native-process timing driver failed: ${result.error?.message ?? result.signal ?? result.stderr.toString('utf8')}`);
  }
  const batch = JSON.parse(result.stdout.toString('utf8'));
  if (batch.observations?.length !== jobs.length) throw Error('Timing driver omitted observations');
  return batch.observations.map((observation, index) => {
    const expected = jobs[index];
    if (['id', 'label', 'round', 'warmup'].some(key => observation[key] !== expected[key]) ||
        !Number.isFinite(observation.durationMs) || observation.durationMs < 0) {
      throw Error('Timing driver returned invalid identity or duration');
    }
    return { ...observation, result: { status: observation.status, signal: observation.signal,
      error: observation.error, stdout: Buffer.from(observation.stdoutBase64, 'base64'),
      stderr: Buffer.from(observation.stderrBase64, 'base64') } };
  });
}

function resultError(result) {
  return result.error ? { code: result.error.code ?? null, message: result.error.message } : null;
}

function records(buffer) {
  // GNU count output uses LF even with -z. rg --null-data count output uses
  // NUL instead; keep that differing byte in the record so it cannot pass as
  // GNU-compatible. Record bytes and duplicates survive order normalization.
  const result = []; let beginning = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 10) continue;
    result.push(buffer.subarray(beginning, i + 1)); beginning = i + 1;
  }
  if (beginning < buffer.length) result.push(buffer.subarray(beginning));
  return result;
}

function normalizedHash(rows) {
  const hash = createHash('sha256');
  for (const row of [...rows].sort(Buffer.compare)) { hash.update(String(row.length)); hash.update(':'); hash.update(row); }
  return hash.digest('hex');
}

function selectedFiles(outputRecords, row) {
  if (row.kind === 'quiet' || row.kind === 'binary') return [];
  if (!row.hasFilenamePrefix) return outputRecords.length ? row.inputPaths : [];
  const files = outputRecords.map(record => {
    if (row.kind === 'filenames') return record.subarray(0, record.at(-1) === 10 ? -1 : undefined);
    const colon = record.indexOf(58);
    return colon < 0 ? record : record.subarray(0, colon);
  });
  return [...new Set(files.map(file => file.toString('base64')))].map(file => Buffer.from(file, 'base64'));
}

function evidence(result, row) {
  const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0);
  const outputRecords = records(stdout);
  const files = selectedFiles(outputRecords, row).map(file => Buffer.isBuffer(file) ? file : Buffer.from(file));
  let countSum = null;
  if (row.kind === 'count') {
    // Parsing the displayed count is a separate metric; raw output bytes and
    // record comparisons still preserve any LF/NUL formatting disagreement.
    const counts = outputRecords.map(record => Number(record.toString('utf8').replace(/[\n\0]$/, '').split(':').at(-1)));
    if (counts.every(Number.isSafeInteger)) countSum = counts.reduce((a, b) => a + b, 0);
  }
  return {
    status: result.status, signal: result.signal, error: resultError(result),
    stdoutBytes: stdout.length, stderrBytes: stderr.length,
    stdoutSHA256: sha(stdout), stderrSHA256: sha(stderr),
    stdoutRecordCount: outputRecords.length,
    normalizedStdoutSHA256: normalizedHash(outputRecords),
    outputFileCount: files.length, outputFileSHA256: normalizedHash(files),
    selectedLineCount: countSum,
    // Diagnostics stay reviewable; full buffers are hashed and compared.
    stdout: stdout.length <= 4096 ? stdout.toString('utf8') : null,
    stderr: stderr.length <= 4096 ? stderr.toString('utf8') : null,
  };
}

function compare(actual, oracle, row, label, coverageMatches = true) {
  const actualEvidence = evidence(actual, row), expected = evidence(oracle, row);
  const valid = !actual.error && !actual.signal && actual.status !== null;
  const statusMatches = actual.status === oracle.status;
  const stderrMatches = (actual.stderr ?? Buffer.alloc(0)).equals(oracle.stderr);
  const stdoutMatches = (actual.stdout ?? Buffer.alloc(0)).equals(oracle.stdout);
  const recordsMatch = actualEvidence.normalizedStdoutSHA256 === expected.normalizedStdoutSHA256;
  const fileRecordsMatch = actualEvidence.outputFileCount === expected.outputFileCount &&
    actualEvidence.outputFileSHA256 === expected.outputFileSHA256;
  let category = 'incompatible';
  if (!valid || actual.status === 2 && oracle.status !== 2) category = 'unavailable';
  else if (statusMatches && stderrMatches && stdoutMatches && coverageMatches) category = 'exact';
  else if (label === 'rg' && statusMatches && stderrMatches && recordsMatch && fileRecordsMatch && coverageMatches) category = 'same-records-different-order';
  // Known channel/format differences never receive a speed ratio.
  if (label === 'rg' && row.knownDifferences.length && category !== 'unavailable') category = 'incompatible';
  return {
    category, compatibleForSpeedRatio: category === 'exact' || category === 'same-records-different-order',
    exactGNUOrder: category === 'exact', statusMatches, stderrMatches, stdoutMatches,
    fullOccurrenceRecordsMatch: recordsMatch, outputFileRecordsMatch: fileRecordsMatch,
    inputFileCoverageMatches: coverageMatches,
  };
}

function collectSourceFiles() {
  const files = ['tools/benchmark-rust-engine.mjs', 'tools/rust-benchmark-fixture.mjs', 'tools/benchmark-routing.mjs'];
  if (existsSync(join(root, 'tools/benchmark-processes.py'))) files.push('tools/benchmark-processes.py');
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'target' || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /(?:\.rs|Cargo\.toml|Cargo\.lock)$/.test(path)) files.push(relative(root, path));
    }
  }
  if (existsSync(join(root, 'rust'))) visit(join(root, 'rust'));
  return files.sort();
}

function hashes(files) {
  return Object.fromEntries(files.map(file => [file, sha(readFileSync(isAbsolute(file) ? file : join(root, file)))]));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function reportRoute(program, row, fixture) {
  const path = join(fixture.directory, 'engine-route.json');
  rmSync(path, { force: true });
  const result = run(program, row.grepArgv, row, { GREP2RG_ENGINE_REPORT: path });
  const contents = existsSync(path) ? readFileSync(path, 'utf8') : null;
  let parsed = null;
  if (contents) {
    try { parsed = JSON.parse(contents); }
    catch { parsed = contents.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return line; } }); }
  }
  return { requestedOutsideTiming: true, available: Boolean(contents), report: parsed,
    reportSHA256: contents === null ? null : sha(contents), observation: evidence(result, row) };
}

function inventory(row, program, fixture) {
  if (row.group === 'stdin') return { count: 1, SHA256: normalizedHash([Buffer.from('(standard input)')]), declaredStdin: true, matches: true };
  const result = run(program, row.rgInventoryArgv, row);
  const observed = records(result.stdout ?? Buffer.alloc(0)).map(record => record.toString('utf8').replace(/\n$/, ''));
  const expected = row.inputPaths;
  const actualHash = normalizedHash(observed.map(path => Buffer.from(fixture.relative(path))));
  const expectedHash = normalizedHash(expected.map(path => Buffer.from(fixture.relative(path))));
  return { status: result.status, error: resultError(result), count: observed.length,
    SHA256: actualHash, expectedCount: expected.length, expectedSHA256: expectedHash,
    matches: !result.error && !result.signal && result.status === 0 && actualHash === expectedHash };
}

// This inexpensive mode validates all historical class IDs before any fixture
// allocation, build or timed execution. It is useful while a build is running.
if (process.argv.includes('--list')) {
  const historical = [...readFileSync(join(root, 'tools/benchmark-routing.mjs'), 'utf8')
    .matchAll(/^\s*\['([^']+)',\s*\[/gm)].map(match => match[1]);
  if (JSON.stringify(historical) !== JSON.stringify(historicalClassIds)) throw Error('Historical benchmark class coverage changed');
  console.log(JSON.stringify({ historicalClassCount: historicalClassIds.length, historicalClassIds }, null, 2));
  process.exit(0);
}

const validationOnly = process.argv.includes('--validate-fixtures');
const lowOverheadTiming = process.argv.includes('--low-overhead-timing');
const python = lowOverheadTiming ? resolveExecutable('python3', process.env.GREP2RG_BENCH_PYTHON) : undefined;
const repetitions = positiveInteger(process.env.GREP2RG_BENCH_REPETITIONS, 'GREP2RG_BENCH_REPETITIONS', 7);
const warmups = positiveInteger(process.env.GREP2RG_BENCH_WARMUPS, 'GREP2RG_BENCH_WARMUPS', 1);
if (!validationOnly && repetitions < 7 && process.env.GREP2RG_BENCH_DRY_RUN !== '1') {
  throw Error('Performance reports require at least seven trials; use GREP2RG_BENCH_DRY_RUN=1 for an explicitly labelled functional run');
}
const rg = resolveExecutable('rg', process.env.GREP2RG_BENCH_RG);
const rust = resolveExecutable('grep2rg-rust', process.env.GREP2RG_BENCH_ENGINE || join(root, 'rust/target/release/grep2rg-rust'));
const variants = { GNU: '/usr/bin/grep', Rust: rust, rg };
const sourceFiles = collectSourceFiles();
const trackedFiles = [...sourceFiles, ...new Set(Object.values(variants)), ...(python ? [python] : [])];
const beforeHashes = hashes(trackedFiles);
const output = process.argv.find((arg, i) => i > 1 && !arg.startsWith('--')) ||
  join(root, validationOnly ? 'docs/rust-engine-fixture-validation.json' : 'docs/rust-engine-performance.json');
const cases = [];
let fixture;
try {
  fixture = createFixture();
  const rows = specifications(fixture);
  if (JSON.stringify(rows.map(row => row.id)) !== JSON.stringify(historicalClassIds)) throw Error('Missing historical benchmark class');
  for (const row of rows) {
    fixture.prepare(row.group);
    const oracle = run(variants.GNU, row.grepArgv, row);
    if (oracle.error || oracle.signal || oracle.status === null || oracle.status > 1) throw Error(`${row.id}: GNU fixture failed`);
    const rgCoverage = inventory(row, rg, fixture);
    const routeEvidence = reportRoute(rust, row, fixture);
    const samples = Object.fromEntries(Object.keys(variants).map(label => [label, []]));
    const baselineComparisons = {};
    if (lowOverheadTiming && !validationOnly) {
      for (const observation of runProcessBatch(variants, row, warmups, repetitions, python)) {
        const { label, round, durationMs, result } = observation;
        const comparison = compare(result, oracle, row, label, label !== 'rg' || rgCoverage.matches);
        if (observation.warmup) baselineComparisons[label] = comparison;
        else samples[label].push({ round, durationMs, evidence: evidence(result, row), comparison });
      }
    } else {
      // Warmups perform all comparisons but do not enter the timed medians.
      for (let round = 0; round < warmups; round++) {
        for (const [label, program] of Object.entries(variants)) {
          const result = run(program, label === 'rg' ? row.rgArgv : row.grepArgv, row);
          baselineComparisons[label] = compare(result, oracle, row, label, label !== 'rg' || rgCoverage.matches);
        }
      }
      for (let round = 0; round < (validationOnly ? 0 : repetitions); round++) {
        const labels = Object.keys(variants), rotation = round % labels.length;
        for (const label of labels.slice(rotation).concat(labels.slice(0, rotation))) {
          const started = performance.now();
          const result = run(variants[label], label === 'rg' ? row.rgArgv : row.grepArgv, row);
          const durationMs = performance.now() - started;
          // Hashing, sorting and GNU comparisons are all outside the timer.
          samples[label].push({ round, durationMs,
            evidence: evidence(result, row),
            comparison: compare(result, oracle, row, label, label !== 'rg' || rgCoverage.matches) });
        }
      }
    }
    const medianMs = Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, median(values.map(value => value.durationMs))]));
    const comparisons = Object.fromEntries(Object.entries(samples).map(([label, values]) => {
      const observed = values.length ? values.map(value => value.comparison) : [baselineComparisons[label]];
      const category = observed.every(value => value.category === 'exact') ? 'exact' :
        observed.every(value => value.compatibleForSpeedRatio) ? 'same-records-different-order' :
        observed.some(value => value.category === 'unavailable') ? 'unavailable' : 'incompatible';
      return [label, { category, exactGNUOrder: category === 'exact',
        compatibleForSpeedRatio: observed.every(value => value.compatibleForSpeedRatio),
        observations: observed.length }];
    }));
    const speedRatios = Object.fromEntries(['Rust', 'rg'].map(label => [label,
      comparisons[label].compatibleForSpeedRatio && medianMs[label] ? medianMs.GNU / medianMs[label] : null]));
    const observed = {
      id: row.id, kind: row.kind, group: row.group,
      grepArgv: row.grepArgv, rgArgv: row.rgArgv,
      inputFiles: { count: row.inputPaths.length, SHA256: normalizedHash(row.inputPaths.map(path => Buffer.from(fixture.relative(path)))) },
      rgInputFileCoverage: rgCoverage, oracleEvidence: evidence(oracle, row),
      routeEvidence, warmups, repetitions: validationOnly ? 0 : repetitions,
      comparisons, knownDifferences: row.knownDifferences, limitations: row.limitations,
      medianMs, GNUOverEngineMedianRatio: speedRatios, samples,
    };
    cases.push(observed);
    console.log(JSON.stringify({ id: row.id, medianMs, comparisons,
      GNUOverEngineMedianRatio: speedRatios, route: routeEvidence.report }));
  }
  const afterHashes = hashes(trackedFiles);
  const sourcesStable = JSON.stringify(beforeHashes) === JSON.stringify(afterHashes) &&
    JSON.stringify(sourceFiles) === JSON.stringify(collectSourceFiles());
  const report = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    reportKind: validationOnly ? 'untimed-fixture-validation' :
      process.env.GREP2RG_BENCH_DRY_RUN === '1' ? 'functional-dry-run-not-performance' : 'performance',
    scope: 'All 28 historical public synthetic workloads. Direct native Rust engine, direct GNU grep, and direct rg; no Bash, Node compatibility wrapper or postprocessor in any child command. Full process startup and stdout/stderr pipe capture are timed. Warm-cache results are specific to this machine and these inputs.',
    methodology: {
      warmups, measuredTrials: validationOnly ? 0 : repetitions,
      rotatedOrder: ['GNU', 'Rust', 'rg'], locale: 'C', maxCapturedBytesPerChannel: maxBuffer,
      timersInclude: 'spawn, complete child execution, process startup, complete stdout/stderr pipe capture',
      timersExclude: 'fixture construction, route report, inventory verification, output hashes, record sorting, semantic comparisons, report writing',
      GNUComparison: 'An independent untimed direct GNU oracle is compared against every timed observation: status, stdout and stderr. Rust must retain exact GNU bytes and order.',
      rgComparison: 'All full LF-delimited output records are compared as a byte multiset, preserving duplicates and line/count/file contents. File inventory, status and stderr must agree. Output order is explicitly reported; speed ratios are null for incompatible or unavailable observations.',
      sourceStabilityChecked: true, sourcesStable,
      timingDriver: lowOverheadTiming ? 'persistent-python-batch' : 'node-spawnSync',
      timingDriverExecutable: python ? { path: python, SHA256: beforeHashes[python] } : null,
      timingBoundary: lowOverheadTiming
        ? 'Python monotonic timer directly surrounds child creation and complete pipe capture/wait. Python startup, JSON encoding/decoding and Node orchestration are outside the timer.'
        : 'Node performance timer directly surrounds spawnSync, including its parent-side setup and pipe machinery.',
    },
    semanticLimits: [
      'These 28 historical classes contain no PCRE pattern. GNU -P and rg --pcre2 have different syntax/defaults and are not qualified or timed here. No PCRE speed claim follows from these ERE/fixed-pattern rows.',
      'rg uses explicit GNU-like hidden/ignore, byte encoding, C-locale case/word handling, filename prefixes and zero counts. Its default Unicode, ignore filtering and encoding detection are not being compared against GNU C semantics.',
      'rg may emit equivalent complete records in a different order. Those ratios measure equivalent result records but not GNU output-order compatibility.',
      'GNU binary diagnostic formatting/channel differs from rg. That row retains timings and hashes but does not receive a compatible-output speed ratio.',
      'GNU -z count output ends with LF; rg --null-data count output ends with NUL. That row retains timings and hashes but does not receive a compatible-output speed ratio.',
      'Historical class names ending in native are identifiers, not proof of the Rust route. Only the separate route evidence identifies native execution or GNU fallback.',
    ],
    fixture: { ...fixture.metadata, root: fixture.directory, cleanup: 'Owned temporary directory removed in finally after the report is written.' },
    machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    executables: Object.fromEntries(Object.entries(variants).map(([label, path]) => {
      const version = run(path, ['--version']);
      return [label, { path, SHA256: beforeHashes[path],
        versionStatus: version.status, versionStdout: (version.stdout ?? Buffer.alloc(0)).toString('utf8'),
        versionStderr: (version.stderr ?? Buffer.alloc(0)).toString('utf8') }];
    })),
    nodeVersion: process.version,
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, beforeHashes[file]])),
    executableHashesAfter: Object.fromEntries(Object.values(variants).map(path => [path, afterHashes[path]])),
    historicalClassCount: cases.length, historicalClassIds, cases,
  };
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  if (!sourcesStable || cases.some(row => row.comparisons.GNU.category !== 'exact' || row.comparisons.Rust.category !== 'exact')) process.exitCode = 1;
} finally {
  fixture?.cleanup();
}
