// Scope checks use synthetic files and offline SDK sessions only. A tracing rg
// executable delegates to the real engine so routing assertions do not replace
// the behavior being checked with a canned response.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { withGrepWrapper } from "../src/grep-wrapper.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const textOf = (result) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-grep-scope-"));
  const bin = join(cwd, "bin"), trace = join(cwd, "rg-trace.txt");
  mkdirSync(bin);
  writeFileSync(join(cwd, "file.txt"), "needle\nother\n");
  writeFileSync(join(cwd, "child.sh"), "#!/usr/bin/env bash\ntype -t grep\ngrep -aFl needle file.txt\n", { mode: 0o700 });
  writeFileSync(join(bin, "rg"), "#!/usr/bin/env bash\nprintf 'rg\\n' >> \"$GREP_SCOPE_TRACE\"\nexec /usr/bin/rg \"$@\"\n", { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GREP_SCOPE_TRACE: trace, LC_ALL: "C", GREP2RG_EXPERIMENTAL_RG: "1" };
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, env, bin, trace, calls: () => existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter(Boolean).length : 0 };
}

function shell(command, current, { wrapped = false, interactive = false } = {}) {
  const context = { command, cwd: current.cwd, env: current.env };
  const adapted = wrapped ? withGrepWrapper(context, "/usr/bin/bash") : context;
  const result = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", interactive ? "-ic" : "-c", adapted.command], {
    cwd: adapted.cwd, env: adapted.env, stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout.toString();
}

test("the wrapper does not alter ordinary interactive shells, native grep, or child scripts", (t) => {
  const current = fixture(t);
  assert.equal(shell("type -t grep; grep -aFl needle file.txt", current, { interactive: true }), "file\nfile.txt\n");
  assert.equal(current.calls(), 0, "an ordinary shell invokes GNU grep, without rg");
  assert.equal(shell("type -t grep; command grep -aFl needle file.txt; /usr/bin/grep -aFl needle file.txt; bash child.sh", current, { wrapped: true }),
    "function\nfile.txt\nfile.txt\nfile\nfile.txt\n");
  assert.equal(current.calls(), 0, "command/absolute-path bypasses and child scripts remain native");
  assert.equal(shell("export -pf | /usr/bin/grep '^declare -fx grep' || :; bash -c 'type -t grep'; printenv | /usr/bin/grep '^BASH_FUNC_grep%%=' || :", current, { wrapped: true }), "file\n");
  assert.equal(current.calls(), 0, "the scoped grep function is not exported to descendants");
  assert.equal(shell("type -t grep; grep -aFl needle file.txt", current), "file\nfile.txt\n");
  assert.equal(current.calls(), 0, "a later shell remains unchanged");
});

test("bare grep is translated automatically in compound shell commands, pipelines and subshells", (t) => {
  const current = fixture(t);
  const output = shell("printf 'needle\\nother\\n' | grep -aF needle; (grep -aFn needle file.txt); for target in file.txt; do grep -aFl needle \"$target\"; done", current, { wrapped: true });
  assert.equal(output, "needle\n1:needle\nfile.txt\n");
  assert.equal(current.calls(), 3, "all three bare grep commands reached the real rg engine");
});

test("non-Bash shell settings retain the original command and environment", () => {
  const context = { command: "grep -aFl needle file.txt", cwd: "/synthetic", env: { SYNTHETIC: "1" } };
  for (const path of ["/usr/bin/fish", "/bin/sh", "/bin/zsh"]) assert.equal(withGrepWrapper(context, path), context);
});

// The verifier registers this group only in its explicit SDK stage; the CPU run
// has no misleading skipped integration check when dependencies are unavailable.
if (process.env.GREP2RG_TEST_PI_SDK === "1") {
  test("installed Pi applies the wrapper only to qwen-r9700 model tools, never user ! commands", { timeout: 180000 }, async (t) => {
    const built = spawnSync(process.execPath, [join(root, "tools/build-rust.mjs"), "--offline"], { encoding: "utf8", timeout: 120000 });
    assert.equal(built.status, 0, `SDK qualification requires the host-local Rust engine: ${built.stderr}`);
    const sdkRoot = process.env.GREP2RG_TEST_PI_ROOT ?? process.env.QWEN_TEST_PI_ROOT;
    assert.ok(sdkRoot, "explicit SDK checks require GREP2RG_TEST_PI_ROOT");
    const mod = (path) => import(pathToFileURL(join(sdkRoot, path)));
    const { createAgentSession } = await mod("pi-coding-agent/dist/core/sdk.js");
    const { SettingsManager } = await mod("pi-coding-agent/dist/core/settings-manager.js");
    const { SessionManager } = await mod("pi-coding-agent/dist/core/session-manager.js");
    const { DefaultResourceLoader } = await mod("pi-coding-agent/dist/core/resource-loader.js");
    const { validateToolArguments } = await mod("pi-ai/dist/utils/validation.js");
    const current = fixture(t), agentDir = join(current.cwd, "agent");
    const rustReport = join(current.cwd, "rust-route.json");
    const previousExperiment = process.env.GREP2RG_EXPERIMENTAL_RG;
    process.env.GREP2RG_EXPERIMENTAL_RG = "1";
    t.after(() => { if (previousExperiment === undefined) delete process.env.GREP2RG_EXPERIMENTAL_RG; else process.env.GREP2RG_EXPERIMENTAL_RG = previousExperiment; });
    mkdirSync(agentDir);
    const previous = process.env.PI_CODING_AGENT_DIR;
    const previousProviders = process.env.GREP2RG_PI_PROVIDERS;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
    delete process.env.GREP2RG_PI_PROVIDERS;
    t.after(() => { if (previousProviders === undefined) delete process.env.GREP2RG_PI_PROVIDERS; else process.env.GREP2RG_PI_PROVIDERS = previousProviders; });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["bash"], shellPath: "/usr/bin/bash",
      shellCommandPrefix: `export PATH=${quote(current.bin)}:"$PATH"\nexport GREP_SCOPE_TRACE=${quote(current.trace)}\nexport GREP2RG_ENGINE_REPORT=${quote(rustReport)}\nexport LC_ALL=C`,
      compaction: { enabled: false }, retry: { enabled: false } }));
    let networkRequests = 0, inferenceRequests = 0;
    t.mock.method(globalThis, "fetch", () => { networkRequests++; throw new Error("Network forbidden in grep scope fixture"); });
    const model = (provider, id) => ({ provider, id, name: id, api: "openai-completions", baseUrl: "http://fixture.invalid/v1",
      reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const models = [model("qwen-r9700", "qwen-scope-fixture"), model("fixture", "non-qwen"),
      model("openai", "qwen-name-with-other-provider"), model("qwen-r9700-other", "qwen-near-provider")];
    const modelRuntime = { getModel: (provider, id) => models.find((item) => item.provider === provider && item.id === id),
      getAvailableSnapshot: () => models, hasConfiguredAuth: () => true, checkAuth: async () => true,
      isUsingOAuth: () => false, getAuth: async () => ({ auth: { apiKey: "fixture" }, env: {} }),
      streamSimple: () => { inferenceRequests++; throw new Error("Inference forbidden in grep scope fixture"); } };
    const settingsManager = SettingsManager.create(current.cwd, agentDir, { projectTrusted: true });
    const resourceLoader = new DefaultResourceLoader({ cwd: current.cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(root, "pi/grep2rg.ts")] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: current.cwd, agentDir, model: models[0], modelRuntime, settingsManager, resourceLoader,
      sessionManager: SessionManager.create(current.cwd, join(current.cwd, "sessions")) });
    const errors = [];
    session.extensionRunner.onError((error) => errors.push(error));
    t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
    await session.bindExtensions({ uiContext: { notify() {}, setWidget() {}, setStatus() {}, setWorkingMessage() {} } });
    const invoke = async (command) => {
      const tool = session.agent.state.tools.find((candidate) => candidate.name === "bash");
      assert.ok(tool, "the actual SDK native bash tool is active");
      const params = { command, timeout: 5 };
      validateToolArguments(tool, { name: tool.name, arguments: params });
      return textOf(await tool.execute("synthetic-grep-scope", params, new AbortController().signal));
    };
    await t.test("Qwen bare shell grep reaches rg without rewriting the model command", async () => {
      const count = current.calls();
      assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "function\nfile.txt\n");
      assert.equal(current.calls(), count + 1);
      assert.equal(await invoke("printf 'needle\\nother\\n' | grep -aF needle; (grep -aFn needle file.txt)"), "needle\n1:needle\n");
      assert.equal(current.calls(), count + 3, "compound pipeline and subshell also use the wrapper");
    });
    await t.test("Qwen child scripts and explicit native bypasses do not reach rg", async () => {
      const count = current.calls();
      assert.equal(await invoke("command grep -aFl needle file.txt; /usr/bin/grep -aFl needle file.txt; bash child.sh"), "file.txt\nfile.txt\nfile\nfile.txt\n");
      assert.equal(current.calls(), count);
    });
    await t.test("Pi user ! shell execution retains native GNU grep", async () => {
      const count = current.calls();
      const event = await session.extensionRunner.emitUserBash({ type: "user_bash", command: "grep -aFl needle file.txt", excludeFromContext: false, cwd: current.cwd });
      assert.ok(!event?.operations, "the grep2rg extension never intercepts user_bash");
      const result = await session.executeBash("type -t grep; grep -aFl needle file.txt");
      assert.equal(result.output, "file\nfile.txt\n");
      assert.equal(current.calls(), count);
    });
    await t.test("switching to other providers disables the hook without disabling the native Bash tool", async () => {
      const count = current.calls();
      for (const other of models.slice(1)) {
        await session.setModel(other);
        assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "file\nfile.txt\n", other.provider);
      }
      assert.equal(current.calls(), count);
      await session.setModel(models[0]);
      assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "function\nfile.txt\n");
      assert.equal(current.calls(), count + 1, "returning to Qwen restores routing on the next invocation");
    });
    await t.test("a configured exact provider list replaces the default and is read on each invocation", async () => {
      const count = current.calls();
      process.env.GREP2RG_PI_PROVIDERS = " fixture, qwen-r9700-other ";
      assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "file\nfile.txt\n", "the default Qwen provider is not implicitly retained");
      assert.equal(current.calls(), count);
      await session.setModel(models[1]);
      assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "function\nfile.txt\n");
      await session.setModel(models[3]);
      assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "function\nfile.txt\n");
      assert.equal(current.calls(), count + 2);
      await session.setModel(models[2]);
      assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "file\nfile.txt\n", "a model name containing qwen never authorizes its provider");
      assert.equal(current.calls(), count + 2);
      await session.setModel(models[0]);
      process.env.GREP2RG_PI_PROVIDERS = "";
      assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "file\nfile.txt\n", "an explicit empty provider list disables adaptation");
      assert.equal(current.calls(), count + 2);
      delete process.env.GREP2RG_PI_PROVIDERS;
      assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "function\nfile.txt\n");
      assert.equal(current.calls(), count + 3, "removing the setting immediately restores the default");
    });
    await t.test("normal Pi small calls reach integrated Rust through the installed hook", async () => {
      const count = current.calls(), previousExperiment = process.env.GREP2RG_EXPERIMENTAL_RG;
      try {
        for (const value of [undefined, "", "0", "true", "yes", "2"]) {
          delete process.env.GREP2RG_EXPERIMENTAL_RG;
          if (value !== undefined) process.env.GREP2RG_EXPERIMENTAL_RG = value;
          rmSync(rustReport, { force: true });
          assert.equal(await invoke("type -t grep; grep -aFl needle file.txt"), "function\nfile.txt\n");
          assert.equal(current.calls(), count, "native Rust must not launch rg");
          assert.equal(JSON.parse(readFileSync(rustReport, "utf8")).engine, "rust", "the installed SDK must execute the built Rust engine");
        }
      } finally {
        if (previousExperiment === undefined) delete process.env.GREP2RG_EXPERIMENTAL_RG;
        else process.env.GREP2RG_EXPERIMENTAL_RG = previousExperiment;
      }
      t.diagnostic(JSON.stringify({ campaign: "pi-default-small-Rust-policy", actualGNUComparisons: 6,
        actualRgInvocations: 0, networkRequests, inferenceRequests }));
    });
    await t.test("normal Pi large searches automatically accelerate without experimental opt-in", async () => {
      const count=current.calls(), previousExperiment=process.env.GREP2RG_EXPERIMENTAL_RG;
      const large=join(current.cwd,"large");mkdirSync(large);
      for(let i=0;i<256;i++){const bytes=Buffer.from("padding abcdefghijklmnopqrstuvwxyz 0123456789\n".repeat(6000)).subarray(0,262144);bytes.write(i%7===0?"needle\n":"otherx\n",bytes.length-7);writeFileSync(join(large,`file${i}`),bytes);}
      try {
        delete process.env.GREP2RG_EXPERIMENTAL_RG;
        rmSync(rustReport, { force: true });
        assert.equal(await invoke("grep -racF needle large"),shell("grep -racF needle large",current));
        assert.equal(current.calls(), count,"the actual Pi hook must perform native Rust search without rg");
        assert.equal(JSON.parse(readFileSync(rustReport, "utf8")).engine, "rust");
      } finally {
        if(previousExperiment===undefined)delete process.env.GREP2RG_EXPERIMENTAL_RG;
        else process.env.GREP2RG_EXPERIMENTAL_RG=previousExperiment;
      }
    });
    assert.deepEqual(errors, []);
    assert.equal(networkRequests, 0);
    assert.equal(inferenceRequests, 0);
    t.diagnostic(JSON.stringify({ campaign: "pi-sdk-scope", actualRgInvocations: current.calls(), networkRequests, inferenceRequests, extension: "pi/grep2rg.ts", nativeToolName: "bash" }));
  });
}
