#!/usr/bin/env node
// Pack the real distribution, extract it and run its own immutable verification.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`NAME
  verify-artifact.mjs — verify the extracted npm release artifact

SYNOPSIS
  node tools/verify-artifact.mjs [--core | --deep] [--sdk] [--output FILE]

DESCRIPTION
  Create a real npm pack tarball, extract it into an owned temporary directory,
  and execute the packaged tools/verify.mjs with the requested tier. The default
  includes four bounded campaigns. No network request or preinstalled package
  dependency is required; the artifact test performs its own offline local install.

OPTIONS
  --core         Run focused CPU, launcher and packing checks.
  --deep         Run the larger bounded campaigns.
  --sdk          Also require GREP2RG_TEST_PI_ROOT for the optional Pi integration.
  --output FILE  Save verification JSON with the actual tarball identity.
  --help, -h     Print this text without packing.

OPERATION
  Packing and extraction have one-minute deadlines. The packaged verifier owns
  individual stage deadlines and rejects changed sources, skips and empty runs.
  Temporary artifacts are removed after verification; reports retain their hash.

EXAMPLES
  node tools/verify-artifact.mjs --core --output artifacts/package-core.json
  node tools/verify-artifact.mjs --deep --output artifacts/package-deep.json

FILES
  tools/verify.mjs  Packaged CPU and optional SDK verification runner.

PATHS
  Package source is relative to this script. Output is relative to your cwd.
  npm and tar must be installed, in addition to the verifier's dependencies.

SECURITY NOTES
  Tests and npm cache use owned temporary paths and synthetic data only.

EXIT STATUS
  0  The extracted artifact passed all requested verification stages.
  1  Packing, extraction or verification failed.
  2  The packaged verifier rejected command-line arguments.

AUTHORS
  Terrydaktal
`);
  process.exit(0);
}
let output;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--output' && args[index + 1]) {
    output = resolve(args[index + 1]); args[++index] = output;
  }
}
const owned = mkdtempSync(join(tmpdir(), 'grep2rg-verify-artifact-'));
function command(program, argv, cwd) {
  const result = spawnSync(program, argv, { cwd, env: { ...process.env, npm_config_cache: join(owned, 'npm-cache') }, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal) throw new Error(`${program} failed: ${result.error?.message ?? result.status ?? result.signal}\n${result.stderr?.slice(-8192) ?? ''}`);
  return result.stdout;
}
try {
  const manifest = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', owned], source));
  const records = Array.isArray(manifest) ? manifest : Object.values(manifest);
  if (records.length !== 1) throw new Error(`Expected one npm artifact; received ${records.length}.`);
  const record = records[0], archive = join(owned, record.filename), extraction = join(owned, 'extracted');
  mkdirSync(extraction);
  command('tar', ['-xzf', archive, '-C', extraction], owned);
  const artifact = { filename: record.filename, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), integrity: record.integrity, fileCount: record.files.length, verification: 'actual npm pack tarball, extracted tools/verify.mjs' };
  process.stdout.write(`Testing extracted ${artifact.filename}; SHA256 ${artifact.sha256}; ${artifact.fileCount} packaged files\n`);
  const packageRoot = join(extraction, 'package');
  const child = spawn(process.execPath, [join(packageRoot, 'tools/verify.mjs'), ...args], { cwd: packageRoot, env: process.env, stdio: 'inherit' });
  const interrupt = (signal) => { if (!child.killed) child.kill(signal); };
  const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  const result = await new Promise((done) => {
    child.once('error', (error) => done({ status: 1, error: error.message }));
    child.once('close', (status, signal) => done({ status: status ?? 1, signal }));
  });
  process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
  if (result.error) process.stderr.write(`${result.error}\n`);
  if (output && existsSync(output)) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    report.packageArtifact = artifact;
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.exitCode = result.status;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(owned, { recursive: true, force: true });
}
