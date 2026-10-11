import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compileGrepGlob, enumerateInputs, loadGrepFilters, requiresNativeGrepFileSelection } from "../src/grep-files.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-grep-files-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const name of ["plain.txt", "code.js", ".hidden", "a{b}.txt", "foo[1].txt", "dir/a.txt", "dir/deep/b.txt", "ignored/c.txt", "nested/dir/d.txt"]) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), "needle\n");
  }
  await writeFile(join(cwd, ".gitignore"), "ignored/\n");
  await symlink("dir", join(cwd, "linked-dir"));
  await symlink("plain.txt", join(cwd, "linked-file"));
  await symlink("missing", join(cwd, "broken"));
  await symlink("..", join(cwd, "dir/loop"));
  return cwd;
}

async function entries(options, cwd) {
  const result = [];
  for await (const input of enumerateInputs(options, { cwd })) result.push(input);
  return result;
}

function oracle(args, cwd, input = "needle\n") {
  const result = spawnSync("/usr/bin/grep", ["-l", "-F", "-e", "needle", ...args], {
    cwd, env: { ...process.env, LC_ALL: "C" }, encoding: "utf8", input,
  });
  if (result.error) throw result.error;
  return result;
}

// Every temporary payload contains the selected term, so GNU's filenames output
// independently establishes which paths the adapter must hand to rg.
async function compare(t, options, args) {
  const cwd = await fixture(t);
  const inputs = await entries(options, cwd);
  const native = oracle([...args, "--", ...(options.paths ?? [])], cwd);
  const selected = inputs.filter((input) => input.kind === "file" || input.kind === "stdin");
  // .gitignore is traversed but does not contain the selected term.
  assert.deepEqual(selected.filter((input) => !input.label.endsWith(".gitignore")).map((input) => input.label), native.stdout.split("\n").filter(Boolean));
  const errors = inputs.filter((input) => input.error && !input.error.warning);
  assert.equal(errors.length > 0, native.status === 2);
  return inputs;
}

test("recursive traversal includes hidden and gitignored files while skipping interior symlinks", async (t) => {
  const inputs = await compare(t, { paths: ["."], recursive: true }, ["-r"]);
  assert(inputs.some((input) => input.label === "./.hidden"));
  assert(inputs.some((input) => input.label === "./ignored/c.txt"));
  assert(!inputs.some((input) => input.label.includes("linked") || input.label.endsWith("broken")));
});

test("dereference traversal follows files/directories and reports loops as warnings", async (t) => {
  const inputs = await compare(t, { paths: ["."], recursive: true, follow: true }, ["-R"]);
  assert.equal(inputs.filter((input) => input.error?.warning).length, 2);
  assert.equal(inputs.filter((input) => input.error?.code === "ENOENT").length, 1);
});

test("-r follows explicit symlink operands", async (t) => {
  await compare(t, { paths: ["linked-dir", "linked-file"], recursive: true }, ["-r"]);
});

test("include filters match discovered basenames", async (t) => {
  await compare(t, { paths: ["."], recursive: true, filters: [{ type: "include", value: "*.txt" }] }, ["-r", "--include=*.txt"]);
});

test("slash-containing include filters match only command-line name suffixes", async (t) => {
  await compare(t, { paths: ["dir/a.txt", "dir/deep/b.txt", "plain.txt"], filters: [{ type: "include", value: "dir/*.txt" }] }, ["--include=dir/*.txt"]);
  await compare(t, { paths: ["."], recursive: true, filters: [{ type: "include", value: "dir/*.txt" }] }, ["-r", "--include=dir/*.txt"]);
});

test("the first rule determines the unmatched default and the final matching rule wins", async (t) => {
  for (const filters of [
    [{ type: "exclude", value: "a.txt" }, { type: "include", value: "*.txt" }],
    [{ type: "include", value: "*.txt" }, { type: "exclude", value: "a.txt" }],
    [{ type: "include", value: "*.txt" }, { type: "exclude", value: "a.txt" }, { type: "include", value: "a.txt" }],
  ]) await compare(t, { paths: ["."], recursive: true, filters }, ["-r", ...filters.map((rule) => `--${rule.type}=${rule.value}`)]);
});

test("exclude-dir prunes descendants and explicit matched roots", async (t) => {
  const filters = [{ type: "exclude-dir", value: "dir" }];
  await compare(t, { paths: ["."], recursive: true, filters }, ["-r", "--exclude-dir=dir"]);
  await compare(t, { paths: ["dir"], recursive: true, filters }, ["-r", "--exclude-dir=dir"]);
});

test("a trailing slash in an explicit directory operand has GNU matching semantics", async (t) => {
  await compare(t, { paths: ["dir//"], recursive: true, filters: [{ type: "exclude-dir", value: "dir" }] }, ["-r", "--exclude-dir=dir"]);
});

test("nonrecursive directory read emits EISDIR while skip emits no input", async (t) => {
  const inputs = await compare(t, { paths: ["dir"] }, []);
  assert.equal(inputs[0].error.code, "EISDIR");
  await compare(t, { paths: ["dir"], directories: "skip" }, ["-d", "skip"]);
});

test("missing explicit operands are errors even when a filename filter would exclude them", async (t) => {
  await compare(t, { paths: ["missing"], filters: [{ type: "exclude", value: "missing" }] }, ["--exclude=missing"]);
  await compare(t, { paths: ["missing"], filters: [{ type: "include", value: "*.txt" }] }, ["--include=*.txt"]);
});

test("literal braces, escaped brackets and POSIX bracket classes are GNU glob syntax", async (t) => {
  for (const value of ["a{b}.txt", "foo\\[1\\].txt", "[!p]*.txt", "[[:alpha:]]*.txt"]) {
    await compare(t, { paths: ["."], recursive: true, filters: [{ type: "include", value }] }, ["-r", `--include=${value}`]);
  }
  assert.equal(compileGrepGlob("a{b,c}.txt")("ab.txt"), false);
  assert.equal(compileGrepGlob("[[]")("["), true);
  assert.equal(compileGrepGlob("[]a]")("]"), true);
});

test("exclude-from preserves ordering and does not invent a rule for an empty file", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "exclude.txt"), "plain.txt\nfoo\\[1\\].txt\n");
  await writeFile(join(cwd, "empty.txt"), "");
  const options = { paths: ["plain.txt", "foo[1].txt", "code.js"], filters: [
    { type: "exclude-file", value: "exclude.txt" }, { type: "include", value: "plain.txt" },
  ] };
  const native = oracle(["--exclude-from=exclude.txt", "--include=plain.txt", "--", ...options.paths], cwd);
  const selected = (await entries(options, cwd)).map((input) => input.label);
  assert.deepEqual(selected, native.stdout.split("\n").filter(Boolean));
  assert.deepEqual(await loadGrepFilters({ filters: [{ type: "exclude-file", value: "empty.txt" }] }, { cwd }), []);
});

test("implicit stdin, explicit mixed stdin and recursive implicit cwd are distinguished", async (t) => {
  const cwd = await fixture(t);
  assert.deepEqual((await entries({}, cwd)).map((input) => [input.kind, input.label, input.filenameRequired]), [["stdin", "(standard input)", false]]);
  assert.deepEqual((await entries({ paths: ["plain.txt", "-"], label: "custom" }, cwd)).map((input) => [input.kind, input.label, input.filenameRequired]), [["file", "plain.txt", true], ["stdin", "custom", true]]);
  assert((await entries({ recursive: true }, cwd)).some((input) => input.label === "./plain.txt"));
});

test("filename prefixes use the operand count and recursion, with explicit overrides", async (t) => {
  const cwd = await fixture(t);
  assert.equal((await entries({ paths: ["plain.txt"], recursive: true }, cwd))[0].filenameRequired, false);
  assert.equal((await entries({ paths: ["dir"], recursive: true }, cwd))[0].filenameRequired, true);
  assert((await entries({ paths: ["dir"], recursive: true, filename: false }, cwd)).every((input) => input.filenameRequired === false));
  assert.equal((await entries({ paths: ["plain.txt"], filename: true }, cwd))[0].filenameRequired, true);
});

test("explicit device skipping does not block on a FIFO", async (t) => {
  const cwd = await fixture(t);
  const created = spawnSync("mkfifo", [join(cwd, "pipe")]);
  assert.equal(created.status, 0);
  assert.deepEqual(await entries({ paths: ["pipe"], devices: "skip" }, cwd), []);
  assert(!(await entries({ recursive: true }, cwd)).some((input) => input.label.endsWith("/pipe")));
  const explicit = await entries({ paths: ["pipe"], recursive: true }, cwd);
  assert.equal(explicit[0].special, true);
  const implicitReadDefault = await entries({ recursive: true, devices: "read", devicesExplicit: false }, cwd);
  assert(!implicitReadDefault.some((input) => input.label.endsWith("/pipe")));
  const forcedRead = await entries({ recursive: true, devices: "read", devicesExplicit: true }, cwd);
  assert.equal(forcedRead.find((input) => input.label.endsWith("/pipe")).special, true);
});

test("a directory permission failure reports one error and enumeration continues", async (t) => {
  const cwd = await fixture(t);
  const blocked = join(cwd, "restricted");
  await mkdir(blocked); await writeFile(join(blocked, "inside.txt"), "needle\n");
  await chmod(blocked, 0);
  // Restore fixture permissions even when the independent comparison fails.
  try {
    const native = oracle(["-r", "--", "restricted", "plain.txt"], cwd);
    const inputs = await entries({ recursive: true, paths: ["restricted", "plain.txt"] }, cwd);
    assert.equal(native.status, 2);
    assert.deepEqual(inputs.map((input) => [input.kind, input.label, input.error?.code]), [["error", "restricted", "EACCES"], ["file", "plain.txt", undefined]]);
    assert.equal(native.stdout, "plain.txt\n");
  } finally { await chmod(blocked, 0o700); }
});

test("exclude-from open failures remain real errors instead of dropping exclusions", async (t) => {
  const cwd = await fixture(t);
  await assert.rejects(async () => entries({ paths: ["plain.txt"], filters: [{ type: "exclude-file", value: "missing.rules" }] }, cwd), { code: "ENOENT" });
});

test("an explicit broken symlink differs from an interior -r symlink", async (t) => {
  await compare(t, { paths: ["broken"], recursive: true }, ["-r"]);
});

test("C-locale byte globs agree with GNU on escaped, malformed and nonASCII names", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-grep-globs-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const names = ["a", "b", "z", "A", "!", "-", "[", "]", "[z-a]", "[[:bad:]]", "[abc", "\\", "*", "?", "é", "a-z", "a{b}", "foo[1]"];
  for (const name of names) await writeFile(join(cwd, name), "needle\n");
  for (const value of ["*", "?", "[a-z]", "[z-a]", "[]a]", "[[]", "[abc", "[!a]", "[^a]", "[!]]", "[]]", "[-a]", "[a-]", "[a\\-z]", "[[:punct:]]", "[[:bad:]]", "[.a.]", "[[.a.]]", "a{b}", "\\*", "\\", "é"]) {
    const native = oracle([`--include=${value}`, "--", ...names.map((name) => `./${name}`)], cwd);
    const actual = names.filter(compileGrepGlob(value, { env: { LC_ALL: "C" } })).map((name) => `./${name}`);
    assert.deepEqual(actual, native.stdout.split("\n").filter(Boolean), value);
  }
});

test("locale-sensitive filename rules explicitly request native fallback", async () => {
  const options = (value) => ({ filters: [{ type: "include", value }] });
  assert.equal(requiresNativeGrepFileSelection(options("*.txt"), { env: { LC_ALL: "en_GB.UTF-8" } }), false);
  assert.equal(requiresNativeGrepFileSelection(options("[[:alpha:]]*.txt"), { env: { LC_ALL: "en_GB.UTF-8" } }), true);
  assert.equal(requiresNativeGrepFileSelection(options("[a-z]*.txt"), { env: { LC_ALL: "en_GB.UTF-8" } }), true);
  assert.equal(requiresNativeGrepFileSelection(options("[[:alpha:]]*.txt"), { env: { LC_ALL: "C" } }), false);
  assert.equal(requiresNativeGrepFileSelection({ excludeDir: ["é"] }, { env: { LC_ALL: "C" } }), true);
  assert.equal(requiresNativeGrepFileSelection(options("[[.a.]]"), { env: { LC_ALL: "C" } }), true);
  assert.equal(requiresNativeGrepFileSelection({ include: ["a{b}.txt"], exclude: ["foo\\[1\\].txt"] }, { env: { LC_ALL: "C" } }), false);
});

test("file enumeration records size without reading inaccessible file payloads", async (t) => {
  const cwd = await fixture(t);
  const restricted = join(cwd, "plain.txt"); await chmod(restricted, 0);
  try {
    const inputs = await entries({ paths: ["plain.txt"] }, cwd);
    assert.equal(inputs[0].kind, "file");
    assert.equal(inputs[0].size, Buffer.byteLength("needle\n"));
    assert.equal(oracle(["plain.txt"], cwd).status, 2);
  } finally { await chmod(restricted, 0o600); }
});

test("nonUTF8 directory names request native execution instead of silently dropping a GNU match", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-grep-byte-names-"));
  const filename = Buffer.concat([Buffer.from(`${cwd}/`), Buffer.from([0xff]), Buffer.from(".txt")]);
  try {
    await writeFile(filename, "needle\n");
    const native = spawnSync("/usr/bin/grep", ["-r", "-l", "-F", "-e", "needle", "."], { cwd, env: { ...process.env, LC_ALL: "C" } });
    assert.equal(native.status, 0);
    assert.deepEqual(native.stdout, Buffer.concat([Buffer.from("./"), Buffer.from([0xff]), Buffer.from(".txt\n")]));
    const inputs = await entries({ paths: ["."], recursive: true }, cwd);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].kind, "native");
    assert.match(inputs[0].reason, /non-UTF-8 filename bytes/);
  } finally {
    await unlink(filename).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancelled enumeration cannot keep walking", async (t) => {
  const cwd = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => { for await (const _ of enumerateInputs({ recursive: true }, { cwd, signal: controller.signal })) {} }, { name: "AbortError" });
});
