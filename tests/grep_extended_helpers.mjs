import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withGrepWrapper } from '../src/grep-wrapper.mjs';

const launcher = fileURLToPath(new URL('../bin/grep2rg', import.meta.url));
export function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-extended-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', GREP_COLORS: '', GREP_COLOR: '', TERM: 'dumb' };
  delete env.POSIXLY_CORRECT;
  const real = spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-c', 'command -v rg'], { env, encoding: 'utf8' });
  assert.equal(real.status, 0, 'real rg is mandatory');
  const bin = join(cwd, 'bin'), trace = join(cwd, 'calls.jsonl'); mkdirSync(bin); writeFileSync(trace, '');
  const unicodeCache = join(cwd, 'unicode-cache'); mkdirSync(unicodeCache, { mode: 0o700 });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const [name, target] of [['rg', real.stdout.trim()], ['grep', '/usr/bin/grep']]) {
    const record = `const fs=require('node:fs');const argv=process.argv.slice(1);const record={engine:${JSON.stringify(name)},argv};if(record.engine==='grep'&&/\\/grep2rg-posix-[^/]+\\/candidate-records$/.test(argv.at(-1))&&fs.statSync(argv.at(-1)).size<=8192)record.candidateHex=fs.readFileSync(argv.at(-1)).toString('hex');fs.appendFileSync(process.env.GREP2RG_TRACE,JSON.stringify(record)+'\\n');`;
    writeFileSync(join(bin, name), `#!/usr/bin/bash\n${quote(process.execPath)} -e ${quote(record)} -- "$@"\nexec -a ${quote(name)} ${quote(target)} "$@"\n`, { mode: 0o700 });
  }
  const environment = { ...env, PATH: `${bin}:${process.env.PATH}`, GREP2RG_TRACE: trace, GREP2RG_UNICODE_CACHE: unicodeCache };
  const calls = () => readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const metrics = { actualGNUComparisons: 0, actualRgSearchInvocations: 0, actualNativeInvocations: 0, actualGNUSpanBrokerInvocations: 0, actualGNUValidationInvocations: 0, actualGNUScalarProbeInvocations: 0, actualGNUIdentityInvocations: 0 };
  function compare(argv, { locale = 'C', accelerated = true, spanBroker = false, input, route = 'public' } = {}) {
    const before = calls().length;
    const options = { cwd, env: { ...environment, LC_ALL: locale }, input, timeout: 10000, maxBuffer: 4 * 1024 * 1024 };
    const expected = spawnSync('/usr/bin/grep', argv, { ...options, argv0: 'grep' });
    const actual = route === 'private' ? spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-c',
      withGrepWrapper({ command: 'grep "$@"' }, '/usr/bin/bash').command, 'owned-grep-descriptor-test', ...argv], options)
      : spawnSync(launcher, argv, options);
    for (const result of [expected, actual]) { assert.equal(result.error, undefined); assert.equal(result.signal, null); }
    assert.equal(actual.status, expected.status, JSON.stringify({ argv, locale, actualStderr: actual.stderr.toString().slice(0, 2000), invoked: calls().slice(before).map(({ engine, argv }) => ({ engine, argv })) }));
    assert.deepEqual(actual.stdout, expected.stdout, `stdout ${JSON.stringify({ argv, locale })}`);
    assert.deepEqual(actual.stderr, expected.stderr, `stderr ${JSON.stringify({ argv, locale })}`);
    const invoked = calls().slice(before), searches = invoked.filter((call) => call.engine === 'rg' && call.argv.includes('--json'));
    const gnu = invoked.filter((call) => call.engine === 'grep');
    const brokers = gnu.filter((call) => /\/grep2rg-posix-[^/]+\/candidate-records$/.test(call.argv.at(-1)));
    const validations = gnu.filter((call) => call.argv.at(-1) === '/dev/null');
    const scalarProbes = gnu.filter((call) => call.argv.at(-1)?.endsWith('/unicode-scalars-v1.nul') ||
      (call.argv[0] === '--text' && call.argv.includes('--quiet') && call.argv.includes('--line-regexp') && call.argv.includes('--regexp') && !call.argv.includes('--')));
    const identities = gnu.filter((call) => call.argv.includes('--version'));
    const native = gnu.filter((call) => !brokers.includes(call) && !validations.includes(call) && !scalarProbes.includes(call) && !identities.includes(call));
    metrics.actualGNUComparisons++; metrics.actualRgSearchInvocations += searches.length; metrics.actualNativeInvocations += native.length;
    metrics.actualGNUSpanBrokerInvocations += brokers.length; metrics.actualGNUValidationInvocations += validations.length;
    metrics.actualGNUScalarProbeInvocations += scalarProbes.length; metrics.actualGNUIdentityInvocations += identities.length;
    if (accelerated) {
      assert.ok(searches.length > 0, `actual rg required: ${JSON.stringify(argv)}`); assert.equal(native.length, 0);
      if (spanBroker) {
        if (expected.status === 0) assert.ok(brokers.length > 0, `GNU spans must come from private rg candidate records: ${JSON.stringify(argv)}`);
        assert.ok(validations.length > 0, 'GNU diagnostics must be checked before rg selection');
        for (const broker of brokers) for (const flag of ['--only-matching', '--line-number', '--byte-offset']) assert.ok(broker.argv.includes(flag));
      } else assert.equal(brokers.length, 0);
    } else { assert.equal(searches.length, 0); assert.deepEqual(native.map((call) => call.argv), [argv]); }
  }
  return { cwd, env: environment, bin, trace, unicodeCache, calls, put: (name, bytes) => writeFileSync(join(cwd, name), bytes), compare,
    diagnostic: (campaign) => ({ campaign, ...metrics, syntheticFixturesOnly: true }) };
}
