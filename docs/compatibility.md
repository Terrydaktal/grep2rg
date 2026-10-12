# Routing policy

Normal CLI, private-function and eligible Pi calls prefer the integrated Rust executable at `rust/target/release/grep2rg-rust`. Supported literal/regex operations run inside that process and retain GNU operand/traversal order. They launch neither Node nor rg. Unsupported semantics delegate original argv to GNU before output. The [Rust results and boundary](rust-engine.md) and [packaged qualification](rust-engine-qualification.json) record tested native and fallback coverage separately.

A closed input/output descriptor delegates before Rust initialization can reopen it. The launcher resolves installed symlinks; the private function pins the host-local build location and checks it on every invocation. `GREP2RG_ACCELERATION=gnu` selects GNU directly, with no search translator startup. If Rust is unavailable, the historical C dispatcher then GNU remains available. `GREP2RG_ENGINE=c` selects the historical C route explicitly; its [routing audit](automatic-routing-audit.json) and [paired measurements](automatic-performance.json) remain historical evidence.

`GREP2RG_EXPERIMENTAL_RG=1` selects the broader JavaScript semantic routes below. Finite measurements cannot promise that a specific command is faster under every hardware/cache/input condition.

# Experimental adapter compatibility and scope

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

The public Bash CLI and Bash function check non-ASCII arguments as raw bytes
before Node argument decoding. Valid UTF-8 proceeds to qualification; invalid
UTF-8 goes directly to GNU, preserving arbitrary filename bytes. GNU is also used when rg is
unavailable. Installing grep2rg does not replace GNU or change the global PATH
meaning of `grep`.

GNU behavior can differ across releases. The verifier records the actual
engine versions; a passing result applies to the captured versions, source
and bounded fixture scope.

## Ordinary file searches without `-a`

Default binary-reporting and `-I` searches can use rg after every selected file
passes a complete text preflight. There is no longer a **16 MiB payload**
or **4,096-file** classification cutoff. Reads use **64 KiB chunks** and continue
to the end of every selected file. Separate discovery and argument-size bounds
still apply. C/POSIX accepts non-NUL bytes; UTF-8 locales additionally require valid
complete UTF-8, including sequences split across chunks. Other encodings,
default-mode stdin and failed classification remain GNU. With `-z`, NUL is the
record delimiter and is permitted by classification; embedded newlines remain
inside their records. Explicit text mode and the existing fixed filename direct
path retain their previous behavior.

Files are opened nonblocking, then checked through their descriptors before
reading so an observed replacement with a FIFO does not block the inspection.
Size, device/inode, mode and modification/change times are checked after reading
and against the named path. Any observed inconsistency uses GNU before matching
output. These checks do not make an atomic snapshot between classification and
rg reopening the operands. The extra reads also differ from GNU's syscall,
access-event and atime sequence, especially with early-exit options; the tested
contract is output, diagnostics and status on stable ordinary files.

`planGrep` returns `backend: "rg"` with `requiresTextPreflight: true` for these
candidates. That is a proposed route; `runGrep` performs classification before
choosing actual execution. Tests record actual rg and native invocations rather
than giving a candidate plan acceleration credit.

## GNU match spans and Unicode rules

PCRE2 and POSIX can select different spans from the same matching record. The
adapter can let rg select the records, spool only selected/context events and
candidate record bytes, then ask GNU for those records' exact spans. GNU never
receives the original file operands in this path. Record and file offsets are
reconstructed by the formatter. Private spools are removed after completion or
cancellation; this extra pass can cost more than native GNU on match-heavy input.
Fixed `-w -x -o` also uses this broker: the installed GNU determines whether a
matched record terminator belongs to the span and its color boundary. Linux
`-U`/`--binary` is a GNU no-op and does not block an otherwise qualified rg route.

For supported UTF-8 locales, case closures, word characters and bracket-class
membership come from a GNU probe over every valid Unicode scalar. A separate
probe handles NUL class membership. Cached rules identify the GNU executable,
its version, the effective character and collation locales, libc and locale
data. Custom loader or locale paths disable disk and process-global reuse;
tables may be shared only within the current translation. The corpus and rules
use a user-owned private cache, configurable with `GREP2RG_UNICODE_CACHE`.
No second model or guessed Unicode case table is involved.

These rules cover scalar membership, not arbitrary multi-character collation
or case-insensitive backreference comparison. Unicode bracket expressions
therefore require C, POSIX or C.UTF-8 collation; other collation locales remain
native for those expressions. Actual operands still require a complete
valid-UTF-8 proof before rg uses scalar matching rules.

## Seekable max-count stdin

Explicit text mode with a finite positive `-m` can use rg when the only input is
one regular, readable stdin descriptor. The wrapper reads positionally in
64 KiB chunks into rg's private pipe, without advancing the caller's shared
file position or spooling the suffix. On normal completion it advances the
original descriptor only to GNU's stopping point: after the last selected
record when the count is reached, otherwise EOF. Printed trailing context
does not advance that stopping point. Nonzero starting positions, LF/NUL
records, spans, counts and the unread tail are checked against GNU.

Pipes, repeated or mixed stdin operands, quiet/filename modes, `O_PATH`,
`O_DIRECT`, misleading proc/sysfs file sizes and proof-dependent Unicode
streams remain native. Metadata/position checks detect observed changes;
there is no atomic snapshot or claim of matching interrupted read-ahead timing.
Cancellation stops the private feed and owned child without committing a
completed cursor. The extra reads are not a universal speedup guarantee.

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

Both Bash launch paths snapshot inherited auxiliary descriptors before Node
changes their close-on-exec flags. Child GNU and rg processes retain those
descriptors, including process-substitution inputs. Private bookkeeping does
not occupy a caller-owned descriptor slot.

If a standard descriptor is closed, Bash executes GNU directly before Node can
replace that descriptor with `/dev/null`. Public and private CLI cancellation
waits for owned-child and spool cleanup, then exits even if the output consumer
has stopped reading. Normal completion still drains pending output. The direct
`runGrep` API returns the cancellation status without terminating its caller.

## Limits

The runtime checks the raw working-directory bytes through `/proc/self/cwd`
before parsing or reading files. Invalid UTF-8, a deleted directory or an
unavailable check uses GNU with the original operating-system working directory.
This prevents classification from accidentally reading a replacement-character
sibling while ripgrep searches the real directory.

The assurance suite is finite. It does not establish universal equivalence
for every regex, locale, file type, filesystem race or option sequence.
Unsupported semantics use GNU instead of receiving an approximate rewrite.
Linux is the qualified platform; other platforms need their own verification.

Remaining native routes include unqualified early-exit stdin, `-q`, `-l`, `-L`, stdin
pattern files (`-f -`), binary reporting that fails the text proof, special files,
invalid byte arguments, GNU regex warnings and unsupported Perl/locale behavior.
Zero-search cases such as `-m 0`, informational commands, parser fallbacks and
unresolved platform-specific combinations also execute GNU. They do not
receive rg acceleration credit. Resource boundaries remain: pattern-file size
over 1 MiB, discovery over 100,000 operands or 16 MiB of path labels, and translated
argv over 48 KiB cause native execution; complete ordinary file payloads no
longer have the earlier 16 MiB classification limit.

The package makes no universal throughput claim. Whether a command improves
depends on its workload, selected route and the cost of startup, discovery and
formatting. Benchmark representative commands on your own engine versions.
