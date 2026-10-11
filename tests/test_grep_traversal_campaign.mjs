// Bounded differential filesystem campaigns. GNU grep is the independent oracle;
// every payload and raw-byte pathname belongs to a disposable synthetic tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { withGrepWrapper } from "../src/grep-wrapper.mjs";

const DEEP = process.env.GREP2RG_DEEP === "1";
const SEED = 0x6a31c9d2;
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const outputModes = ["-aFlZ", "-aFnH", "-aFnh", "-aFbH", "-aFc", "-aFLZ", "-aFvnlZ", "-aFvH", "-aFn", "-aFHo", "-aFq", "-aFcH"];
const patterns = ["needle", "ember", "a+b", "no-such-term"];
const globs = ["*.txt", "*.js", "a*", "[!b]*", "*.tmp", "*", "foo\\[1\\].txt", "a{b}.txt", "dir/*.txt", "[[:alpha:]]*.txt"];

function generator(seed) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return value >>> 0;
  };
}

function tree(index, random) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-grep-traversal-campaign-"));
  const files = [
    "a.txt", "b.js", "plain.tmp", ".hidden", "a{b}.txt", "foo[1].txt",
    "space name.txt", "line\nbreak.txt", "unicodé.txt", "dash-name", "dir/x.txt",
    "dir/deep/y.js", ".hidden-dir/z.txt", "ignored/w.txt", "nested/dir/q.txt", "binary.bin",
  ];
  const rows = ["needle", "ember", "a+b", "ordinary text", "NEEDLE", "none"];
  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    const selected = Array.from({ length: 2 + random() % 6 }, () => rows[random() % rows.length]);
    if (i === 0) selected.unshift("needle");
    if (name.endsWith(".bin")) selected.unshift("\0early");
    writeFileSync(join(cwd, name), selected.join("\n") + (random() % 3 ? "\n" : ""));
  }
  writeFileSync(join(cwd, ".gitignore"), "ignored/\n.hidden-dir/\n");
  writeFileSync(join(cwd, "exclude.rules"), index % 2 ? "*.tmp\nfoo\\[1\\].txt\n" : "b.js\nspace*.txt\n");
  symlinkSync("dir", join(cwd, "alias-dir"));
  symlinkSync("a.txt", join(cwd, "alias-file"));
  if (index % 3 === 0) symlinkSync("..", join(cwd, "dir", "loop"));
  if (index % 4 === 0) symlinkSync("missing", join(cwd, "broken"));
  return { cwd, files, index };
}

function execute(command, cwd, { adapted = false, env = {}, input } = {}) {
  const context = adapted ? withGrepWrapper({ command }, "/usr/bin/bash") : { command: command.replace(/^grep\b/, "command grep") };
  const result = spawnSync("bash", ["-c", context.command], {
    cwd, env: { ...process.env, LC_ALL: "C", TERM: "dumb", ...env }, input,
    // File-only commands do not consume stdin. Do not create a writer for them:
    // older Node releases can report its unused pipe as a subprocess EPIPE.
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `bounded subprocess failed (${adapted ? "adapter" : "GNU"}): ${result.error?.code}`);
  assert.equal(result.signal, null, `subprocess terminated by ${result.signal}`);
  return result;
}

function compare(argv, cwd, { env, command, input } = {}) {
  const source = command ?? `grep ${argv.map(shellQuote).join(" ")}`;
  const expected = execute(source, cwd, { env, input });
  const actual = execute(source, cwd, { adapted: true, env, input });
  const note = `seed=0x${SEED.toString(16)} argv=${JSON.stringify(argv)} env=${JSON.stringify(env ?? {})}`;
  assert.equal(actual.status, expected.status, `exit status: ${note}`);
  assert.deepEqual(actual.stdout, expected.stdout, `stdout: ${note}`);
  assert.deepEqual(actual.stderr, expected.stderr, `stderr: ${note}`);
  return actual;
}

function caseFor(index, row, random) {
  const mode = outputModes[(index + random() % outputModes.length) % outputModes.length];
  const pattern = patterns[(row + random() % patterns.length) % patterns.length];
  const glob = globs[random() % globs.length];
  const operands = ["a.txt", "b.js", "dir/x.txt", "space name.txt", "line\nbreak.txt"];
  const chosen = operands[random() % operands.length];
  switch (row % 16) {
    case 0: return [mode, "-r", "-e", pattern, "."];
    case 1: return [mode, "-R", "-e", pattern, "dir", "alias-dir"];
    case 2: return [mode, "-r", `--include=${glob}`, "-e", pattern, "."];
    case 3: return [mode, "-r", `--exclude=${glob}`, "-e", pattern, "."];
    case 4: return [mode, "-r", "--include=*.txt", `--exclude=${glob}`, "--include=a*", "-e", pattern, "."];
    case 5: return [mode, "-r", `--exclude=${glob}`, "--include=*.txt", "-e", pattern, "."];
    case 6: return [mode, "-r", "--exclude-dir=dir", "-e", pattern, ".", "dir/"];
    case 7: return [mode, "--exclude-from=exclude.rules", `--include=${glob}`, "-e", pattern, ...operands];
    case 8: return [mode, `--include=${glob}`, "-e", pattern, "dir/x.txt", "dir/deep/y.js", chosen];
    case 9: return [mode, "-r", "-e", pattern, "alias-dir", "alias-file", chosen];
    case 10: return [mode, "--directories=skip", "-e", pattern, "dir", chosen];
    case 11: return [mode, "--directories=read", "-e", pattern, chosen, "dir"];
    case 12: return [mode, "-r", "--exclude-dir=dir", "-e", pattern, "./dir//", "nested"];
    case 13: return [mode, "--label=synthetic stdin", "-e", pattern, "-", chosen];
    case 14: return [mode, "-e", pattern, chosen, chosen, "a.txt"];
    case 15: return [mode, "-r", "--exclude-dir=.hidden-dir", "--exclude-dir=ignored", "-e", pattern, "."];
  }
}

test("seeded full CLI traversal campaign", (t) => {
  const random = generator(SEED);
  const trees = DEEP ? 96 : 32;
  const casesPerTree = DEEP ? 16 : 10;
  let comparisons = 0;
  for (let index = 0; index < trees; index++) {
    const fixture = tree(index, random);
    try {
      // Rotating the starting scenario exercises all sixteen families in quick
      // mode, rather than merely duplicating the first ten with new seeds.
      for (let row = 0; row < casesPerTree; row++) {
        const argv = caseFor(index, index + row, random);
        compare(argv, fixture.cwd, {
          env: { LC_ALL: index % 2 ? "C.UTF-8" : "C" },
          input: (index + row) % 16 === 13 ? Buffer.from("needle\nstdin ember\n") : undefined,
        });
        comparisons++;
      }
    } finally { rmSync(fixture.cwd, { recursive: true, force: true }); }
  }
  assert.equal(comparisons, trees * casesPerTree);
  t.diagnostic(JSON.stringify({ campaign: "traversal", seed: `0x${SEED.toString(16)}`, deep: DEEP, comparisons, dimensions: "32/96 varied trees;16 traversal families;12 output modes;4 terms;10 filter globs" }));
});

test("campaign input is supplied only for explicitly declared stdin fixtures", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-grep-campaign-stdin-"));
  try {
    writeFileSync(join(cwd, "file.txt"), "needle file\n");
    assert.deepEqual(compare(["-aFnH", "needle", "file.txt"], cwd).stdout, Buffer.from("file.txt:1:needle file\n"));
    const input = Buffer.from("needle stdin\nordinary\n");
    assert.deepEqual(compare(["-aFnH", "needle"], cwd, { input }).stdout, Buffer.from("(standard input):1:needle stdin\n"));
    assert.deepEqual(
      compare(["-aFnH", "--label=owned stdin", "needle", "-", "file.txt"], cwd, { input }).stdout,
      Buffer.from("owned stdin:1:needle stdin\nfile.txt:1:needle file\n"),
    );
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

const nulNames = (buffer) => buffer.toString("utf8").split("\0").filter(Boolean);

test("narrowing, repeated operands and dereference metamorphic invariants", (t) => {
  const random = generator(SEED ^ 0x218fd025);
  const trees = DEEP ? 48 : 12;
  let comparisons = 0;
  for (let index = 0; index < trees; index++) {
    const fixture = tree(index + 1, random);
    try {
      const broad = compare(["-aFrlZ", "--include=*", "-e", "needle", "."], fixture.cwd); comparisons++;
      const narrow = compare(["-aFrlZ", "--include=*", "--exclude=*.tmp", "--exclude-dir=ignored", "-e", "needle", "."], fixture.cwd); comparisons++;
      const original = new Set(nulNames(broad.stdout));
      for (const name of nulNames(narrow.stdout)) assert(original.has(name), `narrowing introduced ${JSON.stringify(name)}`);
      assert(!nulNames(narrow.stdout).some((name) => name.endsWith(".tmp") || name.startsWith("./ignored/")));

      const single = compare(["-aFnH", "-e", "needle", "a.txt"], fixture.cwd); comparisons++;
      const doubled = compare(["-aFnH", "-e", "needle", "a.txt", "a.txt"], fixture.cwd); comparisons++;
      assert.deepEqual(doubled.stdout, Buffer.concat([single.stdout, single.stdout]), "duplicate operands preserve duplicate output");

      const followed = compare(["-aFRlZ", "-e", "needle", "."], fixture.cwd); comparisons++;
      const dereferenced = new Set(nulNames(followed.stdout));
      for (const name of original) assert(dereferenced.has(name), `-R lost an -r regular file ${JSON.stringify(name)}`);
      assert(dereferenced.has("./alias-file"), "-R includes the matching file symlink");
      assert(!original.has("./alias-file"), "-r excludes interior symlinks");
    } finally { rmSync(fixture.cwd, { recursive: true, force: true }); }
  }
  t.diagnostic(JSON.stringify({ campaign: "traversal-metamorphic", seed: `0x${(SEED ^ 0x218fd025).toString(16)}`, deep: DEEP, comparisons, invariants: ["filter narrowing", "duplicate operand multiplicity", "r selected names subset of R"] }));
});

test("raw filename bytes, leading hyphens and whitespace retain exact GNU CLI output", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-grep-pathbytes-campaign-"));
  const raw = Buffer.concat([Buffer.from(`${cwd}/`), Buffer.from([0xff, 0xfe]), Buffer.from(".txt")]);
  let comparisons = 0;
  try {
    for (const name of ["ordinary.txt", "space name.txt", "line\nbreak.txt", "unicodé.txt", "-leading.txt", "quote'file.txt"]) writeFileSync(join(cwd, name), "needle\nember\n");
    writeFileSync(raw, "needle\n");
    for (const locale of ["C", "C.UTF-8"]) {
      for (const argv of [
        ["-aFrlZ", "needle", "."],
        ["-aFrnH", "needle", "."],
        ["-aFlZ", "needle", "line\nbreak.txt", "space name.txt"],
        ["-aFnH", "needle", "unicodé.txt", "quote'file.txt"],
        ["-aFnH", "-e", "needle", "--", "-leading.txt"],
      ]) { compare(argv, cwd, { env: { LC_ALL: locale } }); comparisons++; }
      compare(["-aFlZ", "needle", "<raw-byte-name>"], cwd, { env: { LC_ALL: locale }, command: "grep -aFlZ needle $'\\xff\\xfe.txt'" }); comparisons++;
    }
  } finally {
    unlinkSync(raw);
    rmSync(cwd, { recursive: true, force: true });
  }
  t.diagnostic(JSON.stringify({ campaign: "raw-pathnames", comparisons, locales: ["C", "C.UTF-8"] }));
});
