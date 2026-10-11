# grep2rg

**GNU grep compatibility with a ripgrep execution path.**

grep2rg runs qualified GNU `grep` commands through `rg` and preserves GNU's output and exit status. Commands that need GNU-specific behavior go directly to GNU grep. It is useful when an agent keeps issuing shell `grep` commands and you want eligible repository searches to use ripgrep automatically.

The package provides a direct CLI, an optional Bash function, and an optional Pi extension. Its core works with any harness that can run a shell command. The Pi extension enables the wrapper for the `qwen-r9700` provider by default; the core has no model or backend dependency.

## Requirements

- Linux with **Node.js 24 or newer**, **GNU grep**, **ripgrep with PCRE2 support**, **Bash**, and **GNU coreutils `readlink`**.
- Python 3 for the verification suite's terminal tests.
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

Alternatively, link the two executables directly from the checkout:

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$(pwd)/bin/grep2rg" "$HOME/.local/bin/grep2rg"
ln -s "$(pwd)/bin/grep2rg-shell-prefix.mjs" "$HOME/.local/bin/grep2rg-shell-prefix"
```

The symlinks continue using the checkout. Keep the checkout at the same location, or recreate the links after moving it.

## Direct CLI

Pass the original GNU grep arguments:

```bash
grep2rg -arnF 'needle' src
grep2rg -lF 'needle' conversations/*.txt
grep2rg -l -i 'emma' conversations/*.txt
grep2rg -n -C 3 --include='*.ts' 'registerTool' .
printf 'one\ntwo\n' | grep2rg -n 'two'
```

`-a` explicitly treats input as text, allowing qualified text searches to use ripgrep; default binary reporting and case-insensitive matching in UTF-8 locales frequently remain on GNU grep. Literal filename searches such as `grep2rg -lF 'needle' files...` can qualify for ripgrep without `-a`, while the other examples demonstrate GNU compatibility rather than guaranteeing acceleration.

`grep2rg --help` and `grep2rg --version` return GNU grep's help and version. The direct CLI accepts GNU arguments rather than introducing another option language.

Exit status follows grep: `0` when a line is selected, `1` when none is selected, and `2` for an error. GNU's exceptions, including quiet-mode handling of errors, remain part of the compatibility contract.

## Opt in inside Bash

Load the private function into the current Bash session:

```bash
eval "$(grep2rg-shell-prefix)"
grep -arnF 'needle' src
```

`grep2rg-shell-prefix` takes no arguments. It prints a Bash definition; it does not execute a search. The definition pins the current Node executable and wrapper location.

Only calls to the `grep` function in that shell use the adapter. The function is not exported to child shells, and subprocesses continue resolving the system executable normally. These calls explicitly bypass it:

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

The extension keeps Pi's native `bash` tool and its existing interface. It adds the private function to eligible model-issued Bash calls. User `!` commands remain ordinary user shell commands.

The default provider allowlist contains only `qwen-r9700`. To replace it, set a comma-separated list of exact provider names before starting Pi:

```bash
export GREP2RG_PI_PROVIDERS='qwen-r9700,my-local-provider'
pi -e /path/to/grep2rg/pi/grep2rg.ts
```

An empty value enables no providers. Other providers require explicit opt-in. See [compatibility and scope](docs/compatibility.md) for the boundary.

## How execution works

1. The direct CLI, Bash function, or Pi adapter passes the original grep arguments to the runtime.
2. The parser resolves GNU options, patterns and matching rules. File discovery retains GNU traversal and filtering behavior.
3. The runtime chooses the qualified ripgrep path or GNU fallback before search output is emitted. Unsupported GNU semantics preserve the original arguments through fallback.
4. Ripgrep JSON events are formatted into GNU-compatible records, prefixes, context groups, counts and exit status.

The public CLI and Bash function preserve non-ASCII argument bytes by sending those calls directly to GNU before Node can decode their arguments. The public CLI uses `readlink` to find its installed location through symlinks. Compatibility choices cover differences in locales, POSIX matching, binary input, record delimiters and early exits. GNU remains a required runtime dependency.

## Verification

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

The packed standalone deep run passed **170 Node tests** with no failures or skips, including the optional Pi SDK checks. Its **30,796 generated campaign cases** comprise 18,796 full wrapper CLI comparisons, 4,782 independently qualified matcher comparisons, and 7,218 native-routing/GNU-oracle cases, with zero observed mismatches in the checked paths. See [the qualification record](docs/qualification.json) and [verification details](docs/verification.md) for engine versions, artifact identity and the tested limits.

These are bounded compatibility tests. They do not prove every possible argument sequence, regex, input file, locale or platform. Ripgrep is also not universally faster: fallback, file discovery, process startup and formatting have costs. See [verification](docs/verification.md) for the tested scope and evidence.

## Project structure

```text
grep2rg/
├── bin/
│   ├── grep2rg                     Public Bash CLI; preserves argument bytes before Node
│   ├── grep2rg.mjs                 Internal Node dispatcher; stdout/stderr/status from the runtime
│   └── grep2rg-shell-prefix.mjs    Emits the private Bash function to stdout
├── src/
│   ├── grep-options.mjs           GNU option parsing and matcher qualification
│   ├── grep-files.mjs             GNU file discovery, filtering and input metadata
│   ├── grep-output.mjs            Ripgrep JSON → GNU-formatted output records
│   ├── grep-runtime.mjs           Search execution, fallback, streams and process cleanup
│   └── grep-wrapper.mjs           Public wrapper helpers and Bash scope construction
├── pi/
│   └── grep2rg.ts                 Optional provider-scoped native Pi bash integration
├── tests/
│   ├── grep_option_inventory.json Independent GNU spellings, values and lexical cases
│   ├── grep_wrapper_requirements.json Behavior and regression inventory
│   ├── port_source_manifest.json  Source identity for the extracted tests
│   └── test_*.mjs                 Synthetic GNU comparisons and integration checks
├── tools/
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
