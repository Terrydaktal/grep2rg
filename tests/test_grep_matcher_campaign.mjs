// Bounded, deterministic operator qualification. GNU remains the independent
// oracle; native cases validate fallback selection rather than claiming rg
// reproduced semantics that the adapter deliberately does not translate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  buildGrepMatcherArgs, grepMatcherFallbackReasons, parseGrepOptions,
  resolveGrepPatterns,
} from "../src/grep-options.mjs";
import { createGrepFormatter } from "../src/grep-output.mjs";

const SEED = 0x4729ac2e;
const DEEP = process.env.GREP2RG_DEEP === "1";
const TARGET = DEEP ? 12_000 : 2_400;
const COMMON_ENV = { ...process.env, LANG: "C" };
delete COMMON_ENV.POSIXLY_CORRECT;
const ENVIRONMENTS = ["C", "C.UTF-8"].map((locale) => ({ ...COMMON_ENV, LC_ALL: locale }));
const FLAGS = [[], ["-i"], ["-w"], ["-x"], ["-v"], ["-w", "-i"], ["-x", "-v"], ["-z"], ["-z", "-x"], ["-o"], ["-o", "-i"], ["-w", "-v"], ["-x", "-i"], ["-z", "-i", "-v"]];
const SUBJECTS = [
  Buffer.alloc(0), Buffer.from("\n"), Buffer.from("a\naa\nab\naba\nb\nabc\nword\nsword\nword_end\n"),
  Buffer.from("foo foo\nfoo_bar\n(foo)\n@\nx@y\na+b\na?b\n(a)\na{2}\na|b\n\\\n"),
  Buffer.from("i\nI\nı\nİ\nk\nK\nK\nß\nẞ\né\nα\n١\n"),
  Buffer.from("foo\0bar\0foo bar\0\0"), Buffer.from("a\r\nab\r\nfoo\r\n"),
  Buffer.from([0xff, 10, 97, 0xff, 98, 10, 97, 98, 99, 0xff, 10]),
  Buffer.from([0xed, 0xa0, 0x80, 10, 97, 98, 10]),
  Buffer.from("foo\na\nab"), Buffer.from("a".repeat(512) + "b\nfoo\n"),
  Buffer.from("foo\nbar\0a\nb\0word\0"),
];

const PATTERNS = {
  G: ["", "a", "ab", "foo", "word", "@", "a+b", "a?b", "a|b", "(a)", "a{2}", "^a", "a$", "a^b", "a$b", "^^a", "a.*b", ".", "^.$", "^.*$", "[ab]", "[^b]", "[a-z]", "[[:digit:]]", String.raw`[\d]`, String.raw`\(ab\)\+`, String.raw`\(a\)\1`, String.raw`a\{1,3\}`, String.raw`a\|ab`, String.raw`\<word\>`, String.raw`\w\+`, "a\nb", "a\n", "[", "\\", String.raw`\(a`, String.raw`a\)`, String.raw`a\{2,1\}`, String.raw`\q`, String.raw`\b*`],
  E: ["", "a", "ab", "foo", "word", "@", "a+", "a?", "a|ab", "(ab)+", "(a)\\1", "a{1,3}", "^a", "a$", "a.*b", ".", "^.$", "^.*$", "[ab]", "[^b]", "[a-z]", "[[:digit:]]", String.raw`a\+b`, String.raw`\<word\>`, "a\nb", "a\n", "[", "\\", "(", ")", "a{2,1}", "a++", "(?=a)", String.raw`\q`],
  F: ["", "a", "ab", "foo", "word", "@", "a+b", "a?b", "a|b", "(a)", "a{2}", "^a", "a$", "[ab]", "[", "\\", "i", "k", "é", "α", "a\nb", "a\n", ["a", "ab"], ["ab", "a"], ["foo", "bar"], ["a", "a"]],
  P: ["", "a", "ab", "foo", "word", "@", "a+?", "a|ab", "(ab)+", "(a)\\1", "(?<=a)b", "(?=a)a", "a(?!b)", "^a", "a$", "a.*b", ".", "^.$", "^.*$", String.raw`\d`, String.raw`\w`, String.raw`\C`, "[ab]", "a\nb", "a\na", "[", "\\", "(", "(?bad)", "a{2,1}", ["a", "ab"]],
};
const FAMILIES = Object.entries(PATTERNS).flatMap(([mode, values]) => values.map((value) => ({ mode, patterns: Array.isArray(value) ? value : [value] })));
const MODE_NAMES = { G: "basic", E: "extended", F: "fixed", P: "perl" };
const BASE_RG = ["--no-config", "--text", "--no-heading", "--color", "never", "--no-filename", "--no-line-number"];
const CORPUS_DIRECTORY = mkdtempSync(join(tmpdir(), "grep-matcher-campaign-"));
const CORPUS_PATHS = new Map();
after(() => rmSync(CORPUS_DIRECTORY, { recursive: true, force: true }));

function run(program, args, input, env) {
  // A regex syntax error may close a pipe before spawnSync writes its input,
  // yielding host-side EPIPE instead of the program's real diagnostic result.
  // These operator cases need a finite corpus, not pipe-position qualification:
  // use file-backed stdin without changing argv, and preserve every exit/error.
  const key = input.toString("hex");
  if (!CORPUS_PATHS.has(key)) {
    const path = join(CORPUS_DIRECTORY, String(CORPUS_PATHS.size));
    writeFileSync(path, input); CORPUS_PATHS.set(key, path);
  }
  const fd = openSync(CORPUS_PATHS.get(key), "r");
  try {
    const result = spawnSync(program, args, { stdio: [fd, "pipe", "pipe"], env, timeout: 3_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined, `${program} execution failed: ${result.error?.message}`);
    assert.equal(result.signal, null, `${program} timed out or was signalled`);
    return result;
  } finally { closeSync(fd); }
}
function summary(result) { return { status: result.status, stdoutHex: result.stdout.toString("hex"), stderr: result.stderr.toString() }; }
function makeArgv(family, flags) { return ["-a", `-${family.mode}`, ...flags, ...family.patterns.flatMap((value) => ["-e", value])]; }

function runQualified(selected, subject, env) {
  if (!selected.options.onlyMatching) return run("rg", selected.args, subject, env);
  // Production consumes JSON submatches, not rg's native -o text. GNU suppresses
  // empty match fragments while still reporting that their line was selected.
  // Exercise that actual component boundary rather than inventing a fallback
  // for a difference already repaired by the presentation adapter.
  const raw = run("rg", [...selected.args, "--json"], subject, env);
  const stdout = [], stderr = [];
  const formatter = createGrepFormatter(selected.options, {
    env, stdout: (bytes) => stdout.push(bytes), stderr: (bytes) => stderr.push(bytes),
  });
  formatter.registerFile("<stdin>", { stdin: true, size: subject.length });
  for (const line of raw.stdout.toString().split("\n")) if (line) formatter.event(JSON.parse(line));
  const result = formatter.finish();
  return { status: raw.status > 1 ? raw.status : result.status, stdout: Buffer.concat(stdout), stderr: Buffer.concat([raw.stderr, ...stderr]) };
}

async function route(family, flags, env, cache) {
  const argv = makeArgv(family, flags), key = JSON.stringify([argv, env.LC_ALL]);
  if (cache.has(key)) return cache.get(key);
  const options = parseGrepOptions(argv, { env });
  const patterns = await resolveGrepPatterns(options, () => { throw new Error("campaign never reads pattern files"); });
  const reasons = grepMatcherFallbackReasons(options, { env });
  let args;
  if (!reasons.length) {
    try {
      args = [...BASE_RG, ...buildGrepMatcherArgs(options, patterns, { env })];
    } catch (error) { reasons.push(`matcher construction requires GNU diagnostics: ${error.message}`); }
    if (!reasons.length) {
      // Production performs this same preflight before reading a subject. GNU
      // supplies diagnostics when rg/PCRE2 cannot compile otherwise valid argv.
      // Execution failures/timeouts must fail this test, not become fallback.
      const compiled = run("rg", args, Buffer.alloc(0), env);
      if (compiled.status > 1) reasons.push("PCRE2 compilation requires GNU diagnostics");
    }
  }
  const result = { options, argv, args, reasons };
  cache.set(key, result);
  return result;
}

function requireSpecifiedFallback(family, flags, env, reasons) {
  const distinct = new Set(family.patterns.flatMap((value) => value.split("\n"))).size;
  const mustUseNative = (env.LC_ALL !== "C" && (family.mode === "P" || flags.includes("-i") || flags.includes("-w"))) ||
    (flags.includes("-o") && (["G", "E"].includes(family.mode) || (family.mode === "F" && distinct > 1))) ||
    (family.mode === "P" && distinct > 1);
  if (mustUseNative) assert.ok(reasons.length, `unqualified semantics selected rg: ${JSON.stringify({ family, flags, locale: env.LC_ALL })}`);
}

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function decode(index) {
  const subject = SUBJECTS[index % SUBJECTS.length]; index = Math.floor(index / SUBJECTS.length);
  const env = ENVIRONMENTS[index % ENVIRONMENTS.length]; index = Math.floor(index / ENVIRONMENTS.length);
  const flags = FLAGS[index % FLAGS.length]; index = Math.floor(index / FLAGS.length);
  return { family: FAMILIES[index], flags, env, subject };
}

test("regression: early invalid-PCRE rejection retains native exit and diagnostics", () => {
  const result = run("/usr/bin/grep", ["-a", "-P", "-o", "-i", "-e", "(?bad)"], SUBJECTS[2], ENVIRONMENTS[0]);
  assert.equal(result.status, 2);
  assert.deepEqual(result.stdout, Buffer.alloc(0));
  assert.ok(result.stderr.length > 0, "native PCRE rejection must retain its diagnostic");
});

test("seeded matcher differential campaign with independent GNU oracle", { timeout: DEEP ? 180_000 : 60_000 }, async (t) => {
  const pool = FAMILIES.length * FLAGS.length * ENVIRONMENTS.length * SUBJECTS.length;
  assert.ok(pool >= TARGET);
  let step = (SEED % pool) | 1;
  while (gcd(step, pool) !== 1) step += 2;
  const seen = new Set(), cache = new Map(), failures = [];
  const counts = { seed: `0x${SEED.toString(16)}`, deep: DEEP, distinctCases: 0, qualifiedRgComparisons: 0, jsonFormatterComparisons: 0, nativeFallbackOracles: 0, preflightConfigurations: 0, modes: {}, locales: {}, flagCoverage: {}, byteFixtures: new Set() };
  for (let i = 0; i < TARGET; i++) {
    const poolIndex = (SEED + i * step) % pool;
    const { family, flags, env, subject } = decode(poolIndex);
    const key = JSON.stringify([family, flags, env.LC_ALL, subject.toString("hex")]);
    assert.equal(seen.has(key), false, `duplicate logical case at ${i}`); seen.add(key);
    const selected = await route(family, flags, env, cache);
    requireSpecifiedFallback(family, flags, env, selected.reasons);
    const expected = run("/usr/bin/grep", selected.argv, subject, env);
    const label = { seed: counts.seed, index: i, poolIndex, argv: selected.argv, locale: env.LC_ALL, subjectHex: subject.toString("hex") };
    if (selected.reasons.length) {
      // No rg-equality credit for a case intentionally delegated to GNU. Ensure
      // the original pattern text/flags remain unchanged at the native boundary.
      assert.deepEqual(selected.argv, makeArgv(family, flags));
      assert.ok([0, 1, 2].includes(expected.status), JSON.stringify({ ...label, GNU: summary(expected) }));
      counts.nativeFallbackOracles++;
    } else {
      const actual = runQualified(selected, subject, env);
      const evidence = JSON.stringify({ ...label, rgArgs: selected.args, GNU: summary(expected), rg: summary(actual) });
      if (actual.status !== expected.status || !actual.stdout.equals(expected.stdout) || !actual.stderr.equals(expected.stderr)) {
        if (failures.length < 12) failures.push(JSON.parse(evidence));
        counts.mismatches = (counts.mismatches ?? 0) + 1;
      }
      counts.qualifiedRgComparisons++;
      if (selected.options.onlyMatching) counts.jsonFormatterComparisons++;
    }
    counts.distinctCases++;
    counts.modes[MODE_NAMES[family.mode]] = (counts.modes[MODE_NAMES[family.mode]] ?? 0) + 1;
    counts.locales[env.LC_ALL] = (counts.locales[env.LC_ALL] ?? 0) + 1;
    for (const flag of flags) counts.flagCoverage[flag] = (counts.flagCoverage[flag] ?? 0) + 1;
    counts.byteFixtures.add(subject.toString("hex"));
  }
  counts.preflightConfigurations = cache.size;
  counts.byteFixtures = counts.byteFixtures.size;
  assert.equal(counts.distinctCases, TARGET); assert.ok(counts.qualifiedRgComparisons > TARGET / 5);
  assert.ok(counts.nativeFallbackOracles > TARGET / 5);
  assert.deepEqual(Object.keys(counts.modes).sort(), Object.values(MODE_NAMES).sort());
  assert.equal(counts.byteFixtures, SUBJECTS.length);
  t.diagnostic(JSON.stringify({ ...counts, GNU: run("/usr/bin/grep", ["--version"], Buffer.alloc(0), ENVIRONMENTS[0]).stdout.toString().split("\n")[0], rg: run("rg", ["--version"], Buffer.alloc(0), ENVIRONMENTS[0]).stdout.toString().split("\n")[0], optionsSHA256: createHash("sha256").update(readFileSync(new URL("../src/grep-options.mjs", import.meta.url))).digest("hex") }));
  assert.deepEqual(failures, [], JSON.stringify({ mismatches: counts.mismatches ?? 0, firstFailures: failures }));
});

test("regression: NUL-record whole-line matching cannot stop at an internal newline", async () => {
  const subject = Buffer.from("\na\n"), family = { mode: "E", patterns: ["a"] }, flags = ["-z", "-x"], env = ENVIRONMENTS[0];
  const selected = await route(family, flags, env, new Map());
  const expected = run("/usr/bin/grep", selected.argv, subject, env);
  assert.equal(expected.status, 1); assert.deepEqual(expected.stdout, Buffer.alloc(0));
  if (!selected.reasons.length) {
    const actual = run("rg", selected.args, subject, env);
    assert.equal(actual.status, expected.status); assert.deepEqual(actual.stdout, expected.stdout);
  }
});

test("regression: empty -o fragments select records but emit no GNU output", async () => {
  const env = ENVIRONMENTS[0];
  for (const [mode, pattern, subject] of [
    ["P", "^.*$", Buffer.from("\n")],
    ["F", "", Buffer.from("a\r\nab\r\nfoo\r\n")],
    ["F", "", Buffer.from("foo\na\nab")],
  ]) {
    const selected = await route({ mode, patterns: [pattern] }, ["-o", "-i"], env, new Map());
    assert.deepEqual(selected.reasons, []);
    const expected = run("/usr/bin/grep", selected.argv, subject, env);
    const actual = runQualified(selected, subject, env);
    assert.equal(expected.status, 0); assert.deepEqual(expected.stdout, Buffer.alloc(0));
    assert.equal(actual.status, expected.status); assert.deepEqual(actual.stdout, expected.stdout);
    const nativeRg = run("rg", [...selected.args, "--only-matching"], subject, env);
    assert.notDeepEqual(nativeRg.stdout, expected.stdout, "fixture must retain the real native -o presentation difference");
  }
});

test("regression: NUL-record regex anchors and dot route before internal newlines are read", async () => {
  const env = ENVIRONMENTS[0];
  for (const mode of ["G", "E", "P"]) for (const pattern of ["^a$", ".", String.raw`a\b`]) {
    const selected = await route({ mode, patterns: [pattern] }, ["-z"], env, new Map());
    assert.match(selected.reasons.join(" "), /NUL-record/);
  }
  for (const flags of [["-z", "-x"], ["-z", "-w"]]) {
    const selected = await route({ mode: "F", patterns: ["a"] }, flags, env, new Map());
    assert.match(selected.reasons.join(" "), /NUL-record/);
  }
  const selected = await route({ mode: "F", patterns: ["a"] }, ["-z"], env, new Map());
  assert.deepEqual(selected.reasons, []);
  for (const subject of [Buffer.from("\na\n"), Buffer.from("a\0b\0"), Buffer.from("a\nb\0")]) {
    const expected = run("/usr/bin/grep", selected.argv, subject, env);
    const actual = run("rg", selected.args, subject, env);
    assert.equal(actual.status, expected.status); assert.deepEqual(actual.stdout, expected.stdout);
  }
});

test("duplicate pattern metamorphism preserves selected output across all matcher modes", async (t) => {
  const env = ENVIRONMENTS[0], subject = Buffer.from("ab\na\nab ab\nfoo\n\n");
  let comparisons = 0;
  for (const mode of Object.keys(MODE_NAMES)) for (const pattern of ["", "a", "ab", "foo", "^a", "a$"]) for (const flags of [[], ["-v"], ["-x"], ["-i"]]) {
    const single = { mode, patterns: [pattern] }, duplicate = { mode, patterns: [pattern, pattern] };
    const original = run("/usr/bin/grep", makeArgv(single, flags), subject, env);
    const repeated = run("/usr/bin/grep", makeArgv(duplicate, flags), subject, env);
    assert.equal(repeated.status, original.status); assert.deepEqual(repeated.stdout, original.stdout);
    const selected = await route(duplicate, flags, env, new Map());
    if (!selected.reasons.length) {
      const actual = run("rg", selected.args, subject, env);
      assert.equal(actual.status, original.status); assert.deepEqual(actual.stdout, original.stdout);
      comparisons++;
    }
  }
  t.diagnostic(`96 GNU duplicate-pattern metamorphisms; ${comparisons} independently checked rg comparisons.`);
});
