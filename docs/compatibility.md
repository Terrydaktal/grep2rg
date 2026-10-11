# Compatibility and scope

grep2rg provides GNU-compatible command handling through qualified ripgrep
execution and GNU fallback. GNU grep must remain installed: it is the engine
for combinations where ripgrep or the adapter cannot preserve the required
behavior.

## Arguments and output

The CLI receives original GNU arguments, including short and long options,
patterns, pattern files, operands and `--`. Help and version are GNU's own
informational output. The adapter preserves selected-line status as well as
displayed output; those differ for options such as `-L`, `-v -o` and quiet mode.

Qualified output handling includes raw record bytes, numeric prefixes,
filename delimiters, context groups, counts, missing final terminators and
color capabilities. Inputs and flags are tested against an independently
installed GNU binary. The option inventory records finite representative
spellings and boundary values.

## Fallback

Compatibility qualification happens before search results are emitted.
Fallback retains the original arguments. Reasons include unsupported or
ambiguous GNU option syntax, GNU-specific regex selection and diagnostics,
locale-sensitive cases, binary input rules, stream positioning and special
combinations whose behavior differs between the installed engines.

The public Bash CLI and Bash function route non-ASCII arguments to GNU before Node argument
decoding, preserving arbitrary filename bytes. GNU is also used when rg is
unavailable. Installing grep2rg does not replace GNU or change the global PATH
meaning of `grep`.

GNU behavior can differ across releases. The verifier records the actual
engine versions; a passing result applies to the captured versions, source
and bounded fixture scope.

## Shell and agent boundary

`grep2rg-shell-prefix` defines a Bash function in its caller's shell. The
function is explicitly not exported. `command grep`, absolute executable
paths, child programs and separate shells keep ordinary executable lookup.

The Pi adapter supplies that function to model-issued calls of the native
`bash` tool for an allowed provider. Its default allowlist is `qwen-r9700`.
`GREP2RG_PI_PROVIDERS` replaces that list with comma-separated exact names;
an empty list opts out. User `!` commands and other providers retain their
existing handling.

The standalone core can be used with other harnesses by invoking the direct
CLI or prepending the Bash definition to an eligible model shell command.

## Limits

The assurance suite is finite. It does not establish universal equivalence
for every regex, locale, file type, filesystem race or option sequence.
Unsupported semantics use GNU instead of receiving an approximate rewrite.
Linux is the qualified platform; other platforms need their own verification.

The package makes no universal throughput claim. Whether a command improves
depends on its workload, selected route and the cost of startup, discovery and
formatting. Benchmark representative commands on your own engine versions.
