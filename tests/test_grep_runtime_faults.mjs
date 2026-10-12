// External peer faults and real process/TTY behavior; no production fault hooks.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { planGrep } from "../src/grep-wrapper.mjs";

const adapter = fileURLToPath(new URL("../src/grep-wrapper.mjs", import.meta.url));
const baseEnv = { ...process.env, LC_ALL: "C", GREP_COLORS: "", GREP_COLOR: "", TERM: "xterm" };
delete baseEnv.POSIXLY_CORRECT;
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "grep-peer-fault-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "bin"));
  writeFileSync(join(cwd, "input.txt"), "before\nneedle\nafter\nneedle needle\n");
  return cwd;
}
function peer(cwd, body) {
  writeFileSync(join(cwd, "bin/rg"), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return { ...baseEnv, PATH: `${join(cwd, "bin")}:${process.env.PATH}` };
}
function invoke(cwd, args, env = baseEnv, executable = process.execPath, entry = [adapter]) {
  const result = spawnSync(executable, [...entry, ...args], { cwd, env, timeout: 8000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, `bounded subprocess: ${result.error?.code}`);
  assert.equal(result.signal, null);
  return result;
}
const compare = (actual, expected) => {
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
};
const events = [
  { type: "begin", data: { path: { text: "input.txt" } } },
  { type: "match", data: { path: { text: "input.txt" }, lines: { text: "needle\n" },
    line_number: 2, absolute_offset: 7, submatches: [{ match: { text: "needle" }, start: 0, end: 6 }] } },
  { type: "end", data: { path: { text: "input.txt" } } },
];

test("quiet filenames-only searches never publish a filename", (t) => {
  const cwd = fixture(t);
  for (const flags of ["-aFql", "-aFlq", "-aFqlc", "-aFqL"]) {
    const args = [flags, "needle", "input.txt"];
    const actual = invoke(cwd, args), expected = invoke(cwd, args, baseEnv, "grep", []);
    compare(actual, expected);
    assert.equal(actual.status, 0); assert.equal(actual.stdout.length, 0);
  }
});

test("NUL inverse max-count searches preserve GNU's trailing-context boundary", (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, "input.txt"), ["x", "needle", "x", "x", "x", "x", "x"].join("\0") + "\0");
  const witness = ["-azFv", "-m1", "-A3", "needle", "input.txt"];
  const expected = invoke(cwd, witness, baseEnv, "grep", []);
  assert.equal(expected.stdout.toString("hex"), Buffer.from("x\0needle\0x\0x\0").toString("hex"));
  compare(invoke(cwd, witness), expected);
  assert.equal(planGrep(witness, { env: baseEnv }).backend, "rg");
  for (const maximum of [1, 2, 3]) for (const context of ["-C1", "-C3", "-A1", "-A3", "-B1"]) {
    const args = ["-azFv", `-m${maximum}`, context, "needle", "input.txt"];
    compare(invoke(cwd, args), invoke(cwd, args, baseEnv, "grep", []));
  }
});

test("fragmented JSON events preserve line and byte prefix output", (t) => {
  const cwd = fixture(t);
  const stream = events.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const env = peer(cwd, `const text=${JSON.stringify(stream)}; let offset=0;
    function send(){if(offset<text.length){process.stdout.write(text.slice(offset,++offset));setImmediate(send)}}send();`);
  const actual = invoke(cwd, ["-anbF", "needle", "input.txt"], env);
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.toString(), "2:7:needle\n");
  assert.equal(actual.stderr.length, 0);
});

test("complete final JSON without a newline is consumed instead of losing the match", (t) => {
  const cwd = fixture(t);
  const stream = events.slice(0, 2).map((record) => JSON.stringify(record)).join("\n");
  const env = peer(cwd, `process.stdout.write(${JSON.stringify(stream)});`);
  const actual = invoke(cwd, ["-acF", "needle", "input.txt"], env);
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.toString(), "1\n");
  assert.equal(actual.stderr.length, 0);
});

for (const [name, payload] of [["malformed record", "{broken}\n"], ["truncated final record", '{"type":"match","data":']]) {
  test(`rg ${name} produces a diagnostic error without invented counts`, (t) => {
    const cwd = fixture(t), env = peer(cwd, `process.stdout.write(${JSON.stringify(payload)});`);
    const actual = invoke(cwd, ["-acF", "needle", "input.txt"], env);
    assert.equal(actual.status, 2);
    assert.equal(actual.stdout.length, 0);
    assert.match(actual.stderr.toString(), /invalid search response from rg/);
    assert.doesNotMatch(actual.stderr.toString(), /Unhandled|SyntaxError|node:events/);
  });
}

test("rg failure retains bounded diagnostics and suppresses fabricated zero counts", (t) => {
  const cwd = fixture(t), env = peer(cwd, 'process.stderr.write("synthetic reader failure\\n");process.exitCode=2;');
  const actual = invoke(cwd, ["-acF", "needle", "input.txt"], env);
  assert.equal(actual.status, 2);
  assert.equal(actual.stdout.length, 0);
  assert.equal(actual.stderr.toString(), "synthetic reader failure\n");
  const silent = invoke(cwd, ["-ascF", "needle", "input.txt"], env);
  assert.equal(silent.status, 2);
  assert.equal(silent.stdout.length + silent.stderr.length, 0);
});

test("a failing PCRE dependency falls back before consuming the user's stdin", (t) => {
  const cwd = fixture(t), env = peer(cwd, 'process.stderr.write("PCRE2 unavailable\\n");process.exitCode=2;');
  const args = ["-aP", "needle(?= needle)"];
  const input = Buffer.from("needle needle\nneedle\n");
  const expected = spawnSync("grep", args, { cwd, env, input, timeout: 8000 });
  const actual = spawnSync(process.execPath, [adapter, ...args], { cwd, env, input, timeout: 8000 });
  assert.equal(expected.error, undefined); assert.equal(actual.error, undefined);
  compare(actual, expected);
  assert.equal(actual.stdout.toString(), "needle needle\n");
});

test("an executable disappearing after discovery reports the spawn failure", (t) => {
  const cwd = fixture(t);
  const env = peer(cwd, 'require("node:fs").unlinkSync(__filename);process.exitCode=1;');
  env.PATH = join(cwd, "bin");
  const actual = invoke(cwd, ["-aP", "needle(?= needle)", "input.txt"], env);
  assert.equal(actual.status, 2);
  assert.equal(actual.stdout.length, 0);
  assert.match(actual.stderr.toString(), /ENOENT/);
});

test("TTY default and explicit color modes match GNU for ordinary and dumb terminals", (t) => {
  const cwd = fixture(t);
  const script = `import base64,json,os,pty,select,subprocess,sys,termios,time
master,slave=pty.openpty()
settings=termios.tcgetattr(slave);settings[1]&=~termios.ONLCR;termios.tcsetattr(slave,termios.TCSANOW,settings)
child=subprocess.Popen(sys.argv[1:],stdout=slave,stderr=subprocess.PIPE);os.close(slave)
data=bytearray();deadline=time.monotonic()+8
while time.monotonic()<deadline:
    if select.select([master],[],[],0.1)[0]:
        try:piece=os.read(master,65536)
        except OSError:break
        if not piece:break
        data.extend(piece)
    elif child.poll() is not None:break
else:child.kill();raise RuntimeError("PTY child deadline")
os.close(master);status=child.wait(timeout=1)
print(json.dumps({"status":status,"stdout":base64.b64encode(data).decode(),"stderr":base64.b64encode(child.stderr.read()).decode()}))`;
  for (const term of ["xterm", "dumb"]) for (const matcher of ["F", "P"])
    for (const color of [[], ["--color=auto"], ["--color=always"], ["--color=never"]])
      for (const flags of [[], ["-Hnb"], ["-C1"], ["-o"], ["-c"], ["-l"]]) {
    const args = [`-a${matcher}`, ...color, ...flags, "needle", "input.txt"];
    const env = { ...baseEnv, TERM: term, GREP_COLORS: "ms=1;33:fn=36:ne" };
    const run = (program, entry) => {
      const result = spawnSync("python3", ["-c", script, program, ...entry, ...args], { cwd, env, timeout: 10000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr.toString());
      return JSON.parse(result.stdout.toString());
    };
    const expected = run("grep", []), actual = run(process.execPath, [adapter]);
    assert.deepEqual(actual, expected, `TTY ${term}, matcher ${matcher}, color ${color}, flags ${flags}`);
    const output = Buffer.from(actual.stdout, "base64");
    const colored = color.includes("--color=always") || (color.includes("--color=auto") && term === "xterm");
    assert.equal(output.includes(Buffer.from("\x1b[")), colored && !flags.includes("-c"));
  }
});

test("slow stdout consumers preserve every byte and produce no listener warnings", async (t) => {
  const cwd = fixture(t), input = "needle ".repeat(20) + "\n";
  writeFileSync(join(cwd, "input.txt"), input.repeat(12000));
  const args = ["-anF", "needle", "input.txt"];
  const expected = spawnSync("grep", args, { cwd, env: baseEnv, maxBuffer: 4 * 1024 * 1024, timeout: 8000 });
  assert.equal(expected.error, undefined); assert.equal(expected.status, 0);
  const child = spawn(process.execPath, [adapter, ...args], { cwd, env: baseEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  const deadline = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 10000);
  t.after(() => clearTimeout(deadline));
  child.stdout.pause();
  child.stdout.on("data", (part) => stdout.push(part));
  child.stderr.on("data", (part) => stderr.push(part));
  setTimeout(() => child.stdout.resume(), 100);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(deadline);
  assert.equal(result.signal, null); assert.equal(result.status, 0);
  assert.deepEqual(Buffer.concat(stdout), expected.stdout);
  assert.deepEqual(Buffer.concat(stderr), expected.stderr);
});

test("test-only mutants prove count, byte-prefix, status, pattern-capture and whole-record span assertions detect wrong behavior", (t) => {
  const cwd = fixture(t), source = fileURLToPath(new URL("../src/", import.meta.url));
  writeFileSync(join(cwd, "backrefs.txt"), "aa\nbb\naab\nbaa\n");
  writeFileSync(join(cwd, "whole-records.nul"), "foo\0xx\0foo\0FOO\0foo\0");
  const modules = ["wrapper", "runtime", "options", "files", "output", "posix-spans", "unicode", "descriptors", "stdin"];
  const original = Object.fromEntries(modules.map((name) => [name, readFileSync(join(source, `grep-${name}.mjs`), "utf8")]));
  const directory = join(cwd, "mutated package's modules"); mkdirSync(directory);
  const entry = join(directory, "grep-wrapper.mjs");
  const mutants = [
    ["count", "output", "bytes(file.count), LF", "bytes(file.count + 1), LF", ["-acF", "needle", "input.txt"]],
    ["byte prefix", "output", "String(offset ?? 0).padStart(width)", "String((offset ?? 0) + 1).padStart(width)", ["-abF", "needle", "input.txt"]],
    ["no-match status", "runtime", "state.searchError || state.protocolError ? 2 : result.status", "state.searchError || state.protocolError ? 2 : 0", ["-aF", "absent", "input.txt"]],
    ["pattern-local backreferences", "options", "patterns.length > 1 && patterns.some((pattern) =>", "false && patterns.some((pattern) =>", ["-aE", "-e", "(a)\\1", "-e", "(b)\\1", "backrefs.txt"]],
    ["selected whole-record span", "output", "wholeRecord ? [{ start: 0, end: record.length }]", "wholeRecord ? [{ start: 0, end: 0 }]", ["-aF", "-z", "-x", "-o", "foo", "whole-records.nul"]],
  ];
  for (const [name, module, before, after, args] of mutants) {
    assert.equal(original[module].split(before).length, 2, `${name}: mutation applies exactly once`);
    for (const [key, text] of Object.entries(original)) writeFileSync(join(directory, `grep-${key}.mjs`), text);
    const oracle = invoke(cwd, args, baseEnv, "grep", []);
    compare(invoke(cwd, args, baseEnv, process.execPath, [entry]), oracle);
    writeFileSync(join(directory, `grep-${module}.mjs`), original[module].replace(before, after));
    const changed = invoke(cwd, args, baseEnv, process.execPath, [entry]);
    assert.equal(changed.stderr.length, 0, `${name}: syntax or infrastructure failures do not count as mutant rejection`);
    assert.ok(changed.status === 0 || changed.status === 1);
    assert.ok(changed.status !== oracle.status || !changed.stdout.equals(oracle.stdout), `${name}: the semantic oracle must reject the mutant`);
  }
  t.diagnostic(JSON.stringify({ campaign: "semantic-source-mutants", actualGNUComparisons: mutants.length,
    negativeControlExecutions: mutants.length, semanticNegativeControlsRejected: mutants.map(([name]) => name) }));
});
