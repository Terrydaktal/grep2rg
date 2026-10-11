import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGrepFormatter } from "../src/grep-output.mjs";

const baseEnv = { ...process.env, LC_ALL: "C", GREP_COLORS: "", GREP_COLOR: "", TERM: "xterm" };

function compare({ args, options = {}, text = Buffer.from("first\nfoo foo\nother\nlast\nfoo\nend"), second = Buffer.from("nothing\n"), stdin = false, env = {}, binary = false, pattern = "foo" }) {
  const directory = mkdtempSync(join(tmpdir(), "grep2rg-output-"));
  try {
    const first = join(directory, "first.txt"), last = join(directory, "last.txt");
    writeFileSync(first, text); if (second !== null) writeFileSync(last, second);
    const paths = stdin ? [] : second === null ? [first] : [first, last];
    const testEnv = { ...baseEnv, ...env }, stdout = [], stderr = [];
    const oracle = spawnSync("grep", [...args, pattern, ...paths], { env: testEnv, input: stdin ? text : undefined });
    assert.equal(oracle.error, undefined);
    const format = createGrepFormatter({ filename: !stdin && paths.length > 1, ...options }, { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), env: testEnv });
    if (stdin) format.registerFile("<stdin>", { stdin: true, binary });
    else for (const path of paths) format.registerFile(path, { size: statSync(path).size, binary });
    const rgArgs = ["--no-config", "--threads", "1", "--encoding", "none", "--text", "--json"];
    if (options.invertMatch) rgArgs.push("--invert-match");
    if (options.nullData) rgArgs.push("--null-data");
    if (options.beforeContext) rgArgs.push("--before-context", String(options.beforeContext));
    if (options.afterContext) rgArgs.push("--after-context", String(options.afterContext));
    if (options.maxCount !== undefined && options.maxCount !== null && options.maxCount > 0) rgArgs.push("--max-count", String(options.maxCount));
    const result = spawnSync("rg", [...rgArgs, pattern, ...paths], { env: testEnv, input: stdin ? text : undefined });
    assert.equal(result.error, undefined); assert.ok(result.status === 0 || result.status === 1, result.stderr.toString());
    for (const line of result.stdout.toString().split("\n")) if (line) format.event(JSON.parse(line));
    const actual = format.finish();
    assert.deepEqual(Buffer.concat(stdout), oracle.stdout, `stdout: ${args.join(" ")}`);
    assert.deepEqual(Buffer.concat(stderr), oracle.stderr, `stderr: ${args.join(" ")}`);
    assert.equal(actual.status, oracle.status, `status: ${args.join(" ")}`);
  } finally { rmSync(directory, { recursive: true }); }
}

test("GNU prefixes, fragments and unterminated records match ripgrep JSON presentation", () => {
  for (const [args, options] of [
    [[], {}], [["-n"], { lineNumber: true }], [["-b"], { byteOffset: true }],
    [["-H", "-n", "-b"], { filename: true, lineNumber: true, byteOffset: true }],
    [["-h", "-n"], { filename: false, lineNumber: true }],
    [["-o"], { onlyMatching: true }],
    [["-o", "-n", "-b"], { onlyMatching: true, lineNumber: true, byteOffset: true }],
    [["-T", "-H", "-n", "-b"], { initialTab: true, filename: true, lineNumber: true, byteOffset: true }],
    [["-Z", "-H", "-n"], { nullNames: true, filename: true, lineNumber: true }],
  ]) compare({ args, options });
});

test("GNU count, filenames, quiet and inverse statuses include zero-match operands", () => {
  for (const [args, options] of [
    [["-c"], { count: true }], [["-v", "-c"], { invertMatch: true, count: true }],
    [["-l"], { filesMode: "with" }], [["-L"], { filesMode: "without" }],
    [["-L", "-c"], { filesMode: "without", count: true }],
    [["-l", "-c", "-o"], { filesMode: "with", count: true, onlyMatching: true }],
    [["-q", "-c", "-L"], { quiet: true, count: true, filesMode: "without" }],
    [["-Z", "-L"], { nullNames: true, filesMode: "without" }],
    [["-Z", "-H", "-c"], { nullNames: true, filename: true, count: true }],
    [["-v", "-o"], { invertMatch: true, onlyMatching: true }],
    [["-m0", "-c"], { maxCount: 0, count: true }],
    [["-m0", "-L"], { maxCount: 0, filesMode: "without" }],
    [["-m1", "-c"], { maxCount: 1, count: true }],
  ]) compare({ args, options });
});

test("context markers, merged groups and custom separators match GNU", () => {
  for (const [args, options] of [
    [["-C1"], { contextRequested: true, beforeContext: 1, afterContext: 1 }],
    [["-C0"], { contextRequested: true }],
    [["-A1", "-B1", "-n", "-b"], { contextRequested: true, beforeContext: 1, afterContext: 1, lineNumber: true, byteOffset: true }],
    [["-C0", "--group-separator=next"], { contextRequested: true, groupSeparator: "next" }],
    [["-C0", "--no-group-separator"], { contextRequested: true, groupSeparator: null }],
    [["--group-separator=next"], { groupSeparator: "next" }],
    [["-o", "-C1"], { onlyMatching: true, contextRequested: true, beforeContext: 1, afterContext: 1 }],
    [["-m1", "-A2"], { maxCount: 1, contextRequested: true, afterContext: 2 }],
  ]) compare({ args, options, text: Buffer.from("foo\nfoo\na\nb\nc\nfoo\nlast"), second: Buffer.from("foo\nend") });
});

test("NUL records preserve their own line counts and byte offsets", () => {
  const text = Buffer.from("alpha\nfoo foo\0bar\0foo\nlast");
  for (const [args, options] of [
    [["-z"], { nullData: true }],
    [["-z", "-n", "-b", "-o"], { nullData: true, lineNumber: true, byteOffset: true, onlyMatching: true }],
    [["-z", "-C1", "-n"], { nullData: true, contextRequested: true, beforeContext: 1, afterContext: 1, lineNumber: true }],
    [["-z", "-c"], { nullData: true, count: true }],
  ]) compare({ args, options, text, second: null });
});

test("stdin labels and tab widths use GNU's streamed-input convention", () => {
  for (const [args, options] of [
    [["-H", "--label=data", "-n"], { filename: true, label: "data", lineNumber: true }],
    [["-T", "-n", "-b"], { initialTab: true, lineNumber: true, byteOffset: true }],
    [["-H", "-l", "--label=data"], { filename: true, label: "data", filesMode: "with" }],
  ]) compare({ args, options, stdin: true });
});

test("GNU color defaults and configurable match/prefix capabilities are preserved", () => {
  for (const [args, options, env] of [
    [["--color=always", "-H", "-n", "-b"], { color: "always", filename: true, lineNumber: true, byteOffset: true }, {}],
    [["--color=always", "-c", "-H"], { color: "always", count: true, filename: true }, {}],
    [["--color=always", "-C1"], { color: "always", contextRequested: true, beforeContext: 1, afterContext: 1 }, { GREP_COLORS: "mt=1;33:fn=34:ln=36:bn=35:se=31:ne" }],
    [["--color=always", "-C1"], { color: "always", contextRequested: true, beforeContext: 1, afterContext: 1 }, { GREP_COLORS: "sl=44:cx=42:ms=1;33:mc=1;35:ne" }],
    [["--color=always", "-v", "-C1"], { color: "always", invertMatch: true, contextRequested: true, beforeContext: 1, afterContext: 1 }, { GREP_COLORS: "sl=44:cx=42:rv:ne" }],
    [["--color=always", "-v", "-C1"], { color: "always", invertMatch: true, contextRequested: true, beforeContext: 1, afterContext: 1 }, { GREP_COLOR: "33" }],
    [["--color=always"], { color: "always" }, { GREP_COLOR: "33", GREP_COLORS: "mt=34" }],
    [["--color=always"], { color: "always" }, { GREP_COLOR: "banana" }],
    [["--color=always"], { color: "always" }, { GREP_COLORS: "sl=44:cx=42:ms=:mc=:ne" }],
  ]) compare({ args, options, env });
});

test("binary default warnings and binary exclusion are separate from text output", () => {
  const text = Buffer.from("foo\0bar\nfoo\n");
  for (const [args, options] of [
    [[], {}], [["-n"], { lineNumber: true }],
    [["-l"], { filesMode: "with" }], [["-L"], { filesMode: "without" }],
    [["-I"], { binary: "without-match" }], [["-I", "-c"], { binary: "without-match", count: true }],
    [["-a", "-n"], { binary: "text", lineNumber: true }],
  ]) compare({ args, options, text, second: null, binary: true });
});

test("base64 JSON content and file paths remain byte-exact without text decoding", () => {
  const stdout = [], format = createGrepFormatter({ filename: true, binary: "text", lineNumber: true }, { stdout: (value) => stdout.push(value) });
  const path = Buffer.from([0x78, 0xff]), lines = Buffer.from([0x66, 0x6f, 0x6f, 0xfe]);
  format.event({ type: "match", data: { path: { bytes: path.toString("base64") }, lines: { bytes: lines.toString("base64") }, line_number: 1, absolute_offset: 0, submatches: [{ start: 0, end: 3 }] } });
  assert.deepEqual(Buffer.concat(stdout), Buffer.concat([path, Buffer.from(":1:"), lines, Buffer.from("\n")]));
  assert.equal(format.finish().status, 0);
});

test("quiet selected lines override input errors while normal mode reports them", () => {
  for (const quiet of [false, true]) {
    const format = createGrepFormatter({ quiet }, { stdout() {} });
    format.markError("missing");
    format.event({ type: "match", data: { path: { text: "good" }, lines: { text: "foo\n" }, line_number: 1, absolute_offset: 0, submatches: [{ start: 0, end: 3 }] } });
    assert.equal(format.finish().status, quiet ? 0 : 2);
  }
});

test("later begin flushes earlier zero counts before the matching operand", () => {
  const stdout = [], format = createGrepFormatter({ count: true, filename: true }, { stdout: (value) => stdout.push(value) });
  format.registerFile("empty"); format.registerFile("matching");
  format.event({ type: "begin", data: { path: { text: "matching" } } });
  assert.equal(Buffer.concat(stdout).toString(), "empty:0\n");
  format.event({ type: "match", data: { path: { text: "matching" }, lines: { text: "foo\n" }, line_number: 1, absolute_offset: 0, submatches: [{ start: 0, end: 3 }] } });
  format.finishFile("matching");
  assert.equal(Buffer.concat(stdout).toString(), "empty:0\nmatching:1\n");
});

test("repeated operands retain independent counts and filename results", () => {
  const directory = mkdtempSync(join(tmpdir(), "grep2rg-occurrences-"));
  try {
    const path = join(directory, "same"); writeFileSync(path, "foo\nfoo\n");
    for (const [args, options] of [[["-c"], { count: true }], [["-l"], { filesMode: "with" }], [["-L"], { filesMode: "without" }], [["-n"], { lineNumber: true }]]) {
      const stdout = [], format = createGrepFormatter(options, { stdout: (value) => stdout.push(value), env: baseEnv });
      for (let occurrence = 0; occurrence < 2; occurrence++) {
        format.registerFile(path, { size: statSync(path).size, filenameRequired: true });
        const result = spawnSync("rg", ["--json", "--no-config", "--text", "foo", path], { env: baseEnv });
        for (const line of result.stdout.toString().split("\n")) if (line) format.event(JSON.parse(line));
        format.finishFile(path); // End events must make this idempotent.
      }
      const result = format.finish(), expected = spawnSync("grep", [...args, "foo", path, path], { env: baseEnv });
      assert.deepEqual(Buffer.concat(stdout), expected.stdout, args.join(" "));
      assert.equal(result.status, expected.status);
    }
  } finally { rmSync(directory, { recursive: true }); }
});

test("count/no-match files resolve in each registered batch without extra zero records", () => {
  const stdout = [], format = createGrepFormatter({ count: true }, { stdout: (value) => stdout.push(value) });
  for (let batch = 0; batch < 2; batch++) {
    format.registerFile("nonmatching", { filenameRequired: true });
    format.finishFile("nonmatching");
    format.finishFile("nonmatching");
  }
  assert.equal(Buffer.concat(stdout).toString(), "nonmatching:0\nnonmatching:0\n");
  assert.equal(format.finish().status, 1);
});

test("zero-width fragments preserve selected-line status without printing empty matches", () => {
  for (const pattern of ["", "^", "$", "foo|"]) {
    for (const [args, options] of [[['-E', '-o'], { onlyMatching: true }], [['-E', '-c'], { count: true }], [['-E', '-v', '-o'], { invertMatch: true, onlyMatching: true }]]) {
      compare({ args, options, pattern, text: Buffer.from("foo\n\nother\n"), second: Buffer.alloc(0) });
    }
  }
});

test("CRLF and multibyte text use raw offsets rather than JavaScript character indexes", () => {
  for (const [args, options] of [[['-n', '-b', '-o'], { lineNumber: true, byteOffset: true, onlyMatching: true }], [['-n', '-b'], { lineNumber: true, byteOffset: true }], [['-T', '-n', '-b'], { initialTab: true, lineNumber: true, byteOffset: true }]]) {
    compare({ args, options, text: Buffer.from("🙂foo éfoo\r\nfoo\r\nlast"), second: null });
  }
});

test("bounded seeded option combinations preserve GNU output and status", () => {
  let seed = 0x5eedcafe;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const fragments = ["foo", "foo foo", "other", "", "xfoox", "foo bar"];
  for (let sample = 0; sample < 64; sample++) {
    const args = [], options = {}, nullData = (random() & 3) === 0;
    if (nullData) { args.push('-z'); options.nullData = true; }
    if (random() & 1) { args.push('-v'); options.invertMatch = true; }
    const mode = random() % 6;
    if (mode === 0) { args.push('-c'); options.count = true; }
    if (mode === 1) { args.push('-l'); options.filesMode = 'with'; }
    if (mode === 2) { args.push('-L'); options.filesMode = 'without'; }
    if (mode === 3) { args.push('-o'); options.onlyMatching = true; }
    if (mode === 4) { args.push('-q'); options.quiet = true; }
    if (random() & 1) { args.push('-n'); options.lineNumber = true; }
    if (random() & 1) { args.push('-b'); options.byteOffset = true; }
    if (random() & 1) { args.push('-Z'); options.nullNames = true; }
    if ((random() & 3) === 0) { const context = random() % 3; args.push(`-C${context}`); Object.assign(options, { contextRequested: true, beforeContext: context, afterContext: context }); }
    if ((random() & 3) === 0) { const maximum = random() % 3; args.push(`-m${maximum}`); options.maxCount = maximum; }
    const text = Buffer.from(Array.from({ length: 12 }, () => fragments[random() % fragments.length]).join(nullData ? '\0' : '\n'));
    compare({ args, options, text, second: sample % 3 ? Buffer.from('no match') : text });
  }
});

test("input errors suppress zero-count/file-without-match output for failed operands", () => {
  for (const options of [{ count: true }, { filesMode: 'without' }]) {
    const stdout = [], format = createGrepFormatter({ filename: true, ...options }, { stdout: (data) => stdout.push(data) });
    format.registerFile('unreadable'); format.markError('unreadable'); format.finishFile('unreadable');
    assert.equal(Buffer.concat(stdout).length, 0);
    assert.equal(format.finish().status, 2);
  }
});
