# grep2rg

**Integrated Rust searches with GNU grep arguments, output and fallback.**

grep2rg performs qualified searches inside its Rust engine, with SIMD-capable literal matching, regex matching, and sequential or parallel execution that preserves GNU operand and traversal ordering. Native searches launch neither Node nor ripgrep. GNU handles unsupported semantics directly before search output. If Rust was not built, the historical C dispatcher or GNU remains available. The broader JavaScript adapter is explicitly selected with `GREP2RG_EXPERIMENTAL_RG=1`.

The package provides a direct CLI, a private Bash function and an optional Pi extension. The Pi extension applies the same automatic route to eligible model-issued shell calls; user shell commands and child scripts retain system grep. The core has no model or backend dependency.

## Requirements

- Normal public execution needs Linux, **GNU grep**, **Bash** and GNU coreutils **`readlink`**.
- Integrated acceleration needs **Rust 1.90 or newer** and Cargo at installation. `npm` builds locked Rust source for the executing host into `rust/target/release/grep2rg-rust`. Native searches need no installed rg executable.
- The historical dispatcher additionally needs **ripgrep** and a C compiler. It remains a fallback when Rust is unavailable, or an explicit route through `GREP2RG_ENGINE=c`. Missing both compiled engines retains GNU without Node.
- Experimental routes and JS helpers additionally need **Node.js 24 or newer**, **ripgrep with PCRE2 support** and **GNU coreutils `readlink`**.
- Python 3 for the verification suite's terminal tests.
- glibc `localedef` and locale definitions for the verification suite's owned locale tests (`locales` on Debian/Ubuntu).
- npm and tar for package verification and npm installation.
- An installed Pi SDK only when using the Pi extension or running `--sdk` verification.

Check your engines before installation:

```bash
node --version
grep --version
rg --version
```

## Install

Clone the package and install it with a user prefix:

```bash
git clone https://github.com/Terrydaktal/grep2rg.git
cd grep2rg
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
```

With npm 12, approve only this local checkout's build hook using
`--allow-scripts="file:$(pwd)"` on the global install, or use the direct build below.
Blocked or unavailable compilation leaves the GNU fallback usable.

Alternatively, build and link the two executables directly from the checkout:

```bash
node tools/build-rust.mjs
mkdir -p "$HOME/.local/bin"
ln -s "$(pwd)/bin/grep2rg" "$HOME/.local/bin/grep2rg"
ln -s "$(pwd)/bin/grep2rg-shell-prefix.mjs" "$HOME/.local/bin/grep2rg-shell-prefix"
```

The symlinks continue using the checkout. Keep the checkout at the same location, or recreate the links after moving it. Build on every machine that executes Pi tools, including a remote Pi VM; compiled binaries are not shipped in the source archive. The helper fixes Cargo’s target directory to the path the launcher uses, even when an inherited `CARGO_TARGET_DIR` differs. `node tools/build-rust.mjs --offline` works with cached locked dependencies. Optional installation without a usable toolchain retains C/GNU, and a failed rebuild removes the stale Rust executable. Use the required build command above when Rust acceleration must be present.

## Direct CLI

Pass the original GNU grep arguments:

```bash
grep2rg -arnF 'needle' src
grep2rg -lF 'needle' conversations/*.txt
grep2rg -l -i 'emma' conversations/*.txt
grep2rg -rn -C 3 --include='*.ts' 'registerTool' .
printf 'one\ntwo\n' | grep2rg -n 'two'
```

With the explicit experiment enabled, ordinary file searches can use ripgrep without adding `-a`. Before matching, the wrapper reads the complete selected regular-file contents in 64 KiB chunks. Classification no longer has a 16 MiB payload or 4,096-file cutoff. NUL-containing files in default binary mode, invalid UTF-8 in UTF-8 locales, default-mode stdin and unclassifiable inputs retain GNU behavior. `-I` can also use rg when every selected file passes the check. These extra reads cost time, so using rg does not guarantee a faster command. Explicit `-a` text searches retain their direct path unless a separate character-set proof is required.

In the experiment, explicit-text `-m` on one qualified regular stdin can stream positional reads to rg, then preserve GNU's shared cursor and unread tail, including with trailing context. It does not copy the full suffix to disk. Pipes, quiet/filename modes and other unqualified stdin remain GNU. Fixed `-w -x -o` uses rg selection plus GNU candidate spans, and Linux `-U` retains its no-op behavior on qualified routes.

`grep2rg --help` and `grep2rg --version` return GNU grep's help and version. The direct CLI accepts GNU arguments rather than introducing another option language.

Exit status follows grep: `0` when a line is selected, `1` when none is selected, and `2` for an error. GNU's exceptions, including quiet-mode handling of errors, remain part of the compatibility contract.

## Use inside Bash

Load the private function into the current Bash session:

```bash
eval "$(grep2rg-shell-prefix)"
grep -arnF 'needle' src
```

`grep2rg-shell-prefix` takes no arguments. It prints a Bash definition; it does not execute a search. The definition pins the Rust executable, historical helper, current Node executable and wrapper location. It checks for the built Rust executable on every call.

Calls to the private `grep` function use the built Rust engine by default. `GREP2RG_ACCELERATION=gnu` explicitly disables acceleration. `GREP2RG_EXPERIMENTAL_RG=1` opts into the complete JavaScript adapter instead. The function is not exported to child shells, and subprocesses continue resolving the system executable normally. These calls explicitly bypass it:

```bash
command grep -n 'needle' file.txt
/usr/bin/grep -n 'needle' file.txt
```

Remove the function with `unset -f grep`, or close the shell. Do not alias or symlink the system `grep` executable to this package.

For another agent harness, prepend the output of `grep2rg-shell-prefix` to its model-issued Bash command. This gives each command the same local scope without changing the user's global shell configuration.

## Pi integration

Load the extension from the installed checkout:

```bash
pi -e /path/to/grep2rg/pi/grep2rg.ts
```

Pi package installation can also load the extension declared in `package.json`:

```bash
pi install /path/to/grep2rg
```

The extension keeps Pi's native `bash` tool and its existing interface. Normal eligible model-issued Bash calls receive the private function and use the built Rust engine. User `!` commands remain ordinary user shell commands.

The default provider allowlist contains only `qwen-r9700`. To replace it, set a comma-separated list of exact provider names before starting Pi:

```bash
export GREP2RG_PI_PROVIDERS='qwen-r9700,my-local-provider'
pi -e /path/to/grep2rg/pi/grep2rg.ts
```

An empty value enables no providers. Other providers require explicit opt-in. See [compatibility and scope](docs/compatibility.md) for the boundary.

## How execution works

1. Normal CLI, private-function and eligible Pi calls select the built Rust engine. Supported literal and regex searches run inside that process; no Node, rg or C dispatcher is started. Small jobs stay sequential; qualified larger jobs use bounded parallel workers and publish results in GNU order.
2. Unsupported syntax, unsafe locale matching, context rendering and GNU binary diagnostics delegate original arguments to GNU before native output. Closed caller input/output descriptors also retain GNU before Rust startup can reopen them. `GREP2RG_ACCELERATION=gnu` goes directly to GNU.
3. If Rust is unavailable, the historical C dispatcher retains its measured rg/GNU routing policy; if neither compiled engine exists, GNU runs directly. `GREP2RG_ENGINE=c` explicitly selects that historical policy for reproducing its captures. The broader JavaScript adapter is a separate opt-in.

The explicit JavaScript experiment has a broader compatibility pipeline:
1. The parser resolves GNU options, patterns and matching rules. File discovery retains GNU traversal and filtering behavior.
2. The runtime chooses the qualified ripgrep path or GNU fallback before search output is emitted. Unsupported GNU semantics preserve the original arguments through fallback.
3. Ripgrep JSON events are formatted into GNU-compatible records, prefixes, context groups, counts and exit status. Where GNU POSIX match spans differ from PCRE2, a GNU helper evaluates only the records selected by rg and supplies their exact spans.

In the experiment, the public CLI and Bash function check argument bytes before Node decodes them. Valid Unicode proceeds to qualification; invalid UTF-8 remains in Bash and goes directly to GNU. Both launch paths preserve inherited caller descriptors, including shell process substitutions. The public CLI uses `readlink` to find its installed location through symlinks. GNU remains a required runtime dependency.

Unicode matching can use explicit character rules derived from installed GNU grep. The wrapper probes every valid Unicode scalar for the requested case closures or character classes, then caches those rules under the GNU binary, locale and libc identity. rg searches the actual input using those rules after valid-UTF-8 classification. This covers ordinary Unicode case-insensitive and word matching, plus bracket expressions under C, POSIX and C.UTF-8 collation. Other collation locales can contain multi-character elements, such as Czech `ch`, so their bracket expressions retain GNU execution. Case-insensitive backreferences also remain native. Initial calibration has a cost and needs about 5.2 MiB for the shared scalar corpus.

The POSIX span helper uses private disk spools rather than retaining the complete result corpus in RAM. It adds work for match-heavy output and never receives the original files. These paths widen compatible rg execution; they are not a promise of universal throughput improvement.

## Integrated Rust search engine

The default `grep2rg-rust` executable performs qualified searches inside one
native process. It uses Rust literal and regex libraries, selects sequential or
parallel execution, and emits results in GNU operand/traversal order. It needs
neither Node nor an rg subprocess for its native search paths. GNU grep handles
unsupported semantics directly; those executions are reported as fallbacks,
not native Rust performance gains.

Build with Rust 1.90 or newer, using the committed dependency lockfile:

```bash
node tools/build-rust.mjs
rust/target/release/grep2rg-rust -arnF 'needle' src
npm run test:rust
npm run test:integration
node tools/verify-rust-artifact.mjs
GREP2RG_BENCH_RG=/usr/bin/rg node tools/benchmark-rust-engine.mjs
GREP2RG_BENCH_RG=/usr/bin/rg GREP2RG_BENCH_REPETITIONS=21 GREP2RG_BENCH_WARMUPS=3 \
  node tools/benchmark-rust-engine.mjs --low-overhead-timing
node tools/render-rust-results.mjs
```

The benchmark compares all 28 existing workload classes against direct GNU grep
and direct rg. It includes process startup and complete output capture, with one
warmup and seven rotated measured repetitions per class by default. Output comparison,
hashing, route reporting and fixture creation happen outside the timer. Rust
must match GNU stdout, stderr, ordering and exit status exactly. The rg
comparison preserves every result record but reports its differing order;
binary diagnostics and NUL-count formatting have explicit incompatibility labels.
The optional low-overhead timing mode uses a persistent Python standard-library
driver whose timer surrounds each child launch and full output capture. Python
startup, JSON transport and Node orchestration are outside that timer. Both modes
retain the same inputs, rotated order and independent GNU comparisons; capture
metadata records the timing boundary so different modes are not conflated.

The current capture uses three warmups and 21 low-overhead trials. Rust has the
lower median in all 26 classes with comparable rg output; the two formatting-
incompatible rows also take less time but do not qualify equivalent-output gains.
The engine uses parallel file preparation, reusable buffers and fewer execution
barriers. The table reports the current Rust release against the GNU/rg baselines.

The extracted npm source archive was rebuilt offline and passed 1,455 exact GNU
comparisons: 1,411 suite cases (904 native Rust searches and 507 GNU fallbacks)
plus 12 packaged CLI checks and 32 Node CLI/private-function integration comparisons. Rust units passed 12 checks in both debug and release. The rebuilt engine has identical code, data and layout to the benchmarked release; its build ID and local symbol metadata differ. See the [controlled build comparison](docs/rust-engine-build-equivalence.json). Eight process-timer and six evidence-validation checks also passed. See the [packaged qualification](docs/rust-engine-qualification.json),
[Rust engine results and scope](docs/rust-engine.md) and
[complete capture](docs/rust-engine-performance.json). The CLI and Pi now select this same built Rust executable. Default-route integration checks additionally qualify real CLI/private-function execution, GNU optout, symlink installs, closed input/output, unavailable builds and unchanged user/child shells. The source archive is rebuilt through the same helper used at installation. The [installed Pi SDK qualification](docs/rust-pi-qualification.json) passed 11 checks, including small and large default Rust calls, exact provider scoping and unchanged user commands, with no network or inference requests.

## Measured Rust search performance

The complete latest qualified capture covers all 28 workload classes. These are direct-executable warm-cache medians in milliseconds on a Ryzen 9 9950X, with three warmups and 21 rotated trials per class. Timings include process startup, matching and complete output capture, and exclude fixture creation, hashing, comparison, route reporting and the benchmark controller. They measure the Rust executable selected by Pi; Bash command startup is outside these direct timings.

All Rust-tool results match GNU stdout, stderr, status and ordering exactly. Twenty-six classes use native Rust and two explicitly fall back to GNU. Seventeen native medians are lower than GNU in this capture. Small differences are not a universal performance guarantee. [The complete capture](docs/rust-engine-performance.json) records all samples and executable/source hashes; [the results page](docs/rust-engine.md) explains the measurement method and current implementation.

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

The earlier C dispatcher’s CLI/private-function measurements remain in [automatic-performance.json](docs/automatic-performance.json). They include different wrapper and benchmark-controller costs and do not describe the default Rust route. Reproduce that historical policy with `GREP2RG_ENGINE=c`; the [historical routing audit](docs/automatic-routing-audit.json) records its qualified classes.

## Verification

Tests follow the implementation boundary:

| Layer | Language and location | Run |
| --- | --- | --- |
| Native parser, matcher, traversal and resource invariants | Rust unit/property tests under `rust/src/` | `npm run test:rust:unit` |
| Actual optimized engine versus GNU, including seeded and fault cases | Rust release harness under `rust/tests/` | `npm run test:rust:oracle` |
| Pi Bash scope and public CLI integration | JavaScript under `tests/` | `npm run test:integration` |
| Retained experimental JavaScript/C adapters | JavaScript under `tests/` | `node tools/verify.mjs --core` |

`npm test` runs the Rust, integration and adapter layers. `npm run test:rust`
runs the native layers without Node test assertions. Plain `cargo test --locked
--manifest-path rust/Cargo.toml` runs the fast Rust unit/property checks; the
`release-oracle` feature explicitly enables the longer GNU comparison campaign.
The external campaign tests the uninstrumented optimized executable, even when
unit tests use a debug build. GNU fallback checks retain separate counts and do
not claim native implementation coverage.

`npm run verify:rust` packs and extracts the actual npm source archive, builds
an independent production release, runs Rust units in debug and release, and
executes the Rust oracle and Node integration tests outside the checkout. Its
report rejects empty/skipped suites, missing classes and mismatched artifact
identities. The GNU campaign runs once per qualification; debug and release
unit results are reported separately rather than adding duplicate GNU cases.

Run the focused CPU and package checks first:

```bash
node tools/verify.mjs --core --output artifacts/core.json
```

Run the default or larger generated campaigns:

```bash
node tools/verify.mjs --output artifacts/default.json
node tools/verify.mjs --deep --output artifacts/deep.json
```

SDK verification is explicit and requires your installed Pi packages:

```bash
GREP2RG_TEST_PI_ROOT=/path/to/node_modules/@earendil-works \
  node tools/verify.mjs --deep --sdk --output artifacts/deep-sdk.json
```

Before a release, verify the actual npm tarball after extraction:

```bash
node tools/verify-artifact.mjs --deep --output artifacts/package-deep.json
```

Add `--sdk` and the same Pi SDK environment variable to qualify that integration from the packed artifact too.

The suite compares actual CLI output, errors and status with GNU grep using disposable synthetic files. It includes regex, record formatting, traversal, every ordered pair of the declared GNU option spellings, bounded boolean subsets, failure handling, shell scope and package checks. Generated-case counts and Node test-group counts are reported separately; repeated cases do not receive duplicate coverage credit. Reports include engine versions and source hashes.

The historical C-dispatcher qualification passed **218 Node test groups**: 210 core checks and eight checks against the installed Pi SDK, with no failures or skips and unchanged implementation source hashes. Its native routing suite made **528 exact GNU comparisons**, including 288 actual ripgrep invocations. The real npm source archive was extracted and installed offline; both targets built the shipped C source and passed the native and entry suites. The **28-class performance capture** separately checked 532 timed stdout/stderr/status comparisons. The [historical qualification record](docs/automatic-qualification.json) records source hashes, the verified archive identity, engine versions and count accounting.

The earlier semantic-adapter qualification tested **226 Node test groups** in each environment: Node 26/GNU grep 3.12/ripgrep 15 locally and Node 24/GNU grep 3.11/ripgrep 14 in the VM. Both tested the same archive, including extracted and offline-installed entry points and actual Pi SDK checks, with no failures or skips. Its **30,745 generated cases** comprise 18,745 full wrapper CLI comparisons, 5,840 independently qualified matcher comparisons and 6,160 native-routing/GNU-oracle cases. Named regressions separately check Unicode calibration, NUL records, GNU match spans and colors, Linux binary-I/O no-op options, caller descriptors, seekable-stdin cursors, output backpressure and cancellation. The [historical qualification record](docs/broader-qualification.json) records the archive identity, source/test hashes, actual engine witnesses and case accounting; it does not qualify the new native dispatcher.

The [earlier expanded qualification](docs/expanded-qualification.json) and [original qualification](docs/qualification.json) remain historical evidence; they do not qualify the later Unicode, span, descriptor and streaming repairs.

These are bounded compatibility tests. They do not prove every possible argument sequence, regex, input file, locale or platform. Ripgrep is also not universally faster: fallback, file discovery, process startup and formatting have costs. See [verification](docs/verification.md) for the tested scope and evidence.

The [coverage map](docs/coverage.json) accounts for all 47 documented semantic option groups, their eligible routes and the remaining native boundaries. It separates actual rg searches from GNU calibration, candidate-only span evaluation and fallback; it is an implementation inventory, not a universal acceleration claim.

## Project structure

```text
grep2rg/
├── bin/
│   ├── grep2rg                     Public Bash CLI; Rust default, C/GNU fallback, guarded Node experiment
│   ├── grep2rg-native              Locally compiled helper; never copied into the npm source archive
│   ├── grep2rg.mjs                 Internal Node dispatcher; stdout/stderr/status from the runtime
│   └── grep2rg-shell-prefix.mjs    Emits the private Bash function to stdout
├── native/
│   └── grep2rg.c                   Bounded native dispatcher and ordered ripgrep result adapter
├── rust/
│   ├── Cargo.toml / Cargo.lock     Integrated engine dependencies and release build profile
│   ├── src/main.rs                In-process adaptive Rust search and guarded GNU fallback
│   ├── src/tests.rs                Native unit/property tests
│   └── tests/gnu_oracle.rs          Release GNU comparisons and owned fault fixtures
├── src/
│   ├── grep-options.mjs           GNU option parsing and matcher qualification
│   ├── grep-files.mjs             GNU file discovery, filtering and input metadata
│   ├── grep-output.mjs            Ripgrep JSON → GNU-formatted output records
│   ├── grep-posix-spans.mjs       Candidate-only GNU span resolution and private spool cleanup
│   ├── grep-unicode.mjs           GNU scalar probes, cached rules and Unicode pattern translation
│   ├── grep-descriptors.mjs       Inherited caller descriptors for GNU and rg children
│   ├── grep-stdin.mjs             Positional stdin feed and completed shared-cursor preservation
│   ├── grep-runtime.mjs           Search execution, fallback, streams and process cleanup
│   └── grep-wrapper.mjs           Public wrapper helpers and Bash scope construction
├── pi/
│   └── grep2rg.ts                 Optional provider-scoped native Pi bash integration
├── tests/
│   ├── grep_option_inventory.json Independent GNU spellings, values and lexical cases
│   ├── grep_wrapper_requirements.json Behavior and regression inventory
│   ├── port_source_manifest.json  Source identity for the extracted tests
│   └── test_*.mjs                 Pi/package and retained JS/C adapter checks
├── tools/
│   ├── build-rust.mjs             Builds locked Rust source into the CLI/Pi target path
│   ├── build-native.mjs           Compiles the historical C helper; optional GNU fallback
│   ├── benchmark-routing.mjs      Paired GNU/CLI/private-function/experimental timing receipts
│   ├── benchmark-rust-engine.mjs  Direct Rust/GNU/rg timing and full-output qualification
│   ├── benchmark-processes.py     Persistent low-overhead child timing with bounded capture
│   ├── rust-benchmark-fixture.mjs Public synthetic inputs for all 28 historical classes
│   ├── render-rust-results.mjs    Generates the comparison table from a qualified capture
│   ├── verify-rust-artifact.mjs   Extracts, rebuilds and tests the shipped Rust source
│   ├── verify.mjs                Tiered verification; optional JSON evidence output
│   └── verify-artifact.mjs       Packs, extracts and verifies the actual npm artifact
├── docs/                         Scope, verification and extraction provenance
├── package.json                  Executable, Node and optional Pi extension metadata
├── LICENSE                       Full Apache License 2.0
└── NOTICE                        Copyright and origin attribution
```

Install the engines and package, then use the CLI or opt into a shell/agent integration. Run verification after changing the package or engines.

## Origin and license

Written by **Terrydaktal**, originally developed and verified in [vllm-coherence](https://github.com/Terrydaktal/vllm-coherence), then extracted into this standalone package. Source provenance is recorded in [the extraction manifest](docs/extraction-provenance.json).

[greprip](https://github.com/kaofelix/greprip) is a related GNU-grep-to-ripgrep wrapper considered during development. No greprip implementation code is included here.

grep2rg's original code is licensed under [Apache 2.0](LICENSE); see [NOTICE](NOTICE). GNU grep, ripgrep and Pi retain their own licenses.
