// GNU grep is the compatibility boundary; rg executes qualified searches.
// Selection happens before consuming stdin or publishing any result. Unknown
// options and irreducible semantics go to GNU unchanged, without an LLM retry.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { isUtf8 } from "node:buffer";
import { delimiter, join } from "node:path";
import { parseGrepOptions, resolveGrepPatterns, buildGrepMatcherArgs, grepMatcherFallbackReasons } from "./grep-options.mjs";
import { enumerateInputs, loadGrepFilters, requiresNativeGrepFileSelection } from "./grep-files.mjs";
import { createGrepFormatter } from "./grep-output.mjs";

const PATTERN_LIMIT = 1024 * 1024;
const INPUT_LIMIT = 100000;
const INPUT_BYTE_LIMIT = 16 * 1024 * 1024;
const ARG_LIMIT = 48 * 1024;
const argumentBytes = (args) => args.reduce((bytes, value) => bytes + Buffer.byteLength(value) + 1, 0);
const literalBasic = (pattern) => !/[.*^$[\\]/.test(pattern);
const literalExtended = (pattern) => !/[.*^$[\\+?(){}|]/.test(pattern);
const nativePlan = (argv, reason) => ({ backend: "grep", args: argv, reason });

function rgAvailable() {
  return (process.env.PATH ?? "").split(delimiter).some((directory) => {
    try {
      const path = join(directory || ".", "rg");
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch { return false; }
  });
}

function matcherReasons(options, patterns, env = process.env) {
  const normalized = { ...options, patternSources: patterns.map((value) => ({ type: "regexp", value })) };
  if (normalized.color === "auto" && process.stdout.isTTY && env.TERM !== "dumb") normalized.color = "always";
  const reasons = grepMatcherFallbackReasons(normalized, { env });
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "C";
  const safeAsciiFold = /^(?:C|en(?:_[A-Z]{2})?)[.-]UTF-?8$/i.test(locale) &&
    patterns.every((pattern) => /^[\x00-\x7f]*$/.test(pattern) && !/[ik]/i.test(pattern));
  return safeAsciiFold ? reasons.filter((reason) => !reason.startsWith("GNU locale case folding")) : reasons;
}

/** Pure routing for argv; file pattern contents are resolved by runGrep. */
export function planGrep(argv, { env = process.env, stat = statSync } = {}) {
  const options = parseGrepOptions(argv, { env });
  if (options.errors.length || options.help || options.version)
    return nativePlan(argv, "GNU option diagnostics, help or version");
  if (options.binaryMode || process.platform === "win32") return nativePlan(argv, "platform-specific GNU byte handling");
  if (options.maxCount === 0) return nativePlan(argv, "GNU zero-count validation and output");
  // rg's inverse NUL-record search can read past -m's trailing-context limit.
  // Ordinary LF records and uncapped fixed NUL searches remain qualified.
  if (options.nullData && options.invertMatch && options.maxCount !== null && options.afterContext > 0)
    return nativePlan(argv, "GNU inverse NUL-record max-count context boundary");
  const stdin = options.paths.includes("-") || (!options.paths.length && !options.recursive);
  if (options.patternSources.some((p) => p.type === "file" && p.value === "-"))
    return nativePlan(argv, "stdin pattern file must preserve GNU stream ownership");
  if (stdin && (options.maxCount !== null || options.quiet || options.filesMode))
    return nativePlan(argv, "early exits must preserve GNU's stdin position");
  if (options.binary === "without-match") return nativePlan(argv, "GNU binary-file exclusion");
  // Default binary reporting depends on GNU's read buffers, invalid encoding
  // detection, and NUL record semantics. Do not guess from a partial pre-scan.
  if (options.binary !== "text" && !(options.filesMode === "with" && !options.invertMatch && !options.wordRegexp && !options.lineRegexp))
    return nativePlan(argv, "GNU default binary reporting");
  const patterns = options.patternSources.filter((p) => p.type === "regexp").flatMap((p) => p.value.split("\n"));
  if (options.invertMatch && !options.lineRegexp && !options.wordRegexp && patterns.includes(""))
    return nativePlan(argv, "GNU inverted universal-pattern shortcut");
  const reasons = matcherReasons(options, patterns, env);
  if (reasons.length) return nativePlan(argv, reasons.join("; "));
  if (requiresNativeGrepFileSelection(options, { env })) return nativePlan(argv, "locale-specific filename matching");
  let matcher = options.matcher;
  if (patterns.length && ((matcher === "basic" && patterns.every(literalBasic)) ||
      (matcher === "extended" && patterns.every(literalExtended)))) matcher = "fixed";
  // An explicitly listed regular-file filename search needs no presentation
  // adapter. Keep its streams inherited and its short-circuit fast path.
  let direct = options.filesMode === "with" && !options.quiet && options.color !== "always" &&
    !options.filters.length && !options.patternSources.some((p) => p.type === "file") &&
    !stdin && options.paths.length > 0 && matcher === "fixed" && !options.nullData && !options.wordRegexp && !options.lineRegexp;
  for (const path of options.paths) {
    try { if (!stat(path).isFile()) direct = false; } catch { direct = false; }
  }
  const normalized = { ...options, matcher };
  let args = direct ? ["--no-config", "--no-ignore", "--hidden", "--threads", "1", "--color", "never",
    options.binary === "text" ? "--text" : "--binary", "--files-with-matches",
    ...buildGrepMatcherArgs(normalized, patterns, { env }), ...(options.nullNames ? ["--null"] : []),
    ...(options.silent ? ["--no-messages"] : []), "--", ...options.paths] : undefined;
  if (direct && argumentBytes(args) > ARG_LIMIT) { direct = false; args = undefined; }
  return { backend: "rg", mode: direct ? "direct" : "json", args, options, patterns };
}

function runInherited(program, args) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: "inherit" });
    child.once("error", (error) => {
      process.stderr.write(`grep: could not start ${program}: ${error.code ?? "spawn failure"}\n`);
      resolve(2);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGPIPE" ? 141 : 2)));
  });
}

function readablePattern(path) {
  const info = lstatSync(path);
  // Following ordinary symlinks is safe; never open a FIFO for a speculative
  // parser read, and leave large or non-UTF-8 pattern files to GNU unchanged.
  if (!(info.isFile() || (info.isSymbolicLink() && statSync(path).isFile()))) throw new Error("special pattern file");
  if (statSync(path).size > PATTERN_LIMIT) throw new Error("large pattern file");
  const data = readFileSync(path);
  if (!isUtf8(data) || data.includes(0)) throw new Error("byte-oriented pattern file");
  return data;
}

async function prepare(plan, argv) {
  const options = plan.options;
  let patterns, filters;
  try {
    patterns = await resolveGrepPatterns(options, readablePattern);
    // Exclusion files are checked before the traversal helper reads them.
    for (const path of options.excludeFiles) readablePattern(path);
    filters = await loadGrepFilters(options);
  } catch { return nativePlan(argv, "GNU pattern/exclusion file handling"); }
  if (!patterns.length) return nativePlan(argv, "GNU empty pattern-file shortcuts");
  if (options.invertMatch && !options.lineRegexp && !options.wordRegexp && patterns.includes(""))
    return nativePlan(argv, "GNU inverted universal-pattern shortcut");
  const reasons = matcherReasons(options, patterns);
  if (reasons.length || requiresNativeGrepFileSelection({ ...options, filters }))
    return nativePlan(argv, reasons.join("; ") || "locale-specific filename matching");
  let matcher = options.matcher;
  if (patterns.length && ((matcher === "basic" && patterns.every(literalBasic)) ||
      (matcher === "extended" && patterns.every(literalExtended)))) matcher = "fixed";
  if (options.binary !== "text" && matcher !== "fixed") return nativePlan(argv, "GNU binary regex record boundaries");
  const effective = { ...options, matcher, filters, excludeFiles: [] };
  let matchingArgs;
  try { matchingArgs = buildGrepMatcherArgs(effective, patterns); }
  catch { return nativePlan(argv, "GNU matcher diagnostics"); }
  // A small -f operand can expand into thousands of argv entries. Fall back
  // before touching input rather than risking E2BIG in the translated search.
  if (argumentBytes(matchingArgs) > ARG_LIMIT) return nativePlan(argv, "GNU large pattern-file handling");
  // Compile before walking files or consuming stdin; GNU remains responsible
  // for exact regex diagnostics and extensions that PCRE2 cannot compile.
  if (matchingArgs.includes("--pcre2")) {
    const check = spawnSync("rg", ["--no-config", "--text", ...matchingArgs, "--", "-"],
      { input: Buffer.alloc(0), maxBuffer: 1024 * 1024, timeout: 5000 });
    if (check.error || check.status > 1 || check.signal) return nativePlan(argv, "GNU regex compilation or unavailable PCRE2");
  }
  const inputs = [];
  let inputBytes = 0;
  try {
    for await (const input of enumerateInputs(effective)) {
      inputBytes += Buffer.byteLength(input.label ?? "");
      if (input.kind === "native" || input.kind === "error" || input.special || inputs.length >= INPUT_LIMIT || inputBytes > INPUT_BYTE_LIMIT)
        return nativePlan(argv, "GNU special files, byte filenames or large traversal");
      inputs.push(input);
    }
  } catch { return nativePlan(argv, "GNU filesystem diagnostics"); }
  return { options: effective, inputs, matchingArgs };
}

function chunks(inputs) {
  const batches = [];
  let batch = [], bytes = 0, labels = new Set();
  const flush = () => { if (batch.length) batches.push(batch); batch = []; bytes = 0; labels = new Set(); };
  for (const input of inputs) {
    if (input.kind !== "file" || bytes + Buffer.byteLength(input.label) > ARG_LIMIT || labels.has(input.label)) flush();
    if (input.kind !== "file") batches.push([input]);
    else { batch.push(input); bytes += Buffer.byteLength(input.label) + 1; labels.add(input.label); }
  }
  flush();
  return batches;
}

async function searchBatch(batch, args, formatter, options, state) {
  for (const input of batch) formatter.registerFile(input.stdin ? "<stdin>" : input.label,
    { size: input.size, stdin: input.stdin, filenameRequired: input.filenameRequired });
  const operands = batch.map((input) => input.stdin ? "-" : input.label);
  // stdin uses the original fd, not Node buffering; multiple '-' operands must
  // share the same consumed descriptor. Reading here never changes the source.
  const child = spawn("rg", [...args, "--", ...operands], { stdio: ["inherit", "pipe", "pipe"] });
  state.child = child;
  let pending = "", diagnostic = "", stopped = false;
  const status = await new Promise((resolve) => {
    const consume = (record) => {
      if (stopped || state.brokenPipe || !record) return;
      try {
        formatter.event(JSON.parse(record));
        if (options.quiet && formatter.selected) { stopped = true; child.kill("SIGTERM"); }
      } catch {
        stopped = true; state.protocolError = true; child.kill("SIGTERM");
        if (!options.silent) process.stderr.write("grep: invalid search response from rg\n");
      }
    };
    child.once("error", (error) => { diagnostic = `grep: rg: ${error.code ?? "spawn failure"}\n`; resolve(2); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      pending += data;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const record = pending.slice(0, newline); pending = pending.slice(newline + 1);
        consume(record);
      }
    });
    child.stderr.on("data", (data) => { diagnostic += data; if (diagnostic.length > 65536) diagnostic = diagnostic.slice(0, 65536); });
    child.once("close", (code, signal) => {
      // JSONL may omit the final newline. A complete final event must still be
      // consumed; a truncated one is an error rather than a zero-match result.
      consume(pending);
      resolve(stopped && options.quiet && formatter.selected ? 0 : code ?? (signal === "SIGPIPE" ? 141 : 2));
    });
  });
  state.child = null;
  if (diagnostic && !options.silent) process.stderr.write(diagnostic);
  if ((status > 1 || state.protocolError) && !(options.quiet && formatter.selected)) {
    state.searchError = true;
    // A failed batch must not invent counts or nonmatching filenames for files
    // rg could not read. Its own diagnostic supplies the failing operation.
    for (const input of batch) formatter.markError(input.stdin ? "<stdin>" : input.label);
  }
  for (const input of batch) formatter.finishFile(input.stdin ? "<stdin>" : input.label);
}

export async function runGrep(argv) {
  const plan = planGrep(argv);
  if (plan.backend === "grep" || !rgAvailable()) return runInherited("grep", argv);
  if (plan.mode === "direct") return runInherited("rg", plan.args);
  const prepared = await prepare(plan, argv);
  if (prepared.backend === "grep") return runInherited("grep", argv);
  const { options, inputs, matchingArgs } = prepared;
  const state = { child: null, searchError: false, protocolError: false, brokenPipe: false, waitingDrain: false };
  const pipeError = (error) => {
    if (error.code !== "EPIPE") throw error;
    state.brokenPipe = true; state.child?.kill("SIGTERM");
  };
  const write = (data) => {
    if (state.brokenPipe) return;
    if (!process.stdout.write(data) && state.child && !state.waitingDrain) {
      const child = state.child;
      state.waitingDrain = true;
      child.stdout.pause();
      process.stdout.once("drain", () => { state.waitingDrain = false; child.stdout.resume(); });
    }
  };
  process.stdout.on("error", pipeError);
  const formatter = createGrepFormatter(options, { stdout: write, tty: Boolean(process.stdout.isTTY) });
  const args = ["--no-config", "--no-ignore", "--hidden", "--threads", "1", "--json", "--color", "never", "--text", ...matchingArgs];
  if (options.filesMode || options.quiet) args.push("--max-count", "1");
  else if (options.maxCount !== null) args.push("--max-count", String(options.maxCount));
  if (!options.filesMode && !options.count && !options.quiet) {
    if (options.beforeContext) args.push("--before-context", String(options.beforeContext));
    if (options.afterContext) args.push("--after-context", String(options.afterContext));
  }
  try {
    for (const batch of chunks(inputs)) {
      if (state.brokenPipe || (options.quiet && formatter.selected)) break;
      await searchBatch(batch, args, formatter, options, state);
    }
    const result = formatter.finish();
    if (state.brokenPipe) return 141;
    if (options.quiet && result.selected) return 0;
    return state.searchError || state.protocolError ? 2 : result.status;
  } finally {
    // Leave the handler active until pending output callbacks have completed;
    // a short pipeline consumer may close after the final search event.
    await new Promise((resolve) => process.stdout.write(Buffer.alloc(0), resolve));
    process.stdout.removeListener("error", pipeError);
    if (state.brokenPipe) return 141;
  }
}
