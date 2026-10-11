// GNU grep is the independent compatibility oracle; all data is disposable.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { planGrep, withGrepWrapper } from "../src/grep-wrapper.mjs";

const adapter = fileURLToPath(new URL("../src/grep-wrapper.mjs", import.meta.url));
const fixture = (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "grep-wrapper-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const put = (name, content) => writeFileSync(join(cwd, name), content);
  mkdirSync(join(cwd, "tree"));
  put("a.txt", "Emma\nalpha\na+b\n");
  put("b.txt", "emma\nbeta\n");
  put("no.txt", "other\n");
  put("tree/plain.txt", "emma\n");
  put("tree/.hidden", "emma\n");
  put("tree/.gitignore", "ignored.txt\n");
  put("tree/ignored.txt", "emma\n");
  put("tree/late.bin", Buffer.from("\0early\n" + "none\n".repeat(60000) + "emma\n"));
  put("tree/invalid.bin", Buffer.from([255, ...Buffer.from("emma\n")]));
  put("tree/no.bin", Buffer.from("\0none\n"));
  put("early-nul.bin", Buffer.from("\0early\nemma\n"));
  put("dotless.txt", "ı\n");
  put("kelvin.txt", "K\n");
  put("long-s.txt", "ſ\n");
  return { cwd, put };
};
const run = (program, argv, cwd, env = {}) => {
  const result = spawnSync(program, argv, {
    cwd, env: { ...process.env, LC_ALL: "C.UTF-8", ...env },
    encoding: "buffer", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${program} subprocess failed: ${result.error?.code}`);
  assert.equal(result.signal, null, `${program} subprocess terminated by ${result.signal}`);
  return result;
};
const oracle = (argv, cwd, env) => run("grep", argv, cwd, env);
const adapted = (argv, cwd, env) => run(process.execPath, [adapter, ...argv], cwd, env);
const filenames = (result) => result.stdout.toString().split("\n").filter(Boolean).sort();
const parity = (argv, cwd, { env, unordered = false, stderr = true } = {}) => {
  const expected = oracle(argv, cwd, env), actual = adapted(argv, cwd, env);
  assert.equal(actual.status, expected.status, `exit status for ${JSON.stringify(argv)}`);
  if (unordered) assert.deepEqual(filenames(actual), filenames(expected));
  else assert.deepEqual(actual.stdout, expected.stdout, `stdout for ${JSON.stringify(argv)}`);
  if (stderr) assert.deepEqual(actual.stderr, expected.stderr, `stderr for ${JSON.stringify(argv)}`);
  return actual;
};

test("common files-only grep calls route to rg and preserve GNU ordered output", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [["-l", "-i", "emma", "a.txt", "b.txt", "no.txt"],
    ["-Fl", "a+b", "a.txt"], ["-l", "a+b", "a.txt"],
    ["-l", "-e", "emma", "-e", "alpha", "b.txt", "a.txt"],
    ["-l", "-Z", "emma", "b.txt", "a.txt"]]) {
    assert.equal(planGrep(argv, { env: { LC_ALL: "C.UTF-8" }, stat: () => ({ isDirectory: () => false, isFile: () => true }) }).backend, "rg");
    parity(argv, cwd);
  }
});

test("large direct operand lists use bounded batches instead of overflowing rg argv", () => {
  const paths = Array.from({ length: 1000 }, (_, index) => `file-${index}-${"x".repeat(50)}`);
  const result = planGrep(["-Fl", "emma", ...paths], { stat: () => ({ isFile: () => true }) });
  assert.equal(result.backend, "rg");
  assert.equal(result.mode, "json");
  assert.equal(result.args, undefined);
});

test("large pattern-file expansion preserves GNU behavior through fallback", (t) => {
  const { cwd, put } = fixture(t);
  put("many-patterns", `${"x".repeat(60000)}\nemma\n`);
  parity(["-aF", "-f", "many-patterns", "b.txt"], cwd);
});

test("recursive files-only searches retain hidden, ignored, binary and symlink coverage", (t) => {
  const { cwd } = fixture(t);
  symlinkSync("../b.txt", join(cwd, "tree", "linked.txt"));
  const plain = parity(["-rl", "emma", "tree"], cwd, { unordered: true });
  for (const name of ["tree/.hidden", "tree/ignored.txt", "tree/late.bin", "tree/invalid.bin"])
    assert.ok(filenames(plain).includes(name), `${name} must not be silently skipped`);
  assert.ok(!filenames(plain).includes("tree/linked.txt"));
  assert.ok(filenames(parity(["-Rl", "emma", "tree"], cwd, { unordered: true })).includes("tree/linked.txt"));
});

test("explicit text output preserves line numbers, filename selection and literal BRE punctuation", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [["-an", "emma", "b.txt"], ["-anH", "emma", "b.txt"],
    ["-anh", "emma", "b.txt", "tree/plain.txt"],
    ["-an", "a+b", "a.txt"], ["-Fan", "emma", "tree/invalid.bin"],
    ["-Fa", "emma", "early-nul.bin"]]) parity(argv, cwd);
});

test("locale-sensitive case folding falls back instead of changing match sets", (t) => {
  const { cwd } = fixture(t);
  const file = { isDirectory: () => false, isFile: () => true };
  for (const [pattern, path] of [["i", "dotless.txt"], ["k", "kelvin.txt"]]) {
    assert.equal(planGrep(["-il", pattern, path], { env: { LC_ALL: "C.UTF-8" }, stat: () => file }).backend, "grep");
    parity(["-il", pattern, path], cwd);
  }
  const cPlan = planGrep(["-il", "s", "long-s.txt"], { env: { LC_ALL: "C" }, stat: () => file });
  assert.equal(cPlan.backend, "rg");
  assert.ok(cPlan.args.includes("--no-unicode"));
  parity(["-il", "s", "long-s.txt"], cwd, { env: { LC_ALL: "C" } });
  parity(["-il", "s", "long-s.txt"], cwd);
  assert.equal(planGrep(["-il", "emma", "a.txt"], { env: { LC_ALL: "tr_TR.UTF-8" }, stat: () => file }).backend, "grep");
});

test("binary, matcher and traversal compatibility retains GNU behavior without rejecting valid searches", (t) => {
  const { cwd } = fixture(t);
  for (const argv of [["-I", "emma", "early-nul.bin"], ["-Il", "emma", "early-nul.bin"],
    ["emma", "tree/invalid.bin"], ["-F", "-E", "-l", "emma", "b.txt"],
    ["-G", "-F", "-l", "emma", "b.txt"], ["-L", "absent", "b.txt"],
    ["-c", "absent", "b.txt"], ["--include=*.py", "-l", "emma", "b.txt"]]) parity(argv, cwd);
  for (const argv of [["-rIl", "emma", "tree"], ["-rl", "-E", "emma|alpha", "tree"],
    ["-rl", "--exclude=*.txt", "emma", "tree"],
    ["-rl", "--include=*.py", "emma", "b.txt"]]) {
    parity(argv, cwd, { unordered: argv.includes("-rl") });
  }
});

test("recursive includes filter directory traversal without skipping matching hidden files", (t) => {
  const { cwd, put } = fixture(t);
  mkdirSync(join(cwd, "tree", "folder.txt"));
  put("tree/folder.txt/not-included", "emma\n");
  put("tree/.included.txt", "emma\n");
  const actual = parity(["-rl", "--include=*.txt", "emma", "tree"], cwd, { unordered: true });
  assert.ok(filenames(actual).includes("tree/.included.txt"));
  assert.ok(!filenames(actual).includes("tree/folder.txt/not-included"));
});

test("no-match and missing-file failures preserve nonzero exit status", (t) => {
  const { cwd } = fixture(t);
  assert.equal(parity(["-l", "absent", "a.txt"], cwd).status, 1);
  for (const argv of [["-l", "emma", "missing.txt"], ["-l", "emma", "b.txt", "missing.txt"]]) {
    const actual = parity(argv, cwd, { stderr: false });
    assert.equal(actual.status, 2);
    assert.match(actual.stderr.toString(), /missing\.txt/);
  }
});

test("Pi shell injection respects quotes, globs, pipelines, command bypass and child scripts", (t) => {
  const { cwd, put } = fixture(t);
  put("child.sh", '#!/usr/bin/env bash\ntype -t grep\ngrep -E -l "Emma|alpha" a.txt\n');
  const command = 'cd tree; printf "%s\\n" "literal grep and $(printf quoted)"; cd ..; grep -l -i "emma" ?.txt | head; printf "a+b\\naab\\n" | grep "a\\\\+b"; command grep -E -l "Emma|alpha" a.txt; bash child.sh';
  const expected = run("bash", ["-c", command], cwd);
  const wrapped = withGrepWrapper({ command, cwd, env: { SDK_MARKER: "intact" } }, "/usr/bin/bash");
  assert.equal(wrapped.cwd, cwd);
  assert.deepEqual(wrapped.env, { SDK_MARKER: "intact" });
  const actual = run("bash", ["-c", wrapped.command], cwd);
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
  assert.match(actual.stdout.toString(), /\nfile\na\.txt\n$/);
  assert.deepEqual(withGrepWrapper({ command, cwd }, "/usr/bin/fish"), { command, cwd });
});

test("stdin filters and quoted grep words retain unmodified GNU arguments", (t) => {
  const { cwd } = fixture(t);
  const argv = ["-E", "a+b"];
  assert.equal(planGrep(argv).backend, "grep");
  assert.deepEqual(planGrep(argv).args, argv);
  const command = 'printf "aab\\na+b\\n" | grep -E "a+b"; printf "%s\\n" "grep -r is only text"; grep -E "a+b" < a.txt';
  const wrapped = withGrepWrapper({ command, cwd });
  const expected = run("bash", ["-c", command], cwd);
  const actual = run("bash", ["-c", wrapped.command], cwd);
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
});
