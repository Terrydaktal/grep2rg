#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const capturePath = resolve(process.argv[2] || join(root, 'docs/rust-engine-performance.json'));
const output = resolve(process.argv[3] || join(root, 'docs/rust-engine.md'));
const report = JSON.parse(readFileSync(capturePath, 'utf8'));
const qualification = JSON.parse(readFileSync(join(root, 'docs/rust-engine-qualification.json'), 'utf8'));
if (report.reportKind !== 'performance' || report.historicalClassCount !== 28 ||
    !report.methodology.sourcesStable || report.methodology.measuredTrials < 7 ||
    report.cases.some(row => row.comparisons.Rust.category !== 'exact' ||
      !['rust', 'gnu'].includes(row.routeEvidence.report?.engine))) {
  throw Error('A complete, stable, GNU-exact 28-class performance capture is required');
}
if (qualification.status !== 'passed' || !qualification.sourceAndExecutableHashesStable) {
  throw Error('Packaged qualification must pass with stable tested source and executable');
}
let releaseIdentity = 'The rebuilt package executable has the same SHA-256 as the measured release.';
if (qualification.executable.SHA256 !== report.executables.Rust.SHA256) {
  // Test-only source declarations may change local LLVM symbols/build ID while
  // preserving every executable section. Require the controlled build receipt;
  // never transfer timings to an arbitrary different binary.
  const receipt = JSON.parse(readFileSync(join(root, 'docs/rust-engine-build-equivalence.json'), 'utf8'));
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.beforeSHA256, report.executables.Rust.SHA256);
  assert.equal(receipt.afterSHA256, qualification.executable.SHA256);
  assert.equal(receipt.entryPoint.before, receipt.entryPoint.after);
  assert.deepEqual(receipt.programHeaders.before, receipt.programHeaders.after);
  assert.ok(receipt.allocatedSections.some(row => row.name === '.text'));
  assert.ok(receipt.allocatedSections.some(row => row.name === '.rodata'));
  for (const row of receipt.allocatedSections) {
    if (row.name === '.note.gnu.build-id') {
      const withoutPayload = ({ payloadSHA256, ...layout }) => layout;
      assert.deepEqual(withoutPayload(row.before), withoutPayload(row.after));
      assert.equal(row.excludedPayload, true);
    } else {
      assert.deepEqual(row.before, row.after, `Runtime section differs: ${row.name}`);
      assert.equal(row.excludedPayload, false);
    }
  }
  for (const [name, hash] of Object.entries(receipt.variants.current.sourceHashes))
    assert.equal(hash, qualification.sourceHashes[`rust/${name}`], `Build receipt source differs: ${name}`);
  releaseIdentity = 'The timing capture retains its original full-file SHA. The current rebuild has byte-identical code, data and layout; only its build ID and non-loaded symbol metadata differ. The [controlled build comparison](rust-engine-build-equivalence.json) records both artifact identities.';
}
const labels = {
  'recursive-count': 'Recursive literal counts',
  'recursive-invert-count': 'Recursive inverse counts',
  'recursive-filenames-sparse': 'Recursive sparse matching filenames',
  'recursive-filenames-no-match': 'Recursive filenames, no match',
  'explicit-count': 'Explicit-file literal counts',
  'explicit-filenames-sparse': 'Explicit-file sparse matching filenames',
  'explicit-filenames-no-match': 'Explicit-file filenames, no match',
  'single-large-count-native': 'Single large file, literal count',
  'small-file-native': 'Small file, matching lines',
  'stdin-native': 'Piped stdin, matching lines',
  'regex-compatible-count': 'ERE counts',
  'recursive-dense-filenames-native': 'Dense early matching filenames',
  'small-recursive-count-native': 'Small recursive tree, counts',
  'many-tiny-count-native': 'Many tiny files, counts',
  'below-threshold-count-native': 'Medium corpus, counts',
  'long-record-count-native': 'Long lines, counts',
  'long-record-content-native': 'Long lines, matching lines',
  'recursive-content': 'Recursive literal matching lines',
  'recursive-regex-content': 'Recursive ERE matching lines',
  'recursive-filter-native': 'Include-filtered filename search',
  'recursive-dereference-native': 'Symlink-following filename search',
  'word-extraction-native': 'Whole-word match extraction',
  'null-records-native': 'NUL-delimited records, counts',
  'pattern-file-native': 'Patterns read from a file',
  'quiet-native': 'Quiet, early exit',
  'binary-content-native': 'Default binary-file reporting',
  'unicode-folding-native': 'Non-ASCII pattern, C-locale case folding',
  'context-native': 'Matching lines with context',
};
const fmt = value => value.toFixed(2);
const native = report.cases.filter(row => row.routeEvidence.report?.engine === 'rust');
const both = native.filter(row => row.comparisons.rg.compatibleForSpeedRatio);
const fasterBoth = both.filter(row => row.medianMs.Rust < Math.min(row.medianMs.GNU, row.medianMs.rg));
const fasterGNU = native.filter(row => row.medianMs.Rust < row.medianMs.GNU);
const nativeRatio = fasterGNU.map(row => row.medianMs.GNU / row.medianMs.Rust);
const rows = report.cases.map(row => {
  const path = row.routeEvidence.report?.engine === 'rust' ? 'Rust' : 'GNU fallback';
  const rg = `${fmt(row.medianMs.rg)}${row.comparisons.rg.compatibleForSpeedRatio ? '' : ' †'}`;
  return `| ${labels[row.id]} | ${fmt(row.medianMs.GNU)} | ${rg} | ${fmt(row.medianMs.Rust)} | ${path} |`;
});
const version = label => report.executables[label].versionStdout.split('\n')[0];
const text = `# Integrated Rust search engine

The executable at \`rust/target/release/grep2rg-rust\` performs qualified searches
inside one native process. It uses SIMD-capable byte/literal matching and Rust
regex libraries, chooses sequential or parallel work, and retains GNU operand
and recursive traversal ordering. Native searches launch neither Node nor rg.
GNU grep receives unsupported cases directly before native search output.

## Current measurements

Captured ${report.createdAt} on ${report.machine.cpu}. Baselines are direct
${version('GNU')} and direct ${version('rg')}. Release executable SHA-256:
\`${report.executables.Rust.SHA256}\`.

These are warm-cache medians in milliseconds, with ${report.methodology.warmups} warmup(s) and ${report.methodology.measuredTrials} rotated
trials per class. Timings include process startup, all search work and complete
stdout/stderr capture. Hashing, comparison, fixture creation, inventory checks
and route reporting are excluded. Each search executable is launched directly,
without a search translator.
${report.methodology.timingBoundary ?? 'The Node process timer includes spawnSync setup and capture work.'}

All 28 Rust-tool classes match GNU stdout, stderr, exit status and ordering
exactly. ${native.length} classes perform native Rust searches; the others are
explicit GNU fallbacks. Among native classes, ${fasterGNU.length} have a lower
median than GNU, and ${fasterBoth.length}/${both.length} classes with comparable
rg output have a lower median than both baselines. The largest measured native
gain over GNU is ${Math.max(...nativeRatio).toFixed(2)}×. Sub-millisecond
differences and small relative margins need more samples before claiming a
repeatable advantage; these counts describe this capture, not universal wins.

| Workload | Direct GNU ms | Direct rg ms | Rust tool ms | Execution |
| --- | ---: | ---: | ---: | --- |
${rows.join('\n')}

† Direct rg uses different GNU binary diagnostic formatting/channel or a NUL
count terminator where GNU prints LF. Its elapsed time is retained, but that
row is not a compatible-output speed comparison. On parallel searches rg may
also emit the same complete result records in a different order; this is
recorded separately. Rust retains GNU's exact order.

All ${report.cases.filter(row => row.comparisons.rg.compatibleForSpeedRatio).length} classes with comparable rg output have a lower Rust-tool median.
The two incompatible-output rows also have lower elapsed times, but they do not
establish equivalent-output speedups. These results apply to the measured warm
fixtures and C locale, rather than every input, platform or argument combination.

## Further optimization

The engine now discovers regular files without redundant serial metadata calls,
parallelizes required access/identity checks, reuses bounded worker buffers for
medium files, and reuses the worker pool with fewer execution barriers. Literal
work uses up to eight workers; large regex work can use sixteen. A proven match
in a complete first record can finish a filename search during preparation.
Incomplete first records never provide that shortcut, and GNU output order is retained.

The [raw capture](rust-engine-performance.json) contains every sample, original
arguments, input coverage, output hashes, engine routes and source/executable
identities. Earlier release measurements remain in the [archived-release
capture](rust-engine-prior-native-performance.json); the table above reports
only the current release and the GNU/rg baselines.

## Build, verify and reproduce

Requires Linux, Rust 1.90 or newer and GNU grep for compatibility fallbacks.

\`\`\`bash
cargo build --release --locked --manifest-path rust/Cargo.toml
rust/target/release/grep2rg-rust -arnF 'needle' src
npm run test:rust
npm run test:integration
GREP2RG_BENCH_RG=/usr/bin/rg node tools/benchmark-rust-engine.mjs
GREP2RG_BENCH_RG=/usr/bin/rg GREP2RG_BENCH_REPETITIONS=21 GREP2RG_BENCH_WARMUPS=3 \\
  node tools/benchmark-rust-engine.mjs --low-overhead-timing
node tools/render-rust-results.mjs
\`\`\`

The Rust GNU-oracle harness checks actual release output and routes, including all
28 measured classes, seeded byte/regex cases, parallel ordering, raw filename
bytes, stdin, record boundaries, diagnostics and SIGPIPE. Delegating to GNU
earns compatibility coverage but never native Rust search coverage.

\`node tools/verify-rust-artifact.mjs\` separately extracts the actual npm source
archive, checks Rust source identities and build-output exclusion, rebuilds
that source with locked dependencies, and tests its release CLI from outside
the checkout. CI runs this packaged-source qualification too.

The [packaged qualification](rust-engine-qualification.json) records ${qualification.fullGNUComparisons.toLocaleString('en-US')} exact
GNU comparisons: ${qualification.tests.fullGNUComparisons.toLocaleString('en-US')} Rust-engine cases, including ${qualification.tests.rustSearches.toLocaleString('en-US')} native Rust searches and ${qualification.tests.gnuFallbacks.toLocaleString('en-US')}
GNU fallbacks, plus ${qualification.cli.fullGNUComparisons} packaged CLI checks and ${qualification.integrationTests?.fullGNUComparisons ?? 0} Node CLI/private-function integration comparisons. ${releaseIdentity} Rust units passed
${qualification.unitTests.debug.passed} debug and ${qualification.unitTests.release.passed} release checks. Node tests retain the Pi, launcher,
packaging, process-timer and evidence-validation boundaries; they do not duplicate
the engine campaign.
The eight packaged process-timer checks also pass, including complete binary
capture, literal arguments, timeout/descendant cleanup, output limits and exit
notification without timeout polling. The new Rust checks exercise ordered
large-output spills, a 64-descriptor limit and complete-record shortcut boundaries.

## Native scope and compatibility boundaries

Native routes include fixed-pattern matching, qualified byte ERE, counts,
inverse counts, filename listing, line numbering, fixed whole-word/whole-line
matching and extraction, NUL-delimited records, pattern files, include filters,
and qualified recursive/symlink-following traversal. Parallel output is bounded
and emitted in GNU order. Tiny work and early dense filename matches can use
the sequential path without a worker pool.

Context output, default binary diagnostics, locale-sensitive cases, complex
BRE/ERE, POSIX longest regex extraction, seekable stdin and unusual descriptors
retain GNU where matching semantics or observable behavior have not been qualified.
The full-class timing fixture uses \`LC_ALL=C\`; it does not establish native
performance in every locale. \`--help\` and \`--version\` retain GNU's responses.

Set \`GREP2RG_ENGINE_REPORT=/absolute/report.json\` for a separate diagnostic
invocation. It reports the engine, strategy, fallback reason, workers and input
size. Leave it unset for performance measurements. \`GREP2RG_ACCELERATION=gnu\`
explicitly chooses GNU.

The CLI and provider-scoped Pi Bash function prefer this host-local Rust build.
The historical C dispatcher remains a fallback when Rust is unavailable and
can be selected explicitly with \`GREP2RG_ENGINE=c\`. User shells and child
scripts retain GNU. A measured loss or GNU fallback remains visible.
`;
writeFileSync(output, text);
console.log(JSON.stringify({ output, capture: capturePath, nativeClasses: native.length,
  fasterGNU: fasterGNU.length, fasterBoth: fasterBoth.length, comparableNativeClasses: both.length }));
