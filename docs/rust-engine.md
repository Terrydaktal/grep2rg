# Integrated Rust search engine

The executable at `rust/target/release/grep2rg-rust` performs qualified searches
inside one native process. It uses SIMD-capable byte/literal matching and Rust
regex libraries, chooses sequential or parallel work, and retains GNU operand
and recursive traversal ordering. Native searches launch neither Node nor rg.
GNU grep receives unsupported cases directly before native search output.

## Current measurements

Captured 2026-10-12T18:40:49.501Z on AMD Ryzen 9 9950X 16-Core Processor. Baselines are direct
grep (GNU grep) 3.12-modified and direct ripgrep 15.2.0. Release executable SHA-256:
`73b7b41b4fd299e9e605161a234f80dc71cab71588fbd6776e3ad0b78d8a64ed`.

These are warm-cache medians in milliseconds, with 3 warmup(s) and 21 rotated
trials per class. Timings include process startup, all search work and complete
stdout/stderr capture. Hashing, comparison, fixture creation, inventory checks
and route reporting are excluded. Each search executable is launched directly,
without a search translator.
Python monotonic timer directly surrounds child creation and complete pipe capture/wait. Python startup, JSON encoding/decoding and Node orchestration are outside the timer.

All 28 Rust-tool classes match GNU stdout, stderr, exit status and ordering
exactly. 26 classes perform native Rust searches; the others are
explicit GNU fallbacks. Among native classes, 17 have a lower
median than GNU, and 17/25 classes with comparable
rg output have a lower median than both baselines. The largest measured native
gain over GNU is 19.83×. Sub-millisecond
differences and small relative margins need more samples before claiming a
repeatable advantage; these counts describe this capture, not universal wins.

| Workload | Direct GNU ms | Direct rg ms | Rust tool ms | Execution |
| --- | ---: | ---: | ---: | --- |
| Recursive literal counts | 64.25 | 8.33 | 6.77 | Rust |
| Recursive inverse counts | 78.57 | 9.24 | 6.87 | Rust |
| Recursive sparse matching filenames | 63.04 | 8.20 | 6.55 | Rust |
| Recursive filenames, no match | 64.58 | 8.14 | 6.55 | Rust |
| Explicit-file literal counts | 63.46 | 9.08 | 7.56 | Rust |
| Explicit-file sparse matching filenames | 62.47 | 8.77 | 7.80 | Rust |
| Explicit-file filenames, no match | 64.83 | 8.51 | 7.57 | Rust |
| Single large file, literal count | 28.36 | 2.76 | 2.31 | Rust |
| Small file, matching lines | 0.36 | 0.66 | 0.42 | Rust |
| Piped stdin, matching lines | 0.33 | 0.66 | 0.37 | Rust |
| ERE counts | 366.04 | 43.09 | 31.81 | Rust |
| Dense early matching filenames | 11.53 | 7.27 | 2.44 | Rust |
| Small recursive tree, counts | 0.43 | 2.36 | 0.44 | Rust |
| Many tiny files, counts | 2.99 | 5.96 | 2.99 | Rust |
| Medium corpus, counts | 8.38 | 3.66 | 1.41 | Rust |
| Long lines, counts | 3.91 | 4.59 | 2.59 | Rust |
| Long lines, matching lines | 3.99 | 4.52 | 2.57 | Rust |
| Recursive literal matching lines | 81.94 | 8.17 | 6.50 | Rust |
| Recursive ERE matching lines | 136.25 | 8.46 | 6.87 | Rust |
| Include-filtered filename search | 62.82 | 8.39 | 6.67 | Rust |
| Symlink-following filename search | 62.76 | 8.36 | 6.51 | Rust |
| Whole-word match extraction | 0.33 | 0.64 | 0.37 | Rust |
| NUL-delimited records, counts | 0.32 | 0.66 † | 0.36 | Rust |
| Patterns read from a file | 0.35 | 0.61 | 0.38 | Rust |
| Quiet, early exit | 0.34 | 0.72 | 0.40 | Rust |
| Default binary-file reporting | 0.32 | 0.65 † | 0.53 | GNU fallback |
| Non-ASCII pattern, C-locale case folding | 0.34 | 0.64 | 0.37 | Rust |
| Matching lines with context | 0.33 | 0.65 | 0.59 | GNU fallback |

† Direct rg uses different GNU binary diagnostic formatting/channel or a NUL
count terminator where GNU prints LF. Its elapsed time is retained, but that
row is not a compatible-output speed comparison. On parallel searches rg may
also emit the same complete result records in a different order; this is
recorded separately. Rust retains GNU's exact order.

All 26 classes with comparable rg output have a lower Rust-tool median.
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

The previous and current release were both measured with the same process timer,
3 warmups and 21 trials. This isolates the code change from the timer change:

| Workload | Previous Rust ms | Current Rust ms | Improvement |
| --- | ---: | ---: | ---: |
| Recursive literal counts | 12.21 | 6.77 | 1.80× |
| Recursive inverse counts | 12.40 | 6.87 | 1.80× |
| Explicit-file literal counts | 11.94 | 7.56 | 1.58× |
| Dense early matching filenames | 8.59 | 2.44 | 3.52× |
| Recursive literal matching lines | 11.57 | 6.50 | 1.78× |
| Recursive ERE matching lines | 11.97 | 6.87 | 1.74× |

The [archived-release capture](rust-engine-prior-native-performance.json) identifies
the previous qualified executable and its original compiled source hashes.
The [previous Node-timed capture](rust-engine-previous-performance.json) retains
the earlier published results. Its parent-side launch/capture cost is included;
the current timer excludes Node orchestration and interpreter startup and uses
Linux process-exit notifications without polling sleeps. Values from these two
timing methods must not be subtracted to claim a code speedup.

The [raw capture](rust-engine-performance.json) contains every sample, original
arguments, input coverage, output hashes, engine routes and source/executable
identities. The [initial capture](rust-engine-initial-performance.json) retains
the slower first regex implementation for comparison; it does not qualify the
current executable.

## Build, verify and reproduce

Requires Linux, Rust 1.90 or newer and GNU grep for compatibility fallbacks.

```bash
node tools/build-rust.mjs
rust/target/release/grep2rg-rust -arnF 'needle' src
node --test tests/test_rust_engine.mjs
GREP2RG_BENCH_RG=/usr/bin/rg node tools/benchmark-rust-engine.mjs
GREP2RG_BENCH_RG=/usr/bin/rg GREP2RG_BENCH_REPETITIONS=21 GREP2RG_BENCH_WARMUPS=3 \
  node tools/benchmark-rust-engine.mjs --low-overhead-timing
node tools/render-rust-results.mjs
```

The GNU-oracle suite checks actual release output and routes, including all
28 measured classes, seeded byte/regex cases, parallel ordering, raw filename
bytes, stdin, record boundaries, diagnostics and SIGPIPE. Delegating to GNU
earns compatibility coverage but never native Rust search coverage.

`node tools/verify-rust-artifact.mjs` separately extracts the actual npm source
archive, checks Rust source identities and build-output exclusion, rebuilds
that source with locked dependencies, and tests its release CLI from outside
the checkout. CI runs this packaged-source qualification too.

The [packaged qualification](rust-engine-qualification.json) records 1,455 exact
GNU comparisons: 1,411 suite cases, including 904 native Rust searches and 507
GNU fallbacks, plus 12 packaged CLI checks and 32 default CLI/private-function integration comparisons. The rebuilt package executable has
the same SHA-256 as the release used for this timing capture.
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
The full-class timing fixture uses `LC_ALL=C`; it does not establish native
performance in every locale. `--help` and `--version` retain GNU's responses.

Set `GREP2RG_ENGINE_REPORT=/absolute/report.json` for a separate diagnostic
invocation. It reports the engine, strategy, fallback reason, workers and input
size. Leave it unset for performance measurements. `GREP2RG_ACCELERATION=gnu`
explicitly chooses GNU.

The CLI and provider-scoped Pi Bash function prefer this host-local Rust build.
The historical C dispatcher remains a fallback when Rust is unavailable and
can be selected explicitly with `GREP2RG_ENGINE=c`. User shells and child
scripts retain GNU. A measured loss or GNU fallback remains visible.
