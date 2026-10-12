// Real release execution, exact GNU oracle, and model-only Bash scope. Routing
// receipts come from the Rust executable; no fake search engine is substituted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { withGrepWrapper } from '../src/grep-wrapper.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = join(root, 'rust/target/release/grep2rg-rust');
accessSync(binary, constants.X_OK);
const binaryHash = createHash('sha256').update(readFileSync(binary)).digest('hex');
const baseEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
for (const key of Object.keys(baseEnv)) if (key.startsWith('GREP2RG_') || ['POSIXLY_CORRECT','GREP_OPTIONS','GREP_COLOR','GREP_COLORS'].includes(key)) delete baseEnv[key];

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-rust-integration-'));
  writeFileSync(join(cwd, 'hit'), 'head\nneedle needle\ntail\n');
  writeFileSync(join(cwd, 'miss'), 'other\n');
  writeFileSync(join(cwd, 'binary'), 'head\0needle\n');
  writeFileSync(join(cwd, 'child.sh'), "type -t grep; grep -anF needle hit\n");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, route: join(cwd, 'route.json') };
}
function run(program, argv, current, env = {}, input = Buffer.alloc(0)) {
  const result = spawnSync(program, argv, { cwd: current.cwd, env: { ...baseEnv, ...env }, input,
    argv0: program === '/usr/bin/grep' ? 'grep' : undefined, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  return result;
}
function exact(actual, expected) {
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.stdout, expected.stdout); assert.deepEqual(actual.stderr, expected.stderr);
}
function wrapped(argv, current, env = {}, input) {
  const prefix = withGrepWrapper({ command: 'grep "$@"' }, '/usr/bin/bash').command;
  return run('/usr/bin/bash', ['--noprofile', '--norc', '-c', prefix, 'owned', ...argv], current, env, input);
}

test('ordinary CLI and private Bash function execute native Rust with exact GNU output', t => {
  const current = fixture(t);
  let native = 0, fallback = 0;
  for (const [argv, input, engine] of [
    [['-anF','needle','hit'], undefined, 'rust'],
    [['-acF','needle','miss'], undefined, 'rust'],
    [['-anF','needle','miss','hit','hit'], undefined, 'rust'],
    [['-anF','needle'], Buffer.from('head\nneedle\n'), 'rust'],
    [['-nF','needle','binary'], undefined, 'gnu'],
    [['--invalid-owned-option'], undefined, 'gnu'],
  ]) {
    const expected = run('/usr/bin/grep', argv, current, {}, input);
    for (const invoke of [(...args) => run(join(root, 'bin/grep2rg'), ...args), wrapped]) {
      rmSync(current.route, { force: true });
      exact(invoke(argv, current, { GREP2RG_ENGINE_REPORT: current.route }, input), expected);
      assert.equal(JSON.parse(readFileSync(current.route, 'utf8')).engine, engine);
      if (engine === 'rust') native++; else fallback++;
    }
  }
  t.diagnostic(JSON.stringify({ campaign: 'Rust default integration', artifactSHA256: binaryHash, comparisons: native + fallback, native, fallback }));
});

test('bare compound grep uses Rust while user shells, bypasses and child shells remain GNU', t => {
  const current = fixture(t), prefix = withGrepWrapper({ command: '' }, '/usr/bin/bash').command;
  const env = { GREP2RG_ENGINE_REPORT: current.route };
  let result = run('/usr/bin/bash', ['-c', prefix + "printf 'needle\\nother\\n' | grep -aF needle; (grep -anF needle hit); for file in hit; do grep -alF needle \"$file\"; done"], current, env);
  assert.equal(result.status, 0); assert.equal(result.stdout.toString(), 'needle\n2:needle needle\nhit\n');
  assert.equal(JSON.parse(readFileSync(current.route)).engine, 'rust');
  rmSync(current.route);
  result = run('/usr/bin/bash', ['-c', prefix + "command grep -anF needle hit; /usr/bin/grep -anF needle hit; bash child.sh; bash -c 'type -t grep'; export -pf | /usr/bin/grep '^declare -fx grep' || :"], current, env);
  assert.equal(result.status, 0); assert.equal(result.stdout.toString(), '2:needle needle\n2:needle needle\nfile\n2:needle needle\nfile\n');
  assert.ok(!existsSync(current.route), 'GNU bypasses and child shells never execute Rust');
  result = run('/usr/bin/bash', ['--noprofile','--norc','-c','type -t grep; grep -anF needle hit'], current, env);
  assert.equal(result.stdout.toString(), 'file\n2:needle needle\n');
  assert.ok(!existsSync(current.route), 'ordinary user Bash has no wrapper');
  for (const shell of ['/bin/sh','/bin/zsh','/usr/bin/fish']) {
    const context = { command: 'grep -anF needle hit' };
    assert.equal(withGrepWrapper(context, shell), context);
  }
});

test('GNU optout avoids Rust and preserves all output; missing builds retain GNU', t => {
  const current = fixture(t), argv = ['-anF','needle','hit'];
  const env = { GREP2RG_ACCELERATION: 'gnu', GREP2RG_ENGINE_REPORT: current.route };
  const expected = run('/usr/bin/grep', argv, current);
  exact(run(join(root,'bin/grep2rg'), argv, current, env), expected);
  exact(wrapped(argv, current, env), expected);
  assert.ok(!existsSync(current.route), 'the explicit GNU policy bypasses Rust before startup');
  const isolated = join(current.cwd,'standalone'), bin = join(isolated,'bin'); mkdirSync(bin,{recursive:true});
  copyFileSync(join(root,'bin/grep2rg'), join(bin,'grep2rg'));
  exact(run(join(bin,'grep2rg'), argv, current, { GREP2RG_ENGINE_REPORT: current.route }), expected);
  assert.ok(!existsSync(current.route));
  const link = join(current.cwd,'linked-cli'); symlinkSync(join(root,'bin/grep2rg'),link);
  exact(run(link,argv,current,{GREP2RG_ENGINE_REPORT:current.route}),expected);
  assert.equal(JSON.parse(readFileSync(current.route)).engine,'rust','symlinked installation locates the release target');
});

test('optional install without Cargo disables stale Rust; required builds report failure', t => {
  const current = fixture(t), isolated = join(current.cwd,'package');
  mkdirSync(join(isolated,'tools'),{recursive:true}); mkdirSync(join(isolated,'rust/target/release'),{recursive:true});
  copyFileSync(join(root,'tools/build-rust.mjs'),join(isolated,'tools/build-rust.mjs'));
  const stale = join(isolated,'rust/target/release/grep2rg-rust'); writeFileSync(stale,'stale');
  const env = { PATH: join(current.cwd,'no-tools') };
  const optional = run(process.execPath,[join(isolated,'tools/build-rust.mjs'),'--optional'],current,env);
  assert.equal(optional.status,0); assert.match(optional.stderr.toString(),/GNU fallback/); assert.ok(!existsSync(stale));
  const required = run(process.execPath,[join(isolated,'tools/build-rust.mjs')],current,env);
  assert.equal(required.status,1); assert.match(required.stderr.toString(),/ENOENT/);
});

test('closed standard descriptors retain GNU before Rust can reopen them', t => {
  const current = fixture(t), prefix = withGrepWrapper({ command: '' }, '/usr/bin/bash').command;
  let comparisons = 0;
  for (const close of ['exec 0<&-;', 'exec 1>&-;', 'exec 2>&-;', 'exec 0<&- 1>&-;', 'exec 0<&- 1>&- 2>&-;']) {
    for (const args of [['-aF','needle'], ['-aF','needle','hit']]) {
      rmSync(current.route, { force: true });
      const script = `${close} "$@"`;
      const expected = run('/usr/bin/bash', ['-c', `${close} exec -a grep "$@"`, 'owned', '/usr/bin/grep', ...args], current);
      const env = { GREP2RG_ENGINE_REPORT: current.route };
      exact(run('/usr/bin/bash', ['-c', script, 'owned', join(root,'bin/grep2rg'), ...args], current, env), expected);
      exact(run('/usr/bin/bash', ['-c', `${prefix}${close} grep "$@"`, 'owned', ...args], current, env), expected);
      // Bash itself opens /dev/null for a closed stderr before a script starts.
      // Closed stdin/stdout still reach the guard without that initialization.
      if (close.includes('0<&-') || close.includes('1>&-')) assert.ok(!existsSync(current.route), 'closed input/output bypasses Rust startup');
      comparisons += 2;
    }
  }
  t.diagnostic(JSON.stringify({ campaign: 'closed stdio Rust startup guard', comparisons }));
});
