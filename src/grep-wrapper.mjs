// A compatibility adapter for model-issued filesystem searches, not a global
// grep replacement. Bash expands quotes/globs before passing argv here.
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const wrapperPath = fileURLToPath(import.meta.url);
import { runGrep } from "./grep-runtime.mjs";
export { planGrep, runGrep } from "./grep-runtime.mjs";

// Non-exported function: child build scripts, user shell commands and system
// grep remain untouched. No textual parsing/replacement of the command itself.
export function withGrepWrapper(context, shellPath) {
  if (shellPath && !/^bash(?:\.exe)?$/.test(basename(shellPath))) return context;
  // A Node argv string cannot preserve an invalid UTF-8 byte. Check argv in
  // Bash's byte locale first; native grep receives those arguments untouched.
  // The locale change stays in one subshell and never reaches either backend.
  const prefix = `if [ -n "\${BASH_VERSION-}" ]; then
\tgrep() {
\t\tif ! (
\t\t\tLC_ALL=C
\t\t\t_grep2rg_nonascii=$'[^\\001-\\177]'
\t\t\tfor _grep2rg_arg; do
\t\t\t\tif [[ $_grep2rg_arg =~ $_grep2rg_nonascii ]]; then exit 1; fi
\t\t\tdone
\t\t); then
\t\t\tcommand grep "$@"
\t\t\treturn
\t\tfi
\t\tcommand ${quote(process.execPath)} ${quote(wrapperPath)} "$@"
\t}

\texport -n -f grep
fi
`;

  return { ...context, command: prefix + context.command };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runGrep(process.argv.slice(2));
}
