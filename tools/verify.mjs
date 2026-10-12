#!/usr/bin/env node
// Reproducible CPU verification; all tests own disposable synthetic fixtures.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_LOG = 4 * 1024 * 1024;
const MAX_STAGE_TIME = 10 * 60 * 1000;
const CORE = ["test_grep_auto_native.mjs", "test_grep_options.mjs", "test_grep_files.mjs", "test_grep_output.mjs", "test_grep_full_cli.mjs", "test_grep_wrapper.mjs", "test_grep_runtime_faults.mjs", "test_grep_text_preflight.mjs", "test_grep_seekable_stdin.mjs", "test_grep_extended_coverage.mjs", "test_grep_extended_backpressure.mjs", "test_grep_unicode.mjs", "test_grep_descriptors.mjs", "test_grep_routing_policy.mjs", "test_grep_scope.mjs", "test_package_entry.mjs", "test_package_artifact.mjs"];
const CAMPAIGNS = ["test_grep_matcher_campaign.mjs", "test_grep_matrix_campaign.mjs", "test_grep_traversal_campaign.mjs", "test_grep_option_interactions.mjs"];
const IMPLEMENTATION = ["options", "files", "output", "posix-spans", "unicode", "descriptors", "stdin", "runtime", "wrapper"].map((file) => `src/grep-${file}.mjs`).concat(["package.json", "bin/grep2rg", "bin/grep2rg.mjs", "bin/grep2rg-shell-prefix.mjs", "pi/grep2rg.ts", "native/grep2rg.c", "tools/build-native.mjs", "docs/automatic-routing-audit.json"]);
const HELP = `NAME
  verify.mjs — verify the standalone GNU-compatible grep adapter

SYNOPSIS
  node tools/verify.mjs [--core | --deep] [--sdk] [--output FILE]
  node tools/verify.mjs --help

DESCRIPTION
  Run independent GNU comparisons and regression checks on synthetic fixtures.
  The default tier includes the four generated campaigns. --core omits them;
  --deep selects their larger bounded campaigns. Counts come from actual results.

OPTIONS
  --core         Run focused CPU regressions, launcher and actual packed artifact checks.
  --deep         Run core checks and the larger generated campaigns.
  --sdk          Also require and verify the installed Pi native Bash integration.
  --output FILE  Save bounded logs, diagnostics, versions and source hashes as JSON.
  --help, -h     Print this text without running checks.

OPERATION
  Run test files sequentially with a ten-minute deadline per stage. Selected
  skips, empty runs, changed sources, truncated logs and failures return nonzero.
  The verifier stops after the first failed stage and retains its evidence.

EXAMPLES
  node tools/verify.mjs --core
  node tools/verify.mjs --output artifacts/grep-verification.json
  node tools/verify.mjs --deep --sdk --output artifacts/grep-deep.json

FILES
  tests/grep_wrapper_requirements.json  Behavior inventory.
  tests/grep_option_inventory.json     Independent GNU option/value inventory.
  tests/test_grep_*.mjs                GNU comparisons and regression suites.
  tests/test_package_entry.mjs         Installed executable and shell-prefix checks.
  tests/test_package_artifact.mjs      Actual npm tar extraction checks.

PATHS
  Repository and test paths are resolved relative to this script, not your cwd.
  GNU grep is /usr/bin/grep; rg with PCRE2, Bash, GNU readlink, Python 3, npm and tar
  must be installed. Tests use no GPU or model server.
  GREP2RG_TEST_PI_ROOT selects an installed node_modules/@earendil-works directory
  for --sdk only; QWEN_TEST_PI_ROOT is accepted for compatibility. No SDK location
  is assumed or required by the normal CPU verification tiers.
  --output FILE is resolved relative to your current working directory.

SECURITY NOTES
  Tests create disposable synthetic files and make no model or Google requests.
  Deadlines terminate the verifier's owned test process group. JSON reports contain
  bounded synthetic diagnostics; artifacts/ is ignored by Git.

EXIT STATUS
  0  All requested stages passed on unchanged source.
  1  Verification, dependency or evidence qualification failed.
  2  Invalid command-line arguments.

AUTHORS
  Terrydaktal
`;

function options(argv) {
  const result = { core: false, deep: false, sdk: false, output: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--core") result.core = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--deep") result.deep = true;
    else if (value === "--sdk") result.sdk = true;
    else if (value === "--output" && argv[index + 1]) result.output = resolve(argv[++index]);
    else throw new Error(`Unknown or incomplete option: ${value}. Usage: node tools/verify.mjs [--core | --deep] [--sdk] [--output FILE]`);
  }
  if (!result.help && result.core && result.deep) throw new Error("--core and --deep select different verification tiers; choose one.");
  return result;
}

function version(program, args) {
  const result = spawnSync(program, args, { cwd: ROOT, encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error(`Required engine ${program} unavailable: ${result.error?.code ?? result.status}.`);
  return result.stdout.trim().slice(0, 8192);
}

function sourceHashes(files) {
  return Object.fromEntries([...new Set(files)].sort().map((file) => [file, createHash("sha256").update(readFileSync(join(ROOT, file))).digest("hex")]));
}

function tapEvidence(log) {
  const counts = {};
  for (const line of log.split("\n")) {
    const match = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
    if (match) counts[match[1]] = Number(match[2]);
  }
  const diagnostics = [];
  for (const line of log.split("\n")) {
    const match = /^\s*# (\{.*\})\s*$/.exec(line);
    if (match) { try { diagnostics.push(JSON.parse(match[1])); } catch { /* Other TAP messages remain in the bounded log. */ } }
  }
  return { counts, diagnostics };
}

function requiredSdkEnvironment() {
  const sdkRoot = process.env.GREP2RG_TEST_PI_ROOT ?? process.env.QWEN_TEST_PI_ROOT;
  if (!sdkRoot) throw new Error("--sdk requires GREP2RG_TEST_PI_ROOT pointing to an installed node_modules/@earendil-works directory.");
  for (const file of [join(sdkRoot, "pi-coding-agent/dist/core/sdk.js"), join(sdkRoot, "pi-coding-agent/dist/core/tools/bash.js")]) {
    if (!existsSync(file)) throw new Error(`--sdk requires an installed Pi SDK; missing ${file}. Set GREP2RG_TEST_PI_ROOT to its actual location.`);
  }
  return { GREP2RG_TEST_PI_ROOT: resolve(sdkRoot) };
}

async function stage(name, files, flags, environment) {
  process.stdout.write(`Running ${name} (${files.length} test file${files.length === 1 ? "" : "s"})…\n`);
  const args = ["--test", "--test-concurrency=1", "--test-reporter=tap", ...flags, ...files.map((file) => join(ROOT, "tests", file))];
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...environment }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "", loggedBytes = 0, logTruncated = false, tail = "", timedOut = false, interrupted = false;
  const append = (data) => {
    const text = data.toString("utf8");
    tail = (tail + text).slice(-131072);
    const remaining = MAX_LOG - loggedBytes;
    if (remaining > 0) {
      const part = Buffer.from(text).subarray(0, remaining).toString("utf8");
      log += part; loggedBytes += Buffer.byteLength(part);
    }
    if (Buffer.byteLength(text) > remaining) logTruncated = true;
  };
  child.stdout.on("data", append); child.stderr.on("data", append);
  const killOwnedGroup = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } } };
  const deadline = setTimeout(() => { timedOut = true; killOwnedGroup(); }, MAX_STAGE_TIME);
  const interrupt = () => { interrupted = true; killOwnedGroup(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const progress = setInterval(() => process.stdout.write(`Still running ${name}: ${Math.round((Date.now() - started) / 1000)}s\n`), 30000);
  const exit = await new Promise((done) => {
    child.once("error", (error) => done({ status: null, signal: null, error: error.code ?? error.message }));
    child.once("close", (status, signal) => done({ status, signal }));
  });
  clearTimeout(deadline); clearInterval(progress);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  const evidence = tapEvidence(logTruncated ? tail : log);
  const passed = exit.status === 0 && !timedOut && !interrupted && !logTruncated && evidence.counts.tests > 0
    && evidence.counts.fail === 0 && evidence.counts.cancelled === 0 && evidence.counts.skipped === 0 && evidence.counts.todo === 0;
  const result = { name, files, args: args.slice(1), ...exit, durationMs: Date.now() - started, timedOut, interrupted, logTruncated, ...evidence, passed, log };
  process.stdout.write(`${name}: ${passed ? "passed" : "FAILED"}; ${evidence.counts.tests ?? 0} Node tests, ${evidence.counts.pass ?? 0} passed, ${evidence.counts.skipped ?? 0} skipped; ${(result.durationMs / 1000).toFixed(2)}s\n`);
  for (const diagnostic of evidence.diagnostics) process.stdout.write(`${name} evidence: ${JSON.stringify(diagnostic)}\n`);
  if (!passed) {
    const failed = /^\s*not ok [^\n]+/m.exec(log);
    if (failed) {
      const failure = log.slice(failed.index);
      const end = /^\s*\.\.\.$/m.exec(failure);
      process.stderr.write(`First failure (full bounded log remains in the report):\n${failure.slice(0, end ? end.index + end[0].length : 16384).slice(0, 16384)}\n`);
    } else process.stderr.write(tail.slice(-8192));
  }
  return result;
}

let configuration;
try { configuration = options(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
if (configuration.help) { process.stdout.write(HELP); process.exit(0); }
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), tier: configuration.deep ? "deep" : configuration.core ? "core" : "default", sdkRequested: configuration.sdk, stages: [], passed: false };
try {
  const selected = [...CORE, ...(!configuration.core ? CAMPAIGNS : [])];
  report.versions = { node: process.version, GNU: version("/usr/bin/grep", ["--version"]), rg: version("rg", ["--version"]), pcre2: version("rg", ["--pcre2-version"]), python: version("python3", ["--version"]), bash: version("/usr/bin/bash", ["--version"]), readlink: version("readlink", ["--version"]), npm: version("npm", ["--version"]), tar: version("tar", ["--version"]) };
  if (!report.versions.GNU.includes("GNU grep")) throw new Error("This verification suite requires GNU grep as its independent oracle.");
  report.sourceHashes = sourceHashes([...IMPLEMENTATION, "tools/verify.mjs", "tools/verify-artifact.mjs", "tests/grep_extended_helpers.mjs", "tests/grep_wrapper_requirements.json",
    "tests/grep_option_inventory.json", "tests/port_source_manifest.json", ...selected.map((file) => `tests/${file}`)]);
  process.stdout.write(`Node ${report.versions.node}; ${report.versions.GNU.split("\n")[0]}; ${report.versions.rg.split("\n")[0]}\n`);
  process.stdout.write(`Source identity: ${createHash("sha256").update(JSON.stringify(report.sourceHashes)).digest("hex")}\n`);
  const sdkEnvironment = configuration.sdk ? requiredSdkEnvironment() : {};
  // Semantic experiments explicitly opt in. Policy tests remove/override this
  // flag in isolated calls to verify production Rust/GNU routes independently.
  const environment = { GREP2RG_EXPERIMENTAL_RG: "1", GREP2RG_DEEP: configuration.deep ? "1" : "0", GREP2RG_TEST_PI_SDK: "0", ...sdkEnvironment };
  report.stages.push(await stage("core", CORE, [], environment));
  if (report.stages.every((run) => run.passed) && !configuration.core) report.stages.push(await stage("campaigns", CAMPAIGNS, [], environment));
  if (report.stages.every((run) => run.passed) && configuration.sdk) {
    report.stages.push(await stage("installed Pi native Bash scope", ["test_grep_scope.mjs"],
      ["--test-name-pattern=installed Pi applies the wrapper"], { ...environment, GREP2RG_TEST_PI_SDK: "1" }));
  }
  report.sourceHashesAfter = sourceHashes(Object.keys(report.sourceHashes));
  report.sourceChanged = JSON.stringify(report.sourceHashesAfter) !== JSON.stringify(report.sourceHashes);
  if (report.sourceChanged) process.stderr.write("Implementation or selected test source changed during verification; before/after hashes are recorded and this run cannot qualify a stable build.\n");
  report.passed = report.stages.length > 0 && report.stages.every((run) => run.passed) && !report.sourceChanged;
  report.nodeTests = report.stages.reduce((sum, run) => sum + (run.counts.tests ?? 0), 0);
  report.campaignDiagnostics = report.stages.flatMap((run) => run.diagnostics);
} catch (error) {
  report.error = error.message;
  process.stderr.write(`${error.message}\n`);
}
report.finishedAt = new Date().toISOString();
if (configuration.output) {
  await mkdir(dirname(configuration.output), { recursive: true, mode: 0o700 });
  await writeFile(configuration.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Evidence saved to ${configuration.output}\n`);
}
process.stdout.write(`Verification ${report.passed ? "passed" : "FAILED"}: ${report.nodeTests ?? 0} Node tests; campaign comparison counts are recorded separately in their diagnostics.\n`);
process.exitCode = report.passed ? 0 : 1;
