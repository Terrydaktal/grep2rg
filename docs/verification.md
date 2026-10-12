The native Rust implementation is tested in Rust: `rust/src/tests.rs` contains
unit/property checks, and `rust/tests/gnu_oracle.rs` owns optimized-release
GNU comparisons, seeded cases and fault injection. Run `npm run test:rust` for
both native layers and `npm run test:integration` for Node CLI/Pi scope checks.
Node also retains the experimental JavaScript/C adapter suites because those tests
target JavaScript and C implementations, rather than the native Rust engine.

The current [native package qualification](rust-engine-qualification.json)
rebuilds the actual npm source archive offline outside the checkout. It runs Rust
units in debug and release, then the Rust GNU campaign once against a separate
uninstrumented production binary, followed by Node integration, process-timer
and evidence-validation checks. Counts, native/delegated routes and artifact
hashes are recorded separately. Run `npm run verify:rust` for this release gate.

The broader semantic verifier explicitly enables `GREP2RG_EXPERIMENTAL_RG=1`. The historical C suite explicitly selects `GREP2RG_ENGINE=c`; its counts are C compatibility evidence, not Rust route coverage. None of these finite checks proves a universal speedup.

# Verification

The test oracle is GNU grep. Tests execute the public CLI and compare byte
output, stderr and exit status using owned temporary files. They do not read
private transcripts or require model requests.

## Run order

1. Install Rust 1.90+, Cargo, a C compiler, Node 24+, GNU grep, PCRE2-enabled ripgrep, Bash, GNU coreutils
   `readlink`, Python 3, npm and tar. Locale regressions also require glibc
   `localedef`, UTF-8 charmaps and `en_GB`, `tr_TR` and `cs_CZ` definitions;
   Debian/Ubuntu provides these in `locales`.
2. Build `node tools/build-rust.mjs` and run `node tools/verify-rust-artifact.mjs`, then `node tools/verify.mjs --core` for focused CPU, launcher and package checks.
3. Run `node tools/verify.mjs` for the bounded default campaigns.
4. Run `node tools/verify.mjs --deep` for the larger campaigns before a release.
5. Add `--sdk` when qualifying an installed Pi integration. Set
   `GREP2RG_TEST_PI_ROOT` to the installed `node_modules/@earendil-works`
   directory.
6. Before release, run `node tools/verify-artifact.mjs --deep` to create a real
   npm tarball, extract it and execute the packaged verifier. Add `--sdk` for
   the optional Pi integration and `--output artifacts/package-deep.json`
   to retain the artifact identity and results.

Use `--output artifacts/report.json` to retain the verifier's structured
evidence. The runner's `--help` lists the complete command contract.

## What the campaigns establish

| Campaign | Scope |
| --- | --- |
| Automatic native routing | Large counts/filenames/text, every inventoried option, traversal ordering, descriptor aliases, malformed rg output, buffer-limit fallback and actual packaged helper builds |
| Matcher | Independently generated GNU regex cases and supported matcher routes |
| Output matrix | Varied LF/NUL records, prefixes, counts, contexts, colors, inversion and early exits |
| Traversal | Synthetic directory layouts, filters, links, operand order and input boundaries |
| Option interactions | Every ordered pair of declared spelling representatives, finite boolean subsets, lexical cases and valued boundaries |
| Ordinary text preflight | Actual rg execution without `-a`; complete-file NUL/encoding checks, streaming reads, descriptor cleanup and raw working directories |

The option inventory is checked against the installed GNU help text. The
interaction campaign includes both orders and repeated options within its
declared representative set. This is not an enumeration of all possible
argument lengths or values.

Focused regressions also cover minimized defects, missing engines, output
pipe closure, errors, non-ASCII Bash arguments, process cleanup and local
shell scope. The package gate checks a packed artifact rather than crediting
only a source checkout. The SDK tier verifies the optional native Pi tool
boundary against a real installed SDK.

## Read the evidence

Reports distinguish Node test groups, generated cases and actual comparisons.
A test group can contain thousands of checks. Read each count alongside its
verification method: a matcher comparison or routing check has different scope
from a full wrapper CLI comparison, and TAP group counts do not count inputs.

Reports include engine versions, source hashes, campaign diagnostics, bounded
logs and failure status. Routing-plan counts describe the qualification
decision; dedicated executable-recorder checks verify actual rg execution.
Cross-group duplicate cases receive no second execution or coverage credit
where campaigns report distinct comparisons.

A qualifying run must pass without unexpected skips, truncated evidence,
timeouts or source changes during capture. Keep failed-run evidence and
minimized regressions when repairing a defect.

## Earlier expanded acceleration qualification

The complete-text preflight is qualified through the actual extracted npm
archive, including its public launcher, offline installed executable and Pi
SDK scope. Its focused executable-recorder checks include **38 ordinary text
commands and 9 pattern/traversal cases** that must execute rg without `-a`.
Separate GNU comparisons cover binary input, invalid UTF-8, BOM/chunk boundaries,
stdin ownership and the aggregate byte/file bounds.

The raw working-directory regression reproduces an invalid-byte directory
beside a replacement-character sibling. Classification must not inspect the
sibling and then let rg read a different original directory. The public CLI,
internal dispatcher and private Bash function must all preserve native output.
A deliberately disabled guard fails that regression; the clean guard passes.

The [expanded qualification record](expanded-qualification.json) identifies
the exact tested archive, engine versions and unchanged source/test hashes.
The existing 30,796-case deep campaign retains the verification distinctions
below; new focused checks do not inflate that generated-case count. Replaying
a corpus in another environment provides compatibility evidence, not additional
unique cases. This earlier capture predates the removal of the payload/file
classification caps, Unicode calibration, POSIX span resolution and caller-FD
repair. It does not qualify those later changes. Text preflight deliberately
reads complete files;
this qualification establishes compatibility and actual engine use, not a
universal speedup.

## Broader execution coverage

The [historical adapter qualification](broader-qualification.json) passed on
11 October 2026 with **226 Node test groups per environment**: 195 core,
24 campaign and 7 installed-Pi scope groups. The desktop and Debian VM tested
the same immutable archive; all current implementation and test hashes match
that capture. Neither run accepted failures, skips or changed sources.

The generated corpus has **30,745 cases**: 18,745 full wrapper CLI comparisons,
5,840 independently qualified matcher comparisons and 6,160 native-routing/GNU
oracle cases. Of the qualified matcher cases, 359 additionally exercise JSON
formatting. The older 30,796 aggregate included 51 named presentation checks;
new minimized regressions are recorded separately and do not increase the
generated-case count. Counts from plans, actual searches, GNU helpers and
native passthrough remain separate in the capture.

The newer checks separately cover streaming classification beyond the earlier
payload/file limits, fixed-string leftmost-longest spans, candidate-only GNU
POSIX span extraction, NUL-record anchors and context limits, GNU-derived
Unicode case/class matching, and inherited auxiliary descriptors.
Terminal auto-color, custom-locale replacement in a long-lived API caller,
paused-output backpressure and cancellation have dedicated reproductions.
The latest additions cover fixed `-F -w -x -o`, Linux `-U`/`--binary`, and
117 completed seekable-stdin comparisons (104 actual rg searches, 13 native
controls), plus one blocked-feed cancellation fault. The stdin comparisons
check the shared cursor and unread tail, including trailing context, NUL records
and the real private Bash entry point. These named checks do not increase the
30,745 unique generated-case count.

GNU comparisons require byte-identical stdout, stderr and status. Engine
recorders distinguish actual rg searches, GNU compile/calibration probes,
candidate-only span evaluation and original-argv GNU fallback. A proposed rg
plan or a discarded rg call is not credited as accelerated execution. Cache
tests use private disposable directories; descriptor tests exercise both public
executables and the private Bash function against independent GNU commands.

Option inventories cover representative spellings and interactions rather than
claiming an exhaustive proof over every regex, locale, byte stream or filesystem
race. GNU-only routes remain explicit and are not counted as rg acceleration.

## Original standalone qualification

The standalone deep suite passed from an extracted npm package on
**11 October 2026**. Its [qualification record](qualification.json) contains
the captured artifact identity, source hashes, versions and campaign evidence.

| Campaign | Generated cases | Verification performed |
| --- | ---: | --- |
| Matcher | 12,000 | 4,782 qualified matcher comparisons; 7,218 native-routing/GNU-oracle cases |
| Output matrix and presentation regressions | 4,147 | Full wrapper CLI compared with GNU |
| Traversal and filesystem boundaries | 1,788 | Full wrapper CLI compared with GNU |
| Option interactions | 12,861 | Full wrapper CLI compared with GNU |
| **Campaign total** | **30,796** | **Zero observed mismatches in the checked paths** |

The last three campaigns supply **18,796 full wrapper CLI comparisons**.
The matcher campaign independently compares qualified rg matching with GNU;
359 of its 4,782 qualified cases also check the JSON formatter. Its 7,218
native-routing cases check the GNU oracle, routing decision and argument
boundary rather than executing another wrapper subprocess. The 30,796 total
therefore describes generated cases, not full wrapper CLI comparisons.

The run also passed **142 core, 22 campaign and 6 installed-SDK Node tests**,
for **170 tests**, with no failures or skips. Another 96 matcher metamorphic
checks are excluded from the generated-case total. Core/package checks add
separate comparisons; the total is not a count of every assertion in the suite.

The captured environment used **Node 26.4.0**, **GNU grep 3.12-modified** and
**ripgrep 15.1.0** with PCRE2. The optional integration was checked against
**Pi SDK 0.84.2**, recording seven actual rg invocations and zero network or
model-inference requests. The artifact gate verifies extracted bytes and tests
the real executable both from the extracted package and an offline npm install.

The same tarball also passed **142 core and 6 installed-SDK tests** in the
Pi-opsec Linux VM, using **Node 24.21.0**, **GNU grep 3.11** and **ripgrep
14.1.1**. That run repeated the CLI, raw-byte argument, extracted/offline-installed
package and Pi scope checks; it did not repeat the deep generated campaigns.
The checked implementation and test hashes matched the desktop capture.

Full CLI comparisons include qualified ripgrep routes and native GNU fallback
routes. Passing a native fallback CLI case confirms compatibility, not ripgrep
acceleration; routing-only cases establish the narrower boundary stated above.
These results cover the declared generated cases and focused regressions on
the recorded engines. They do not establish equivalence for every possible
regex, argument sequence, input, locale, platform or dependency version, and
they are not a speed benchmark. Requalify after changing code or engines.

The [extraction manifest](extraction-provenance.json) records the original
Coherence source; the table above records the independently rerun standalone
package rather than carrying forward its earlier test results.
