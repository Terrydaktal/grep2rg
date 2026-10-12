// A tarball listing alone is insufficient: extract and run the shipped launchers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function command(program, args, cwd, env = process.env) {
  const childEnvironment = { ...env }; delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(program, args, { cwd, env: childEnvironment, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${program}: ${result.error?.message}`);
  assert.equal(result.signal, null, `${program}: ${result.signal}`);
  assert.equal(result.status, 0, `${program} ${args.join(' ')}:\n${result.stdout}\n${result.stderr}`);
  return result;
}
function entryChecks(packageRoot, cwd, bin, prefixBin) {
  const environment = { ...process.env, GREP2RG_TEST_PACKAGE_ROOT: packageRoot, GREP2RG_TEST_ENTRY_BIN: bin, GREP2RG_TEST_PREFIX_BIN: prefixBin };
  // A nested `node --test` owns its TAP stream, rather than the parent's IPC mode.
  delete environment.NODE_TEST_CONTEXT;
  const result = command(process.execPath, ['--test', '--test-reporter=tap', join(packageRoot, 'tests/test_package_entry.mjs')], cwd,
    environment);
  assert.match(result.stdout, /^# tests 5$/m);
  for (const kind of ['fail', 'cancelled', 'skipped', 'todo']) assert.match(result.stdout, new RegExp(`^# ${kind} 0$`, 'm'));
  return [...result.stdout.matchAll(/^# (\{.*\})$/gm)].map((match) => JSON.parse(match[1]));
}

test('actual npm tar extraction and offline local installation execute shipped GNU-compatible entry points', { timeout: 120000 }, (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-artifact-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const npmEnv = { ...process.env, npm_config_cache: join(cwd, 'npm-cache') };
  const manifest = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', cwd], root, npmEnv).stdout);
  const packed = Array.isArray(manifest) ? manifest : Object.values(manifest);
  assert.equal(packed.length, 1);
  const record = packed[0], archive = join(cwd, record.filename), extraction = join(cwd, 'extracted'); mkdirSync(extraction);
  command('tar', ['-xzf', archive, '-C', extraction], cwd);
  const packageRoot = join(extraction, 'package');
  const expected = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'pi/grep2rg.ts', 'bin/grep2rg', 'bin/grep2rg.mjs', 'bin/grep2rg-shell-prefix.mjs',
    'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/src/main.rs', 'rust/src/tests.rs', 'rust/tests/gnu_oracle.rs',
    'tools/rust-verification.mjs', 'tools/verify-rust-artifact.mjs', 'tests/test_verification_evidence.mjs',
    'tools/verify.mjs', 'tools/verify-artifact.mjs', 'tools/build-native.mjs', 'native/grep2rg.c', 'tests/test_grep_auto_native.mjs', 'docs/automatic-routing-audit.json', 'tests/test_package_entry.mjs', 'tests/test_package_artifact.mjs', 'tests/grep_option_inventory.json', 'tests/grep_wrapper_requirements.json', 'tests/port_source_manifest.json', 'tests/grep_extended_helpers.mjs',
    ...['options', 'files', 'output', 'runtime', 'wrapper', 'posix-spans', 'unicode', 'descriptors', 'stdin'].map((name) => `src/grep-${name}.mjs`),
    ...['files', 'full_cli', 'matcher_campaign', 'matrix_campaign', 'option_interactions', 'options', 'output', 'runtime_faults', 'scope', 'traversal_campaign', 'wrapper', 'text_preflight', 'extended_coverage', 'extended_backpressure', 'unicode', 'descriptors', 'seekable_stdin', 'routing_policy'].map((name) => `tests/test_grep_${name}.mjs`)];
  for (const file of expected) {
    assert.ok(existsSync(join(packageRoot, file)), `missing extracted verification or product file ${file}`);
    assert.equal(hash(join(packageRoot, file)), hash(join(root, file)), `packed file identity: ${file}`);
  }
  assert.ok(record.files.every(({ path }) => {
    // Public native fault drivers are versioned test source, not private captures.
    const publicRustFixture = /^rust\/tests\/fixtures\/[^/]+\.(?:c|py|json)$/.test(path);
    return !/(^|\/)(node_modules|artifacts|\.git|captures|private|target)(\/|$)/.test(path) &&
      (publicRustFixture || !/(^|\/)fixtures(\/|$)/.test(path));
  }), 'the package contains only public source/tests, without builds or private lab data');
  assert.ok(!existsSync(join(packageRoot,'bin/grep2rg-native')), 'host-specific native executable is not shipped in the source tarball');
  command(process.execPath,[join(packageRoot,'tools/build-native.mjs')],cwd);
  const nativeExtracted=command(process.execPath,['--test','--test-reporter=tap',join(packageRoot,'tests/test_grep_auto_native.mjs')],cwd);
  assert.match(nativeExtracted.stdout,/allStdoutStderrStatusExact/);
  const extractedEvidence = entryChecks(packageRoot, cwd, join(packageRoot, 'bin/grep2rg'), join(packageRoot, 'bin/grep2rg-shell-prefix.mjs'));
  const installation = join(cwd, 'installed'); mkdirSync(installation);
  // npm 12 blocks unreviewed dependency scripts. Approve only this hash-checked
  // owned package, within the disposable installation rather than global policy.
  writeFileSync(join(installation,'package.json'),JSON.stringify({private:true,allowScripts:{[`file:${archive}`]:true}}));
  const installed = command('npm', ['install', '--offline', '--no-audit', '--no-fund', '--legacy-peer-deps', archive], installation, npmEnv);
  const installedPackage = join(installation, 'node_modules/grep2rg');
  assert.ok(existsSync(join(installedPackage,'bin/grep2rg-native')), `the real npm postinstall compiles the shipped source on the target:\n${installed.stdout}\n${installed.stderr}`);
  const nativeInstalled=command(process.execPath,['--test','--test-reporter=tap',join(installedPackage,'tests/test_grep_auto_native.mjs')],cwd);
  assert.match(nativeInstalled.stdout,/allStdoutStderrStatusExact/);
  const installedEvidence = entryChecks(installedPackage, cwd, join(installation, 'node_modules/.bin/grep2rg'), join(installation, 'node_modules/.bin/grep2rg-shell-prefix'));
  t.diagnostic(JSON.stringify({ campaign: 'packed-artifact', tarballSHA256: hash(archive), npmIntegrity: record.integrity, extractedFilesVerified: expected.length, extractedEntryNodeTests: 5, installedEntryNodeTests: 5, extractedEvidence, installedEvidence }));
});
