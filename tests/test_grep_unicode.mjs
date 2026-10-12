import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from './grep_extended_helpers.mjs';
import { parseGrepOptions } from '../src/grep-options.mjs';
import { unicodeMatcherArgs } from '../src/grep-unicode.mjs';

test('Unicode regex subjects use native scalar proof while proof-required stdin retains GNU ownership', (t) => {
  const f = fixture(t); f.put('unicode', 'KIWI kiwi\n\u212a K k \u0130 I i \u0131 \u00e9 foo42\n');
  for (const args of [['-i', 'kiwi'], ['-Gi', 'k'], ['-iw', 'I'], ['-w', 'kiwi'], ['-E', '[[:alpha:]]+'], ['-aEi', '[[:upper:]]+']])
    f.compare([...args, 'unicode'], { locale: 'C.UTF-8' });
  f.compare(['-ai', 'kiwi'], { locale: 'C.UTF-8', accelerated: false, input: Buffer.from('KIWI kiwi\n') });
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Unicode-regex-locale-proof')));
});

test('actual rg searches Unicode fixed case folds and GNU word classes from synthetic scalar probes', (t) => {
  const f = fixture(t);
  f.put('unicode', 'kiwi\n\u00e9kiwi\u00e9\n_kiwi_\n\u03c0kiwi\u03c0\n\u212a K k\n\u017f S s\n\u0130 I i \u0131\n\u03a3 \u03c3 \u03c2\n\u00df \u1e9e SS ss\n\u00e9 \u00c9 e\u0301\n\u03c0 \u03a0\n');
  for (const pattern of ['k', 'i', 's', '\u03c3', '\u00df', '\u00e9', '\u03c0']) for (const flags of [['-Fi'], ['-Fin'], ['-Fic']])
    f.compare([...flags, pattern, 'unicode'], { locale: 'C.UTF-8' });
  for (const pattern of ['kiwi', 'k', '\u00e9', '\u03c0']) for (const flags of [['-Fw'], ['-Fiw'], ['-Fwno']])
    f.compare([...flags, pattern, 'unicode'], { locale: 'C.UTF-8' });
  for (const flags of [['-Fio'], ['-Fi', '--color=always'], ['-Fiw', '--color=always', '-C1']])
    f.compare([...flags, '-e', 'k', '-e', 'kiwi', 'unicode'], { locale: 'C.UTF-8', spanBroker: true });
  assert.ok(f.calls().some((call) => call.argv.at(-1)?.endsWith('/unicode-scalars-v1.nul')), 'GNU sees only the owned synthetic scalar corpus for Unicode tables');
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Unicode-fixed-scalar-proof')));
});

test('a private Unicode table cache avoids repeated scalar scans while actual rg still searches operands', (t) => {
  const f = fixture(t); f.put('unicode', '\u212a K k\n');
  f.compare(['-Fi', 'k', 'unicode'], { locale: 'C.UTF-8' });
  const before = f.calls().length;
  f.compare(['-Fi', 'k', 'unicode'], { locale: 'C.UTF-8' });
  const warm = f.calls().slice(before);
  assert.equal(warm.filter((call) => call.argv.at(-1)?.endsWith('/unicode-scalars-v1.nul')).length, 0);
  assert.ok(warm.some((call) => call.engine === 'rg' && call.argv.includes('--json')));
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Unicode-cache-warm')));
});

test('corrupt Unicode tables and changed GNU executable identity force fresh scalar proof', (t) => {
  const f = fixture(t); f.put('unicode', '\u212a K k\n');
  f.compare(['-Fi', 'k', 'unicode'], { locale: 'C.UTF-8' });
  const tables = readdirSync(f.unicodeCache).filter((name) => name.endsWith('.json'));
  assert.equal(tables.length, 1);
  writeFileSync(join(f.unicodeCache, tables[0]), '{"key":"invalid","ranges":[[107,107]],"checksum":"invalid"}');
  let before = f.calls().length;
  f.compare(['-Fi', 'k', 'unicode'], { locale: 'C.UTF-8' });
  assert.ok(f.calls().slice(before).some((call) => call.argv.at(-1)?.endsWith('/unicode-scalars-v1.nul')));
  const recorder = join(f.bin, 'grep');
  writeFileSync(recorder, `${readFileSync(recorder, 'utf8')}\n# owned synthetic GNU recorder identity change\n`);
  before = f.calls().length;
  f.compare(['-Fi', 'k', 'unicode'], { locale: 'C.UTF-8' });
  assert.ok(f.calls().slice(before).some((call) => call.argv.at(-1)?.endsWith('/unicode-scalars-v1.nul')));
  t.diagnostic(JSON.stringify({ ...f.diagnostic('extended-Unicode-cache-integrity'), corruptTableReprobed: true, executableIdentityChangeReprobed: true }));
});

test('Unicode fixed malformed subjects and stream ownership stay native before any scalar proof', (t) => {
  const f = fixture(t); f.put('invalid', Buffer.from([0x4b, 10, 0xff, 10]));
  for (const flags of [['-Fi'], ['-aFi'], ['-Fw']]) f.compare([...flags, 'k', 'invalid'], { locale: 'C.UTF-8', accelerated: false });
  f.compare(['-aFi', 'k'], { locale: 'C.UTF-8', input: Buffer.from('\u212a K k\n'), accelerated: false });
  assert.equal(f.calls().filter((call) => call.argv.at(-1)?.endsWith('/unicode-scalars-v1.nul')).length, 0);
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Unicode-fixed-native-boundaries')));
});

test('Unicode GNU brackets, scalar classes, ranges and word escapes select actual rg records', (t) => {
  const f = fixture(t);
  f.put('unicode', 'AaZz09 _\t \u00a0\u2003\n\u00e9 \u00c9 \u03c0 \u03a0 \u03c3 \u03a3 \u03c2\n\u212a K k \u017f S s \u0130 I i \u0131\n\u00df \u1e9e \u4e2d \u0662\nkiwi\n\u00e9kiwi\u00e9\n_kiwi_\n\u0301kiwi\u0301\n');
  const patterns = [
    ...['alnum', 'alpha', 'blank', 'cntrl', 'digit', 'graph', 'lower', 'print', 'punct', 'space', 'upper', 'xdigit'].map((name) => `[[:${name}:]]+`),
    '[a-z]+', '[A-Z]+', '[^[:alpha:]]+', '[\u00e9\u03c0]+',
    '\\w+', '\\W+', '\\s+', '\\S+', '\\bkiwi\\b', '\\Bkiwi\\B', '\\<kiwi\\>',
  ];
  for (const mode of ['-G', '-E']) for (const pattern of patterns) for (const flags of [['-an'], ['-ac'], ['-ano']])
    f.compare([mode, ...flags, pattern, 'unicode'], { locale: 'C.UTF-8', spanBroker: flags.includes('-ano') });
  for (const pattern of ['[[:upper:]]+', '[a-z]+', '[\u00e9\u03c0]+'])
    f.compare(['-aEin', pattern, 'unicode'], { locale: 'C.UTF-8' });
  for (const mode of ['-G', '-E']) f.compare(['-a', mode, '[\u00c0-\u00ff]+', 'unicode'], { locale: 'C.UTF-8', accelerated: false });
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Unicode-scalar-regex')));
});

test('Unicode class subroutines preserve GNU numbered captures across BRE, ERE and multiple patterns', (t) => {
  const f = fixture(t); f.put('captures', '\u00e9\u00e9 \u03c0\u03c0 aa abba \u00e9\u03c0\u03c0\u00e9\n\u00e922\u00e9 \u03c033\u03c0\n\u00e9\u00e9 \u00e9\u00e9\nword word\nnone\n');
  const patterns = [
    ['-E', '([[:alpha:]])\\1'], ['-G', '\\([[:alpha:]]\\)\\1'],
    ['-E', '(\\w)(\\w)\\2\\1'], ['-G', '\\(\\w\\)\\(\\w\\)\\2\\1'],
    ['-E', '(\u00e9|\u03c0)([[:digit:]])\\2\\1'], ['-G', '\\(\u00e9\\|\u03c0\\)\\([[:digit:]]\\)\\2\\1'],
    ['-E', '(\\w+)[[:space:]]\\1'], ['-G', '\\(\\w\\+\\)[[:space:]]\\1'],
  ];
  for (const [mode, pattern] of patterns) for (const flags of [['-an'], ['-ano'], ['-a', '--color=always', '-C1']])
    f.compare([mode, ...flags, pattern, 'captures'], { locale: 'C.UTF-8', spanBroker: !flags.includes('-an') });
  for (const mode of ['-G', '-E']) {
    const selected = patterns.filter(([matcher]) => matcher === mode).slice(0, 3).flatMap(([, pattern]) => ['-e', pattern]);
    f.compare(['-ano', mode, ...selected, 'captures'], { locale: 'C.UTF-8', spanBroker: true });
  }
  for (const [mode, pattern] of patterns.slice(0, 2)) f.compare(['-ain', mode, pattern, 'captures'], { locale: 'C.UTF-8', accelerated: false });
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Unicode-capture-indices')));
});

test('Unicode scalar membership preserves NUL content and NUL record regex outputs', (t) => {
  const f = fixture(t); f.put('nul', Buffer.from('\u00e9\0\u03c0\n\u00e9\0\0\u00e9\u00e9\0\u212a k\0'));
  const cases = [
    ['-aEn', '[^[:alpha:]]+'], ['-aEo', '[^[:alpha:]]+'], ['-aGn', '\\W'], ['-aGo', '\\W'],
    ['-azEn', '[[:alpha:]]+'], ['-azEo', '[[:alpha:]]+'], ['-azGn', '\\w'], ['-azGo', '\\w'],
    ['-azEn', '^[[:alpha:]].[[:alpha:]]$'], ['-azEo', '^[[:alpha:]].[[:alpha:]]$'],
    ['-azGn', '\\([[:alpha:]]\\)\\1'], ['-azGo', '\\([[:alpha:]]\\)\\1'],
    ['-azFin', 'k'], ['-azFio', 'k'],
  ];
  for (const argv of cases) f.compare([...argv, 'nul'], { locale: 'C.UTF-8', spanBroker: argv[0].includes('o') && !argv[0].includes('F') });
  t.diagnostic(JSON.stringify(f.diagnostic('extended-Unicode-NUL-membership')));
});

test('multi-character Czech collation retains original GNU instead of scalar-only record selection', (t) => {
  const f = fixture(t); f.put('collation', 'ch\nCh\nCH\nc\nd\n');
  const generator = spawnSync('localedef', ['--version'], { encoding: 'utf8', timeout: 5000 });
  const haveDefinitions = existsSync('/usr/share/i18n/locales/cs_CZ') &&
    (existsSync('/usr/share/i18n/charmaps/UTF-8.gz') || existsSync('/usr/share/i18n/charmaps/UTF-8'));
  const haveGenerator = !generator.error && generator.status === 0 && haveDefinitions;
  if (haveGenerator) {
    const locales = join(f.cwd, 'locales'); mkdirSync(locales);
    const result = spawnSync('localedef', ['--no-archive', '-i', 'cs_CZ', '-f', 'UTF-8', join(locales, 'cs_CZ.UTF-8')], { timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr.toString());
    f.env.LOCPATH = locales;
    const witness = spawnSync('/usr/bin/grep', ['-aEx', '[^c-d]', 'collation'], { cwd: f.cwd, env: { ...f.env, LC_ALL: 'cs_CZ.UTF-8' } });
    assert.equal(witness.status, 0); assert.deepEqual(witness.stdout, Buffer.from('ch\nCh\nCH\n'));
  }
  for (const [mode, pattern] of [['-E', '[^c-d]'], ['-G', '[^c-d]'], ['-E', '[[:alpha:]]'], ['-G', '[[:alpha:]]']])
    f.compare(['-ax', mode, pattern, 'collation'], { locale: 'cs_CZ.UTF-8', accelerated: false });
  t.diagnostic(JSON.stringify({ ...f.diagnostic('extended-Czech-multichar-collation'), ownedLocaleCompiled: haveGenerator,
    ...(haveGenerator ? {} : { coverageLimitation: 'Native guard verified; Czech multichar oracle not exercised because optional localedef/i18n definitions are absent.' }) }));
});

test('same-process custom LOCPATH replacement cannot reuse stale English scalar folds for Turkish', (t) => {
  const f = fixture(t); f.put('letters', 'I\ni\n\u0131\n\u0130\n');
  for (const name of ['en_GB', 'tr_TR']) assert.ok(existsSync(`/usr/share/i18n/locales/${name}`), `verification requires glibc locale definition ${name}`);
  const active = join(f.cwd, 'active-locales'), replacement = join(f.cwd, 'replacement-locales'); mkdirSync(active); mkdirSync(replacement);
  for (const [input, directory] of [['en_GB', active], ['tr_TR', replacement]]) {
    const built = spawnSync('localedef', ['--no-archive', '-i', input, '-f', 'UTF-8', join(directory, 'audit.UTF-8')], { timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(built.error, undefined, 'localedef is required for the custom locale cache regression');
    assert.equal(built.status, 0, built.stderr.toString());
  }
  const env = { ...f.env, LOCPATH: active, LC_ALL: 'audit.UTF-8' };
  const argv = ['-aFi', 'I', 'letters'], options = parseGrepOptions(argv, { env });
  const outcomes = [];
  for (const localeSource of ['en_GB', 'tr_TR']) {
    const args = unicodeMatcherArgs(options, ['I'], { env });
    const expected = spawnSync('/usr/bin/grep', argv, { cwd: f.cwd, env, argv0: 'grep', timeout: 10000 });
    const actual = spawnSync('rg', ['--no-config', '--text', ...args, '--', 'letters'], { cwd: f.cwd, env, timeout: 10000 });
    for (const result of [expected, actual]) { assert.equal(result.error, undefined); assert.equal(result.signal, null); }
    assert.equal(actual.status, expected.status); assert.deepEqual(actual.stdout, expected.stdout); assert.deepEqual(actual.stderr, expected.stderr);
    const records = expected.stdout.toString('utf8').trimEnd().split('\n');
    assert.equal(records.includes('i'), localeSource === 'en_GB', 'Turkish I folding changes the independently observed GNU match set');
    assert.ok(records.includes('I')); assert.ok(records.includes('\u0131'));
    outcomes.push(actual.stdout.toString('hex'));
    if (localeSource === 'en_GB') {
      renameSync(join(active, 'audit.UTF-8'), join(f.cwd, 'saved-english-locale'));
      renameSync(join(replacement, 'audit.UTF-8'), join(active, 'audit.UTF-8'));
    }
  }
  assert.notEqual(outcomes[0], outcomes[1]);
  t.diagnostic(JSON.stringify({ campaign: 'extended-Unicode-custom-locale-swap', actualGNUComparisons: 2, actualRgSearchInvocations: 2,
    sameProcess: true, unchangedLOCPATH: true, ownedLocaleDefinitions: ['en_GB', 'tr_TR'], observedMatchingSetsDiffer: true }));
});
