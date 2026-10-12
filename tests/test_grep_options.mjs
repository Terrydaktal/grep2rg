import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  buildGrepMatcherArgs, grepLongOptionNames, grepMatcherFallbackReasons,
  parseGrepOptions, resolveGrepPatterns, translateGrepPattern,
} from "../src/grep-options.mjs";

const env = { ...process.env, LC_ALL: "C", LANG: "C" };
const parse = (argv, extra = {}) => parseGrepOptions(argv, { env: { ...env, ...extra } });
const run = (program, args, input, processEnv = env, argv0) => {
  const result = spawnSync(program, args, { input, env: processEnv, argv0, timeout: 5_000, maxBuffer: 256 * 1024 });
  assert.equal(result.error, undefined, `${program}: ${result.error?.message}`);
  assert.equal(result.signal, null, `${program} timed out or was signalled`);
  return result;
};

test("parser inventories every long option shown by actual GNU grep help", () => {
  const help = run("/usr/bin/grep", ["--help"]).stdout.toString();
  const options = [...help.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]);
  for (const option of options) assert.ok(grepLongOptionNames.includes(option), option);
});

test("joined flags and ordered values have separate GNU meanings", () => {
  const p = parse(["-nrHivwxoZcT", "-A2", "-B", "3", "-C0", "-m+4", "-efoo", "-fpatterns", "one", "two"]);
  assert.deepEqual(p.errors, []);
  assert.equal(p.recursive, true); assert.equal(p.devices, "skip");
  assert.equal(p.filename, true); assert.equal(p.ignoreCase, true);
  for (const field of ["lineNumber", "invertMatch", "wordRegexp", "lineRegexp", "onlyMatching", "nullNames", "count", "initialTab", "contextRequested"]) assert.equal(p[field], true, field);
  assert.equal(p.beforeContext, 3); assert.equal(p.afterContext, 2); assert.equal(p.maxCount, 4);
  assert.deepEqual(p.patternSources, [{ type: "regexp", value: "foo" }, { type: "file", value: "patterns" }]);
  assert.deepEqual(p.paths, ["one", "two"]);
});

test("long abbreviations, optional color argument and overrides match getopt contracts", () => {
  const p = parse(["--ign", "--no-ignore-c", "--colo", "--reg=abc", "--line-n", "--group-sep=", "--binary-f=text", "--label=pipe", "--line-buffered", "--files-without-m", "--files-with-m", "--initial-t", "--null-d", "--binary", "--no-mess", "--silent", "file"]);
  assert.deepEqual(p.errors, []); assert.equal(p.ignoreCase, false);
  assert.equal(p.color, "auto"); assert.equal(p.binary, "text"); assert.equal(p.label, "pipe");
  assert.equal(p.lineBuffered, true); assert.equal(p.filesMode, "with"); assert.equal(p.groupSeparator, "");
  assert.equal(p.nullData, true); assert.equal(p.binaryMode, true); assert.equal(p.silent, true); assert.equal(p.quiet, true);
  assert.deepEqual(p.patternSources, [{ type: "regexp", value: "abc" }]);
  assert.deepEqual(p.paths, ["file"]);
  assert.match(parse(["--no", "abc"]).errors.join(" "), /ambiguous/);
});

test("GNU option permutation, POSIXLY_CORRECT and -- keep operand identities", () => {
  assert.equal(parse(["abc", "file", "-n"]).lineNumber, true);
  const posix = parse(["abc", "file", "-n"], { POSIXLY_CORRECT: "1" });
  assert.equal(posix.lineNumber, false); assert.deepEqual(posix.paths, ["file", "-n"]);
  const dashed = parse(["--", "-pattern", "-n"]);
  assert.deepEqual(dashed.patternSources, [{ type: "regexp", value: "-pattern" }]);
  assert.deepEqual(dashed.paths, ["-n"]);
  assert.equal(parse(["-1n2", "abc"]).afterContext, 2);
});

test("an empty POSIXLY_CORRECT environment variable still disables permutation", () => {
  const processEnv = { ...env, POSIXLY_CORRECT: "" };
  const options = parseGrepOptions(["abc", "-n"], { env: processEnv });
  assert.equal(options.lineNumber, false); assert.deepEqual(options.paths, ["-n"]);
  const native = run("/usr/bin/grep", ["abc", "-n"], undefined, processEnv);
  assert.equal(native.status, 2); assert.match(native.stderr.toString(), /-n: No such file/);
  const normalEnv = { ...env }; delete normalEnv.POSIXLY_CORRECT;
  const normal = run("/usr/bin/grep", ["abc", "-n"], "abc\n", normalEnv);
  assert.equal(normal.status, 0); assert.equal(normal.stdout.toString(), "1:abc\n");
});

test("numeric arguments beyond exact JS integers select original GNU argv", () => {
  for (const flag of ["-m", "-A", "-B", "-C"]) {
    for (const value of ["9007199254740992", "18446744073709551616"]) {
      const options = parse([flag, value, "abc"]);
      assert.equal(options.numericNative, true); assert.deepEqual(options.errors, []);
      assert.match(grepMatcherFallbackReasons(options, { env }).join(" "), /exact JavaScript integer/);
      const native = run("/usr/bin/grep", [flag, value, "abc"], "abc\n");
      assert.equal(native.status, 0); assert.equal(native.stdout.toString(), "abc\n");
    }
  }
  const exact = parse(["-m9007199254740991", "abc"]);
  assert.equal(exact.numericNative, false); assert.equal(exact.maxCount, Number.MAX_SAFE_INTEGER);
});

test("regression: explicit before/after context overrides later generic context", async () => {
  const fixture = Buffer.from("n0\nn1\nfoo\nn3\nn4\nn5\nfoo\nn7\nn8\n");
  const cases = [
    [["-B0", "-C2"], 0, 2], [["-A0", "-C2"], 2, 0],
    [["-C2", "-B0"], 0, 2], [["-C2", "-A0"], 2, 0],
    [["-A1", "-C3", "-B0"], 0, 1], [["-C2", "-A1", "-C3"], 3, 1],
    [["-B1", "-2"], 1, 2], [["-A0", "-2"], 2, 0],
    [["-A1", "-A0", "-C3"], 3, 0], [["-B3", "-C1", "-B0", "-C2"], 0, 2],
    [["--before-context=0", "--context=2"], 0, 2],
  ];
  for (const [flags, before, after] of cases) {
    const argv = ["-a", ...flags, "-e", "foo"], options = parse(argv);
    assert.deepEqual(options.errors, []);
    assert.equal(options.beforeContext, before, `${flags}: before context`);
    assert.equal(options.afterContext, after, `${flags}: after context`);
    const patterns = await resolveGrepPatterns(options, () => { throw new Error("unexpected pattern file"); });
    const expected = run("/usr/bin/grep", argv, fixture);
    const actual = run("rg", ["--no-config", "--text", "--color", "never", ...buildGrepMatcherArgs(options, patterns, { env }), "--before-context", String(options.beforeContext), "--after-context", String(options.afterContext)], fixture);
    assert.equal(actual.status, expected.status, JSON.stringify(flags));
    assert.deepEqual(actual.stdout, expected.stdout, JSON.stringify(flags));
  }
});

test("regression: numeric short clusters keep only the last contiguous digit run", () => {
  const fixture = Buffer.from("0\n1\n2\n3\nfoo\n5\n6\n7\n8\n9\n");
  const wrapper = new URL("../src/grep-wrapper.mjs", import.meta.url);
  const cases = [
    [["-1n2"], 2, 2], [["-n2b3"], 3, 3], [["-1n2b3"], 3, 3],
    [["-123"], 123, 123], [["-12n"], 12, 12], [["-2n12"], 12, 12],
    [["-1n2", "-A0"], 2, 0], [["-B0", "-1n2"], 0, 2],
    [["-2nB0"], 0, 2], [["-1C2"], 2, 2], [["-1m2"], 1, 1],
  ];
  for (const [flags, before, after] of cases) {
    const argv = ["-a", ...flags, "-e", "foo"], options = parse(argv);
    assert.deepEqual(options.errors, [], JSON.stringify(flags));
    assert.equal(options.beforeContext, before, `${flags}: before context`);
    assert.equal(options.afterContext, after, `${flags}: after context`);
    const expected = run("/usr/bin/grep", argv, fixture);
    const actual = run(process.execPath, [wrapper.pathname, ...argv], fixture);
    assert.equal(actual.status, expected.status, JSON.stringify(flags));
    assert.deepEqual(actual.stdout, expected.stdout, JSON.stringify(flags));
    assert.deepEqual(actual.stderr, expected.stderr, JSON.stringify(flags));
  }
  // A required-value flag consumes the complete remaining suffix; b3/n are
  // not new flags after B/m. Preserve the original GNU diagnostic, too.
  for (const flags of [["-2B0b3"], ["-2m1n"]]) {
    const argv = ["-a", ...flags, "-e", "foo"], options = parse(argv);
    assert.ok(options.errors.length, JSON.stringify(flags));
    const expected = run("/usr/bin/grep", argv, undefined, env, "grep");
    const actual = run(process.execPath, [wrapper.pathname, ...argv]);
    assert.equal(expected.status, 2); assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, expected.stdout); assert.deepEqual(actual.stderr, expected.stderr);
  }
});

test("regression: fixed -w -x -o preserves installed GNU extraction behavior", () => {
  const fixture = Buffer.from("bar\nfoo\nbaz\nfoo bar\nfoo\nend\n");
  const argv = ["-a", "-F", "-w", "-x", "-o", "-e", "foo"];
  assert.deepEqual(grepMatcherFallbackReasons(parse(argv), { env }), []);
  const expected = run("/usr/bin/grep", argv, fixture);
  const wrapper = new URL("../src/grep-wrapper.mjs", import.meta.url);
  const actual = run(process.execPath, [wrapper.pathname, ...argv], fixture);
  assert.equal(actual.status, expected.status); assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
  for (const flags of [["-w", "-x"], ["-w", "-o"], ["-x", "-o"]])
    assert.deepEqual(grepMatcherFallbackReasons(parse(["-a", "-F", ...flags, "foo"]), { env }), [], JSON.stringify(flags));
  assert.deepEqual(grepMatcherFallbackReasons(parse(["-a", "-P", "-w", "-x", "-o", "foo"]), { env }), []);
});

test("every output and traversal option is retained without rendering it", () => {
  const p = parse(["-R", "-Dread", "-dskip", "-a", "-I", "--binary-files=binary", "-h", "-H", "-L", "--include=*.c", "--exclude=x*", "--exclude-dir=build", "--exclude-from=skip", "--no-group-separator", "--color=always", "-b", "-s", "-z", "abc", "."]);
  assert.deepEqual(p.errors, []); assert.equal(p.recursive, false); assert.equal(p.follow, true);
  assert.equal(p.devices, "read"); assert.equal(p.directories, "skip"); assert.equal(p.binary, "binary");
  assert.equal(p.filename, true); assert.equal(p.filesMode, "without"); assert.equal(p.groupSeparator, null);
  assert.equal(p.color, "always"); assert.equal(p.byteOffset, true);
  assert.deepEqual(p.filters, [{ type: "include", value: "*.c" }, { type: "exclude", value: "x*" }, { type: "exclude-dir", value: "build" }, { type: "exclude-file", value: "skip" }]);
  assert.equal(parse(["-R", "abc"]).devices, "read");
  assert.equal(parse(["-r", "abc"]).devices, "skip");
});

test("parser errors cover missing, conflicting, unknown and invalid option values", () => {
  for (const argv of [["-e"], ["--regexp"], ["-Q", "a"], ["--wat", "a"], ["--line-number=yes", "a"], ["-mno", "a"], ["-C-2", "a"], ["-FE", "a"], ["-dwat", "a"], ["-Dwat", "a"], ["--binary-files=wat", "a"], []]) {
    assert.ok(parse(argv).errors.length, JSON.stringify(argv));
    // These calls reject argv before reading stdin. Supplying unused fixture
    // bytes can race that early exit and yield harness-side EPIPE on Node.
    assert.equal(run("/usr/bin/grep", argv).status > 0, true, JSON.stringify(argv));
  }
  assert.equal(parse(["--help"]).help, true); assert.deepEqual(parse(["--help"]).errors, []);
  assert.equal(parse(["-V"]).version, true); assert.deepEqual(parse(["-V"]).errors, []);
  assert.equal(parse(["--color=wat", "a"]).help, true);
  assert.equal(parse(["-m18446744073709551616", "a"]).maxCount, Number.MAX_SAFE_INTEGER);
});

test("regexp newline and pattern-file newline rules remain distinct", async () => {
  const p = parse(["-e", "a\n", "-f", "empty", "-f", "patterns", "-f", "-", "file"]);
  const reads = [];
  const patterns = await resolveGrepPatterns(p, async (file) => {
    reads.push(file); return { empty: Buffer.alloc(0), patterns: Buffer.from("b\nc\n"), "-": Buffer.from("d\n\n") }[file];
  });
  assert.deepEqual(reads, ["empty", "patterns", "-"]);
  assert.deepEqual(patterns, ["a", "", "b", "c", "d"]);
  assert.deepEqual(await resolveGrepPatterns(parse(["-f", "empty"]), async () => ""), []);
  await assert.rejects(resolveGrepPatterns(parse(["-f", "missing"]), readFile), { code: "ENOENT" });
});

const input = Buffer.from("abc\nabcc\na+b\na?b\n(a)\na{2}\na|b\naa\nabab\nword\nsword\nword_end\n@\nx@y\na^b\na$b\n*\n[\\d]\nabc123\n\n");
const cases = [
  ["basic literal plus", ["a+b"]], ["basic literal question", ["a?b"]],
  ["basic literal parentheses", ["(a)"]], ["basic literal braces", ["a{2}"]],
  ["basic literal pipe", ["a|b"]], ["basic alternation", [String.raw`abc\|word`]],
  ["basic grouping repetition", [String.raw`\(ab\)\+`]], ["basic backreference", [String.raw`\(ab\)\1`]],
  ["basic interval", [String.raw`a\{2,3\}`]], ["basic internal caret", ["a^b"]],
  ["basic internal dollar", ["a$b"]], ["basic leading star", ["*"]],
  ["basic whole-line anchor", ["^abc$"]], ["basic POSIX digits", ["[[:digit:]]"]],
  ["basic repeated caret becomes literal", ["^^a"], Buffer.from("a\n^a\n^^a\n")],
  ["basic bracket backslash", [String.raw`[\d]`]], ["GNU word start/end", [String.raw`\<word\>`]],
  ["GNU word class", [String.raw`\w\+`]], ["GNU whitespace class", [String.raw`\s`]],
  ["ERE alternation", ["-E", "abc|word"]], ["ERE repetition", ["-E", "(ab)+"]],
  ["ERE literal escaped plus", ["-E", String.raw`a\+b`]],
  ["ERE backreference", ["-E", String.raw`(ab)\1`]],
  ["fixed metacharacters", ["-F", "a+b"]], ["fixed only matching", ["-Fo", "ab"]],
  ["fixed ignore case", ["-Fi", "WORD"]], ["fixed nonword word boundary", ["-Fw", "@"]],
  ["fixed whole line", ["-Fx", "abc"]], ["fixed multiline OR", ["-F", "abc\nword"]],
  ["empty pattern", [""]], ["inverted match", ["-v", "abc"]],
  ["PCRE lookbehind", ["-P", "(?<=a)b"]], ["PCRE only matching", ["-Po", "a+?"]],
  ["NUL records", ["-z", "abc"], Buffer.from("abc\ndef\0word\0")],
];
for (const [name, argv, fixture = input] of cases) {
  test(`independent GNU matching oracle: ${name}`, async () => {
    const options = parse(argv);
    const patterns = await resolveGrepPatterns(options, async () => { throw new Error("unexpected file read"); });
    const translated = ["--no-config", "--text", "--no-heading", "--color", "never", "--no-filename", "--no-line-number", ...buildGrepMatcherArgs(options, patterns, { env })];
    if (options.onlyMatching) translated.push("--only-matching");
    const expected = run("/usr/bin/grep", ["-a", ...argv], fixture);
    const actual = run("rg", translated, fixture);
    assert.equal(actual.status, expected.status, `${name}: ${actual.stderr.toString()}`);
    assert.deepEqual(actual.stdout, expected.stdout, name);
  });
}

test("no patterns and inverted no-pattern matching agree with GNU empty pattern file", async () => {
  for (const invert of [false, true]) {
    const options = parse(["-F", ...(invert ? ["-v"] : []), "-f", "/dev/null"]);
    const patterns = await resolveGrepPatterns(options, readFile);
    const expected = run("/usr/bin/grep", ["-a", "-F", ...(invert ? ["-v"] : []), "-f", "/dev/null"], input);
    const actual = run("rg", ["--no-config", "--text", ...buildGrepMatcherArgs(options, patterns, { env })], input);
    assert.equal(actual.status, expected.status); assert.deepEqual(actual.stdout, expected.stdout);
  }
});

test("fallback decision precedes any pattern-file or stdin consumption", () => {
  const p = parse(["-f", "-", "-e", "abc"]);
  assert.match(grepMatcherFallbackReasons(p, { env }).join(" "), /pattern-file/);
  assert.deepEqual(p.patternSources, [{ type: "file", value: "-" }, { type: "regexp", value: "abc" }]);
});

test("unqualified GNU regex diagnostics and leftmost-longest cases select fallback", () => {
  for (const argv of [["-Eo", "a|ab"], [String.raw`a\{`], [String.raw`\(a`], [String.raw`a\)`], ["["], [String.raw`\q`], ["-E", "a**"], ["-E", "(?=a)"], ["-E", "a{99999}"], [String.raw`\(a\)\10`], ["[a[=b=]]"]]) {
    assert.ok(grepMatcherFallbackReasons(parse(argv), { env }).length, JSON.stringify(argv));
  }
  const longest = run("/usr/bin/grep", ["-Eo", "a|ab"], "ab\n");
  const first = run("rg", ["--pcre2", "-o", "a|ab"], "ab\n");
  assert.equal(longest.stdout.toString(), "ab\n"); assert.equal(first.stdout.toString(), "a\n");
});

test("UTF-8 libc case-fold and Perl digit differences select fallback", () => {
  const utf8 = { ...env, LC_ALL: "C.UTF-8" };
  for (const argv of [["-i", "i"], ["-Fi", "k"], ["-w", "word"], ["[a-z]"], ["-P", String.raw`\d`]]) {
    assert.ok(grepMatcherFallbackReasons(parseGrepOptions(argv, { env: utf8 }), { env: utf8 }).length, JSON.stringify(argv));
  }
  const expected = run("/usr/bin/grep", ["-ai", "i"], "ı\n", utf8);
  const different = run("rg", ["--text", "--pcre2", "--ignore-case", "i"], "ı\n", utf8);
  assert.equal(expected.status, 0); assert.equal(different.status, 1);
});

test("overlapping fixed extraction and forced highlights use GNU longest selection", () => {
  for (const argv of [["-Fo", "-e", "a", "-e", "ab"], ["-F", "--color=always", "-e", "a", "-e", "ab"], ["-E", "--color=always", "a|ab"], ["--color=always", String.raw`a\|ab`]]) {
    assert.match(grepMatcherFallbackReasons(parse(argv), { env }).join(" "), /leftmost-longest/);
  }
  assert.deepEqual(grepMatcherFallbackReasons(parse(["-Fo", "-e", "a", "-e", "a"]), { env }), []);
  const expected = run("/usr/bin/grep", ["-aFo", "-e", "a", "-e", "ab"], "ab\n");
  const different = run("rg", ["--text", "--fixed-strings", "--only-matching", "-e", "a", "-e", "ab"], "ab\n");
  assert.equal(expected.stdout.toString(), "ab\n"); assert.equal(different.stdout.toString(), "a\n");
});

test("invalid UTF-8 retains GNU BRE/ERE selection and C-locale Perl byte output", () => {
  const utf8 = { ...env, LC_ALL: "C.UTF-8" };
  const fixtures = [Buffer.from([0xff, 10]), Buffer.from([97, 0xff, 99, 10]), Buffer.from([97, 98, 99, 0xff, 10]), Buffer.from([0xc3, 0xa9, 0xff, 10]), Buffer.from([0xc0, 0xaf, 10]), Buffer.from([0xed, 0xa0, 0x80, 10])];
  for (const [mode, processEnv] of [["-G", utf8], ["-E", utf8], ["-P", env]]) for (const pattern of [".", "^.$", "a.c", "a.*c", "^.*$", "abc", "^a.*"]) {
    const options = parseGrepOptions([mode, pattern], { env: processEnv });
    assert.deepEqual(grepMatcherFallbackReasons(options, { env: processEnv }), []);
    for (const fixture of fixtures) {
      const expected = run("/usr/bin/grep", ["-a", mode, pattern], fixture, processEnv);
      const actual = run("rg", ["--no-config", "--text", ...buildGrepMatcherArgs(options, [pattern], { env: processEnv })], fixture, processEnv);
      const label = `${mode}/${pattern}/${fixture.toString("hex")}`;
      assert.equal(actual.status, expected.status, `${label}: ${actual.stderr.toString()}`);
      assert.deepEqual(actual.stdout, expected.stdout, label);
      assert.deepEqual(actual.stderr, Buffer.alloc(0), label);
    }
  }
});

test("UTF-8 Perl selects GNU before subject bytes can expose release-specific differences", () => {
  const utf8 = { ...env, LC_ALL: "C.UTF-8" };
  for (const pattern of ["^.*$", "(?<=a)b", ".", "literal"]) {
    const options = parseGrepOptions(["-aP", pattern], { env: utf8 });
    assert.match(grepMatcherFallbackReasons(options, { env: utf8 }).join(" "), /malformed UTF-8 behavior/);
    assert.deepEqual(grepMatcherFallbackReasons(parse(["-aP", pattern]), { env }), []);
  }
});

test("qualified ordinary C-locale matching has no speculative fallback reason", () => {
  for (const argv of [["-F", "path/to/file"], ["-i", "abc"], [String.raw`\(ab\)\+`], ["-E", "(abc|def)+"], ["-P", "(?<=a)b"]])
    assert.deepEqual(grepMatcherFallbackReasons(parse(argv), { env }), [], JSON.stringify(argv));
});

test("regex conversion preserves escaped backslash parity", async () => {
  const patterns = [String.raw`a\\+`, String.raw`a\\\+`, String.raw`[\\+]`, String.raw`\(a\\\)\+`];
  for (const pattern of patterns) {
    const options = parse([pattern]);
    const actual = run("rg", ["--no-config", "--text", ...buildGrepMatcherArgs(options, [pattern], { env })], "a\\+\naa\\\na\\\\\n");
    const expected = run("/usr/bin/grep", ["-a", pattern], "a\\+\naa\\\na\\\\\n");
    assert.equal(actual.status, expected.status, pattern); assert.deepEqual(actual.stdout, expected.stdout, pattern);
  }
  assert.equal(translateGrepPattern("a+b", "basic"), String.raw`a\+b`);
});

test("seeded independent BRE/ERE grammar cases agree with GNU selection", () => {
  const fixture = Buffer.from(["", "a", "b", "c", "ab", "ba", "abc", "aab", "abb", "abab", "abcabc", "aaabbb", "a+b", "a?b", "a|b", "(ab)", "a{2}"].join("\n") + "\n");
  let seed = 0x6a726570;
  const next = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let index = 0; index < 96; index++) {
    const atom = ["a", "b", "ab", "[ab]", "."][next(5)];
    const tail = ["", "a", "b", "$"][next(4)];
    const choice = next(5);
    const ere = choice === 0 ? `${atom}${tail}` : choice === 1 ? `(${atom})+${tail}` : choice === 2 ? `(${atom}|c)${tail}` : choice === 3 ? `${atom}{1,2}${tail}` : `^(${atom})?${tail}`;
    // These grammar templates are independently written GNU BRE forms.
    const bre = choice === 0 ? `${atom}${tail}` : choice === 1 ? String.raw`\(${atom}\)\+${tail}` : choice === 2 ? String.raw`\(${atom}\|c\)${tail}` : choice === 3 ? String.raw`${atom}\{1,2\}${tail}` : String.raw`^\(${atom}\)\?${tail}`;
    for (const [matcher, pattern, mode] of [["extended", ere, "-E"], ["basic", bre, "-G"]]) {
      const options = parse([mode, pattern]);
      assert.deepEqual(grepMatcherFallbackReasons(options, { env }), [], `${index}: ${pattern}`);
      const expected = run("/usr/bin/grep", ["-a", mode, pattern], fixture);
      const actual = run("rg", ["--no-config", "--text", ...buildGrepMatcherArgs(options, [pattern], { env })], fixture);
      assert.equal(actual.status, expected.status, `${index}/${matcher}: ${pattern}: ${actual.stderr.toString()}`);
      assert.deepEqual(actual.stdout, expected.stdout, `${index}/${matcher}: ${pattern}`);
    }
  }
});
