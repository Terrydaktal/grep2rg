# Verification

The test oracle is GNU grep. Tests execute the public CLI and compare byte
output, stderr and exit status using owned temporary files. They do not read
private transcripts or require model requests.

## Run order

1. Install Node 24+, GNU grep, PCRE2-enabled ripgrep, Bash, GNU coreutils
   `readlink`, Python 3, npm and tar.
2. Run `node tools/verify.mjs --core` for focused CPU, launcher and package checks.
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
| Matcher | Independently generated GNU regex cases and supported matcher routes |
| Output matrix | Varied LF/NUL records, prefixes, counts, contexts, colors, inversion and early exits |
| Traversal | Synthetic directory layouts, filters, links, operand order and input boundaries |
| Option interactions | Every ordered pair of declared spelling representatives, finite boolean subsets, lexical cases and valued boundaries |

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

## Standalone qualification

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
