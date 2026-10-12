import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture } from './grep_extended_helpers.mjs';

const launcher = fileURLToPath(new URL('../bin/grep2rg', import.meta.url));

test('complete ASCII subjects accelerate UTF-8 locale folding, words and GNU classes', (t) => {
  const f = fixture(t); f.put('ascii', 'KIWI kiwi Kiwi kiwi_\nk K i I pie _pie foo42\n');
  const cases = [
    ['-i', 'kiwi'], ['-Fi', 'kiwi'], ['-in', 'K'], ['-i', 'I'], ['-w', 'kiwi'], ['-wc', 'pie'],
    ['-E', '[[:alpha:]]+'], ['-G', '[[:upper:]]'], ['-Ei', '[[:upper:]]+'], ['-Ew', '[a-z]+'],
    ['-aFi', 'kiwi'], ['-aE', '[[:alnum:]]+'], ['-iw', 'KIWI'], ['-iC1', 'kiwi'],
  ];
  for (const locale of ['C.UTF-8', 'C.utf8']) for (const args of cases) f.compare([...args, 'ascii'], { locale });
  t.diagnostic(JSON.stringify(f.diagnostic('extended-ASCII-locale-proof')));
});

test('PCRE-only POSIX class names retain exact GNU BRE and ERE diagnostics', (t) => {
  const f = fixture(t); f.put('ascii', 'word ascii 42\n');
  for (const mode of ['-G', '-E']) for (const name of ['word', 'ascii']) for (const locale of ['C', 'C.UTF-8'])
    f.compare(['-a', mode, `[[:${name}:]]`, 'ascii'], { locale, accelerated: false });
  t.diagnostic(JSON.stringify(f.diagnostic('extended-GNU-invalid-POSIX-class')));
});

test('literal multiple patterns retain GNU leftmost longest extraction and highlight spans', (t) => {
  const f = fixture(t);
  f.put('subject', Buffer.concat([Buffer.from('ababa abab a ab abc zabc abcde\nza aa aba abaaba\nempty\n'), Buffer.from([0xff]), Buffer.from('ababa'), Buffer.from([0xfe, 10])]));
  f.put('nul', Buffer.from('ab\nababa\0none\0ababa\0'));
  const patterns = [['a', 'ab'], ['ab', 'a'], ['aba', 'ab'], ['abc', 'b', 'c'], ['a', ''], ['', 'ab'], ['aba', 'aba'], [''], ['a\nab']];
  const flags = [['-o'], ['-nboH'], ['--color=always'], ['-n', '--color=always', '-C1'], ['-v', '--color=always', '-C1']];
  for (const mode of ['-F', '-G', '-E']) for (const needles of patterns) for (const output of flags)
    f.compare(['-a', mode, ...output, ...needles.flatMap((needle) => ['-e', needle]), 'subject'],
      { accelerated: !(output.includes('-v') && (needles.includes('') || needles.some((needle) => needle.split('\n').includes('')))) });
  for (const needles of patterns) f.compare(['-azFo', ...needles.flatMap((needle) => ['-e', needle]), 'nul']);
  f.put('patterns', 'a\nab\n'); f.compare(['-aFo', '-f', 'patterns', 'subject']);
  t.diagnostic(JSON.stringify(f.diagnostic('extended-literal-leftmost-longest')));
});

test('fixed word and whole-line extraction uses real rg plus observed GNU candidate spans', (t) => {
  const f = fixture(t);
  const outputs = [['-o'], ['-o', '-n', '-b', '-H'], ['-o', '--color=always'],
    ['-o', '--color=always', '-m1', '-A2'], ['-o', '-v', '-C1'], ['-o', '-i']];
  for (const [nullData, delimiter] of [[false, '\n'], [true, '\0']]) {
    const operand = nullData ? 'whole.nul' : 'whole.txt';
    f.put(operand, ['foo', 'xx', 'foo', 'FOO', 'foo', 'tail', ''].join(delimiter));
    for (const locale of ['C', 'C.UTF-8']) for (const colors of ['', 'ms=:mc=:ne']) {
      f.env.GREP_COLORS = colors;
      for (const output of outputs) f.compare(['-aF', '-w', '-x', ...(nullData ? ['-z'] : []), ...output,
        '-e', 'foo', '--', operand, operand], { locale, spanBroker: true });
    }
  }
  t.diagnostic(JSON.stringify(f.diagnostic('extended-fixed-word-whole-line-extraction')));
});

test('fixed word whole-line extraction preserves Unicode folding and scoped calls', (t) => {
  const f = fixture(t);
  f.env.GREP_COLORS = 'ms=31:mc=35:ne';
  for (const [nullData, delimiter] of [[false, '\n'], [true, '\0']]) {
    const operand = nullData ? 'unicode-whole.nul' : 'unicode-whole.txt';
    f.put(operand, ['I', 'i', 'ı', 'İ', 'K', 'k', 'K', 'Σ', 'σ', 'ς', 'é', 'É', 'none', ''].join(delimiter));
    for (const needle of ['I', 'k', 'σ', 'é']) for (const output of [['-o', '-n', '-b'], ['-o', '--color=always', '-C1']])
      f.compare(['-aF', '-w', '-x', '-i', ...(nullData ? ['-z'] : []), ...output, '-e', needle, '--', operand],
        { locale: 'C.UTF-8', spanBroker: true, route: 'private' });
  }
  t.diagnostic(JSON.stringify(f.diagnostic('extended-fixed-word-whole-line-Unicode')));
});

test('fixed word whole-line extraction preserves empty, punctuation and multiple pattern sources', (t) => {
  const f = fixture(t);
  f.put('patterns', 'foo\n@\n');
  const patterns = [['-e', ''], ['-e', '@'], ['-e', 'foo', '-e', 'foobar'], ['-e', 'foo', '-e', 'foo'],
    ['-e', 'foo', '-e', ''], ['-e', 'foo\n@'], ['-f', 'patterns']];
  for (const [nullData, delimiter] of [[false, '\n'], [true, '\0']]) {
    const operand = nullData ? 'pattern-records.nul' : 'pattern-lines.txt';
    f.put(operand, ['', '@', 'foo', 'foobar', 'foo_bar', 'none', '', 'foo', ''].join(delimiter));
    for (const source of patterns) for (const output of [['-o', '-n', '-b'], ['-o', '--color=always', '-C1']])
      f.compare(['-aF', '-w', '-x', ...(nullData ? ['-z'] : []), ...output, ...source, '--', operand], { spanBroker: true });
  }
  t.diagnostic(JSON.stringify(f.diagnostic('extended-fixed-word-whole-line-pattern-sources')));
});

test('Linux binary I/O flag preserves its no-op GNU semantics through actual rg', (t) => {
  assert.equal(process.platform, 'linux', 'this release verification qualifies the Linux binary I/O flag');
  const f = fixture(t); f.put('text', 'needle\nnone\nneedle needle\n');
  f.put('nul', 'needle\nwrap\0none\0needle\0');
  f.put('bytes', Buffer.concat([Buffer.from('needle\n'), Buffer.from([0xff, 0xfe, 10]), Buffer.from('needle\n')]));
  const cases = [['-aF', '-n', 'needle', 'text'], ['-F', '-n', 'needle', 'text'],
    ['-aF', '-o', '--color=always', 'needle', 'text'], ['-aF', '-v', '-C1', 'needle', 'text'],
    ['-I', '-cF', 'needle', 'text'], ['-F', '-z', '-x', '-o', 'needle', 'nul'],
    ['-aF', '-c', 'needle', 'bytes'], ['-aFw', '-l', 'needle', 'text'], ['-aF', '-q', 'needle', 'text']];
  for (const locale of ['C', 'C.UTF-8']) for (const flag of ['-U', '--binary'])
    for (const argv of cases) f.compare([flag, ...argv], { locale });
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Linux-binary-I/O-noop')));
});

test('Linux binary I/O flag retains native binary, invalid syntax and caller stream boundaries', (t) => {
  const f = fixture(t); f.put('text', 'needle\nnone\n'); f.put('binary', 'head\0needle\ntail\n');
  f.put('malformed', Buffer.concat([Buffer.from('needle\n'), Buffer.from([0xff, 10])]));
  for (const flag of ['-U', '--binary']) {
    for (const argv of [['-F', 'needle', 'binary'], ['-I', '-F', 'needle', 'binary'], ['-aE', '[', 'text']])
      f.compare([flag, ...argv], { accelerated: false });
    f.compare([flag, '-F', 'needle', 'malformed'], { locale: 'C.UTF-8', accelerated: false });
    f.compare([flag, '-aF', '-m1', 'needle'], { input: Buffer.from('head\nneedle\ntail\n'), accelerated: false });
    f.compare([flag, '-F', 'needle'], { input: Buffer.from('head\0needle\ntail\n'), accelerated: false });
  }
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Linux-binary-I/O-native-boundaries')));
});

test('max-count trailing context retains GNU literal coloring and inverse neighboring behavior', (t) => {
  const f = fixture(t); f.put('context', 'abab\nnone\nababa\nother\nabab\n');
  for (const args of [
    ['-aF', '--color=always', '-m1', '-A2'],
    ['-aFv', '--color=always', '-m1', '-A2'],
    ['-aF', '--color=always', '-m1', '-B1', '-A2'],
    ['-aFv', '--color=always', '-m1', '-B1', '-A2'],
  ]) f.compare([...args, '-e', 'a', '-e', 'ab', 'context']);
  t.diagnostic(JSON.stringify(f.diagnostic('extended-literal-maxcount-context')));
});

test('NUL records accelerate GNU BRE and ERE anchors, dot, words and whole-record matching', (t) => {
  const f = fixture(t);
  f.put('records', Buffer.from('ab\naba\0\0abc\n\0line\nlast\0a]b^$\0slash\\end\0word word_\0'));
  const patterns = ['^ab', 'ab$', '^ab.aba$', 'ab.aba', '^$', '[]a]', '[$^]', '^slash\\\\end$', 'word'];
  for (const mode of ['-G', '-E']) for (const pattern of patterns) for (const flags of [['-z'], ['-az'], ['-zn'], ['-zc']])
    f.compare([mode, ...flags, pattern, 'records']);
  for (const mode of ['-F', '-G', '-E']) for (const flags of [['-zx'], ['-azx'], ['-zw'], ['-azw']])
    for (const pattern of ['ab\naba', 'abc', 'word']) f.compare([mode, ...flags, pattern, 'records']);
  t.diagnostic(JSON.stringify(f.diagnostic('extended-NUL-record-regex')));
});

test('NUL text classification preserves UTF-8 boundaries and malformed-byte native handling', (t) => {
  const f = fixture(t);
  f.put('valid', Buffer.from('head\nneedle\0\u00e9 needle\n\0\0last needle\0'));
  f.put('invalid', Buffer.concat([Buffer.from('needle\0'), Buffer.from([0xff]), Buffer.from('needle\0')]));
  for (const mode of ['-F', '-G', '-E']) for (const flags of [['-z'], ['-zI'], ['-zn'], ['-zc']]) {
    f.compare([mode, ...flags, 'needle', 'valid'], { locale: 'C.UTF-8' });
    f.compare([mode, ...flags, 'needle', 'invalid'], { locale: 'C.UTF-8', accelerated: false });
  }
  t.diagnostic(JSON.stringify(f.diagnostic('extended-NUL-UTF8-proof')));
});

test('actual rg preserves inverse NUL max-count and trailing context boundaries', (t) => {
  const f = fixture(t);
  f.put('records', Buffer.from(['x', 'needle', 'x', 'x', 'x', 'x', 'x'].join('\0') + '\0'));
  f.compare(['-azFv', '-m1', '-A3', 'needle', 'records']);
  for (const mode of ['-F', '-G', '-E']) for (const maximum of [1, 2, 3]) for (const context of ['-A1', '-A3', '-C1'])
    for (const output of [[], ['-n'], ['-c'], ['-o'], ['--color=always']])
      f.compare(['-azv', mode, `-m${maximum}`, context, ...output, 'needle', 'records']);
  t.diagnostic(JSON.stringify(f.diagnostic('extended-NUL-inverse-maxcount-context')));
});

test('rg selection plus GNU candidate-only spans preserves POSIX extraction, highlighting and prefixes', (t) => {
  const f = fixture(t); f.put('subject', 'ababa abab\nNO-MATCH-RECORD\nabc ab\nnone\naaa\n');
  const patterns = [['-E', 'a|ab'], ['-E', '(a|ab)+'], ['-E', 'a*'], ['-G', 'a\\|ab'], ['-G', '\\(a\\|ab\\)\\+'], ['-G', 'a*']];
  const outputs = [['-o'], ['-nboH'], ['--color=always'], ['--color=always', '-C1'], ['--color=always', '-m1', '-A2'], ['-v', '--color=always', '-C1']];
  for (const locale of ['C', 'C.UTF-8']) for (const [mode, pattern] of patterns) for (const output of outputs)
    f.compare(['-a', mode, ...output, pattern, 'subject'], { locale, spanBroker: true });
  for (const flags of [['-aFio'], ['-aFwo'], ['-aF', '-i', '--color=always'], ['-aF', '-w', '--color=always']])
    f.compare([...flags, '-e', 'ab', '-e', 'aba', 'subject'], { spanBroker: true });
  f.put('nul', Buffer.from('ab\nababa\0none\0ababa\0'));
  for (const [mode, pattern] of [['-E', 'a|ab'], ['-E', 'ab.aba'], ['-G', 'a\\|ab']])
    f.compare(['-a', mode, '-zno', pattern, 'nul'], { spanBroker: true });
  for (const pattern of ['[', '(']) f.compare(['-aEo', pattern, 'subject'], { accelerated: false });
  t.diagnostic(JSON.stringify(f.diagnostic('extended-POSIX-candidate-spans')));
});

test('the GNU span helper receives only records independently selected by rg', (t) => {
  const f = fixture(t); f.put('subject', 'ababa\nNO-MATCH-RECORD\nabc ab\nnone\naaa\n');
  const selected = spawnSync('/usr/bin/grep', ['-aE', 'a|ab', 'subject'], { cwd: f.cwd, env: f.env, argv0: 'grep' });
  assert.equal(selected.status, 0);
  f.compare(['-aEo', 'a|ab', 'subject'], { spanBroker: true });
  const candidates = f.calls().filter((call) => call.candidateHex !== undefined).map((call) => Buffer.from(call.candidateHex, 'hex'));
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], selected.stdout);
  assert.equal(candidates[0].includes(Buffer.from('NO-MATCH-RECORD')), false);
  t.diagnostic(JSON.stringify({ ...f.diagnostic('extended-POSIX-selected-records'), candidateBytes: candidates[0].length }));
});

test('multiple BRE and ERE pattern operands retain each GNU pattern local backreference numbers', (t) => {
  const f = fixture(t); f.put('captures', 'aa\nbb\naab\nbaa\nabab\nbccb\ncdeedc\ndd\nnone\n');
  const variants = [
    ['(a)\\1', '(b)\\1'],
    ['(a)(b)\\1\\2', '(b)\\1', '(c)(d)(e)\\3\\2\\1'],
    ['(a)\\1', '(b)(c)\\2\\1', '(d)\\1'],
  ];
  for (const locale of ['C', 'C.UTF-8']) for (const mode of ['-E', '-G']) for (const patterns of variants) {
    const operands = patterns.flatMap((pattern) => ['-e', mode === '-G' ? pattern.replace(/[()]/g, '\\$&') : pattern]);
    for (const output of [[], ['-nboH'], ['--color=always', '-C1']])
      f.compare(['-a', mode, ...output, ...operands, 'captures'], { locale, spanBroker: output.length > 0 });
    f.compare(['-a', mode, ...operands, 'captures'], { locale, route: 'private' });
  }
  t.diagnostic(JSON.stringify({ ...f.diagnostic('extended-pattern-local-backreferences'), independentPatternCaptureCounts: [1, 2, 3], privateBashComparisons: 12 }));
});

test('cancelling an owned GNU span broker removes private spools and publishes no partial records', async (t) => {
  const f = fixture(t); f.put('subject', 'ababa\nnone\n');
  const spools = join(f.cwd, 'spools'); mkdirSync(spools);
  const ready = join(f.cwd, 'broker-ready');
  const fake = `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const argv=process.argv.slice(2);if(/\\/grep2rg-posix-[^/]+\\/candidate-records$/.test(argv.at(-1))){process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});process.on('SIGHUP',()=>{});fs.writeFileSync(process.env.GREP2RG_BROKER_READY,String(process.pid));setInterval(()=>{},1000);}else{const r=cp.spawnSync('/usr/bin/grep',argv,{stdio:'inherit',argv0:'grep'});process.exitCode=r.status??2;}\n`;
  writeFileSync(join(f.bin, 'grep'), fake, { mode: 0o700 });
  const { existsSync, readdirSync } = await import('node:fs');
  for (const [signal, expectedStatus] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    rmSync(ready, { force: true });
    const child = spawn(launcher, ['-aEo', 'a|ab', 'subject'], { cwd: f.cwd,
      env: { ...f.env, TMPDIR: spools, GREP2RG_BROKER_READY: ready }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = []; child.stdout.on('data', (chunk) => out.push(chunk)); child.stderr.on('data', (chunk) => err.push(chunk));
    const completion = new Promise((resolve) => child.once('close', (code, killed) => resolve({ code, killed })));
    let brokerPid, timeout;
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(existsSync(ready), 'owned broker reached its registered signal handlers');
      brokerPid = Number(readFileSync(ready, 'utf8'));
      assert.ok(readdirSync(spools).some((name) => name.startsWith('grep2rg-posix-')));
      child.kill(signal);
      const result = await Promise.race([completion, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('owned broker cancellation deadline')), 5000); })]);
      assert.deepEqual(result, { code: expectedStatus, killed: null });
      assert.deepEqual(Buffer.concat(out), Buffer.alloc(0)); assert.deepEqual(Buffer.concat(err), Buffer.alloc(0));
      assert.deepEqual(readdirSync(spools), [], 'private candidate/event/span files are removed');
      assert.throws(() => process.kill(brokerPid, 0), { code: 'ESRCH' });
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (brokerPid) { try { process.kill(brokerPid, 'SIGKILL'); } catch {} }
    }
  }
  t.diagnostic(JSON.stringify({ campaign: 'extended-POSIX-broker-cancellation', ownedSignals: 3, ignoredSignalHelpersReaped: 3, partialOutputBytes: 0 }));
});
