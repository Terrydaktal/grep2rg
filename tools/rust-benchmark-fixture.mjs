import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// Keep these IDs and byte contents aligned with benchmark-routing.mjs. Large
// auxiliary trees are materialized separately so peak temporary data stays
// below 400 MiB without sparse files, shared inodes, or reduced workloads.
export const historicalClassIds = [
  'recursive-count', 'recursive-invert-count',
  'recursive-filenames-sparse', 'recursive-filenames-no-match',
  'explicit-count', 'explicit-filenames-sparse', 'explicit-filenames-no-match',
  'single-large-count-native', 'small-file-native', 'stdin-native',
  'regex-compatible-count', 'recursive-dense-filenames-native',
  'small-recursive-count-native', 'many-tiny-count-native',
  'below-threshold-count-native', 'long-record-count-native',
  'long-record-content-native', 'recursive-content', 'recursive-regex-content',
  'recursive-filter-native', 'recursive-dereference-native',
  'word-extraction-native', 'null-records-native', 'pattern-file-native',
  'quiet-native', 'binary-content-native', 'unicode-folding-native',
  'context-native',
];

export function specifications(fixture) {
  const { tree, paths, single, input, dense, smallTree, tiny, near, long,
    patterns, binary, inventories } = fixture;
  const rows = [
    ['recursive-count', ['-arcF', 'needle', tree], 'count', 'corpus'],
    ['recursive-invert-count', ['-arcvF', 'needle', tree], 'count', 'corpus'],
    ['recursive-filenames-sparse', ['-rlF', 'needle', tree], 'filenames', 'corpus'],
    ['recursive-filenames-no-match', ['-rlF', 'absent', tree], 'filenames', 'corpus'],
    ['explicit-count', ['-acF', 'needle', ...paths], 'count', 'corpus'],
    ['explicit-filenames-sparse', ['-lF', 'needle', ...paths], 'filenames', 'corpus'],
    ['explicit-filenames-no-match', ['-lF', 'absent', ...paths], 'filenames', 'corpus'],
    ['single-large-count-native', ['-acF', 'needle', single], 'count', 'single'],
    ['small-file-native', ['-nF', 'needle', input], 'content', 'input'],
    ['stdin-native', ['-nF', 'needle'], 'content', 'stdin'],
    ['regex-compatible-count', ['-acE', '(padding|needle).*012', ...paths], 'count', 'corpus'],
    ['recursive-dense-filenames-native', ['-rlF', 'needle', dense], 'filenames', 'dense'],
    ['small-recursive-count-native', ['-arcF', 'needle', smallTree], 'count', 'smallTree'],
    ['many-tiny-count-native', ['-arcF', 'needle', tiny], 'count', 'tiny'],
    ['below-threshold-count-native', ['-arcF', 'needle', near], 'count', 'near'],
    ['long-record-count-native', ['-arcF', 'needle', long], 'count', 'long'],
    ['long-record-content-native', ['-arnF', 'needle', long], 'content', 'long'],
    ['recursive-content', ['-arnF', 'needle', tree], 'content', 'corpus'],
    ['recursive-regex-content', ['-arnE', 'needle|absent', tree], 'content', 'corpus'],
    ['recursive-filter-native', ['-arlF', '--include=*.txt', 'needle', tree], 'filenames', 'corpus'],
    ['recursive-dereference-native', ['-arlRF', 'needle', tree], 'filenames', 'corpus'],
    ['word-extraction-native', ['-aFwo', 'needle', input], 'content', 'input'],
    ['null-records-native', ['-azFc', 'needle', input], 'count', 'input'],
    ['pattern-file-native', ['-acF', '-f', patterns, input], 'count', 'input'],
    ['quiet-native', ['-aqF', 'needle', input], 'quiet', 'input'],
    ['binary-content-native', ['-nF', 'needle', binary], 'binary', 'binary'],
    ['unicode-folding-native', ['-aiF', 'K', input], 'content', 'input'],
    ['context-native', ['-aF', '-C', '3', 'needle', input], 'content', 'input'],
  ];
  return rows.map(([id, grepArgv, kind, group]) => {
    const flags = grepArgv[0];
    const recursive = flags.includes('r');
    const multiple = recursive || group === 'corpus';
    let inputPaths = inventories[group];
    if (id === 'recursive-filter-native') inputPaths = inputPaths.filter(p => p.endsWith('.txt'));
    const settings = ['--no-config', '--no-heading', '--color=never',
      '--hidden', '--no-ignore', '--encoding=none', '--no-unicode',
      flags.includes('a') ? '--text' : '--binary',
      multiple ? '--with-filename' : '--no-filename',
      flags.includes('n') ? '--line-number' : '--no-line-number'];
    if (flags.includes('F')) settings.push('--fixed-strings');
    if (flags.includes('v')) settings.push('--invert-match');
    if (flags.includes('R')) settings.push('--follow');
    if (flags.includes('w')) settings.push('--word-regexp');
    if (flags.includes('o')) settings.push('--only-matching');
    if (flags.includes('z')) settings.push('--null-data');
    if (flags.includes('i')) settings.push('--ignore-case');
    if (kind === 'count') settings.push('--count', '--include-zero');
    if (kind === 'filenames') settings.push('--files-with-matches');
    if (kind === 'quiet') settings.push('--quiet');
    if (id === 'recursive-filter-native') settings.push('--glob', '*.txt');
    if (id === 'context-native') settings.push('--context', '3', '--context-separator=--');
    const operands = recursive ? [grepArgv.at(-1)] :
      group === 'corpus' ? paths : group === 'stdin' ? [] : [inventories[group][0]];
    const patternArgs = id === 'pattern-file-native' ? ['--file', patterns] :
      ['--regexp', id.includes('no-match') ? 'absent' :
        id === 'regex-compatible-count' ? '(padding|needle).*012' :
        id === 'recursive-regex-content' ? 'needle|absent' :
        id === 'unicode-folding-native' ? 'K' : 'needle'];
    return {
      id, grepArgv, rgArgv: [...settings, ...patternArgs, '--', ...operands],
      rgInventoryArgv: ['--no-config', '--hidden', '--no-ignore', '--files',
        ...(flags.includes('R') ? ['--follow'] : []),
        ...(id === 'recursive-filter-native' ? ['--glob', '*.txt'] : []), '--', ...operands],
      kind, group, recursive, inputPaths, hasFilenamePrefix: multiple,
      stdin: group === 'stdin' ? Buffer.from('head\nneedle\ntail\n') : undefined,
      knownDifferences: [
        ...(kind === 'binary' ? ['GNU reports a binary match on stderr; rg --binary uses its own binary diagnostic text and output channel. Timings are not a compatible-output speed comparison.'] : []),
        ...(id === 'null-records-native' ? ['GNU -z -c terminates its count with LF; rg --null-data --count terminates the count with NUL. The direct command output differs, so timings are not a compatible-output speed comparison.'] : []),
      ],
      limitations: [
        ...(id === 'unicode-folding-native' ? ['The historical input has no Kelvin sign or ASCII K/k. This no-match class does not establish Unicode case-folding compatibility. rg Unicode mode is explicitly disabled to match GNU LC_ALL=C byte semantics.'] : []),
        ...(id === 'recursive-dereference-native' ? ['The historical tree contains no symlinks, so this class measures --follow overhead without exercising symlink traversal.'] : []),
        ...(id === 'null-records-native' ? ['The historical input has no NUL bytes; its entire content is one NUL-delimited record.'] : []),
        ...(flags.includes('E') ? ['These ASCII ERE patterns are supported by rg default regex. This does not establish general GNU BRE/ERE syntax or leftmost-longest extraction equivalence.'] : []),
      ],
    };
  });
}

export function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'grep2rg-rust-bench-'));
  const payload = Buffer.from('padding abcdefghijklmnopqrstuvwxyz 0123456789\n'.repeat(2048));
  const tinyPayload = Buffer.from('needle\nother\n'.repeat(16));
  const fixture = {
    directory, tree: join(directory, 'corpus'), single: join(directory, 'large.txt'),
    input: join(directory, 'small.txt'), dense: join(directory, 'dense'),
    smallTree: join(directory, 'small-tree'), tiny: join(directory, 'tiny'),
    near: join(directory, 'near-threshold'), long: join(directory, 'long-records'),
    patterns: join(directory, 'patterns'), binary: join(directory, 'binary'),
    inventories: {},
  };
  let auxiliary;
  try {
    mkdirSync(fixture.tree);
    fixture.paths = Array.from({ length: 2048 }, (_, i) =>
      join(fixture.tree, `${i % 3 === 0 ? '.' : ''}f${String(i).padStart(5, '0')}.txt`));
    for (const [i, filename] of fixture.paths.entries()) {
      const data = Buffer.from(payload);
      if (i % 31 === 0) data.write('needle', 0);
      if (i % 97 === 0) data.write('needle', data.length - 24);
      writeFileSync(filename, data);
    }
    const ignore = join(fixture.tree, '.gitignore');
    writeFileSync(ignore, '*.txt\n'); fixture.paths.push(ignore);
    writeFileSync(fixture.input, 'head\nneedle\ntail\n');
    writeFileSync(fixture.patterns, 'needle\nother\n');
    writeFileSync(fixture.binary, Buffer.from('head\0needle\n'));
    for (const [group, count] of [['smallTree', 32], ['tiny', 2048]]) {
      mkdirSync(fixture[group]);
      fixture.inventories[group] = Array.from({ length: count }, (_, i) => join(fixture[group], `f${i}.txt`));
      for (const filename of fixture.inventories[group]) writeFileSync(filename, tinyPayload);
    }
    fixture.inventories.corpus = fixture.paths;
    fixture.inventories.input = [fixture.input];
    fixture.inventories.binary = [fixture.binary];
    fixture.inventories.single = [fixture.single];
    fixture.inventories.stdin = ['(standard input)'];
    for (const [group, count] of [['dense', 2048], ['near', 255], ['long', 256]]) {
      fixture.inventories[group] = Array.from({ length: count }, (_, i) => join(fixture[group], `f${i}.txt`));
    }
    fixture.metadata = {
      historicalSource: 'tools/benchmark-routing.mjs', primaryFiles: fixture.paths.length,
      primaryBytes: 2048 * payload.length + 6,
      payloadBytesPerFile: payload.length, peakLogicalBytesUpperBound:
        4096 * payload.length + 2080 * tinyPayload.length + 6 + 17 + 13 + 12,
      materialization: 'Independent regular files with original contents; one large auxiliary group at a time. No sparse files, hardlinks, or reflinks.',
      groupFiles: Object.fromEntries(Object.entries(fixture.inventories).map(([k, v]) => [k, v.length])),
    };
    fixture.prepare = group => {
      const largeGroup = ['single', 'dense', 'near', 'long'].includes(group) ? group : undefined;
      if (auxiliary === largeGroup) return;
      if (auxiliary) rmSync(fixture[auxiliary], { recursive: true, force: true });
      auxiliary = largeGroup;
      if (!largeGroup) return;
      if (largeGroup === 'single') {
        writeFileSync(fixture.single, Buffer.alloc(64 * 1024 * 1024, 'x'));
      } else {
        mkdirSync(fixture[largeGroup]);
        let data = payload;
        if (largeGroup === 'dense') { data = Buffer.from(payload); data.write('needle', 0); }
        if (largeGroup === 'long') { data = Buffer.alloc(262144, 120); data.write('\nneedle\n', 131072); }
        for (const filename of fixture.inventories[largeGroup]) writeFileSync(filename, data);
      }
    };
    fixture.relative = path => path === '(standard input)' ? path : relative(directory, path);
    fixture.cleanup = () => rmSync(directory, { recursive: true, force: true });
    return fixture;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true }); throw error;
  }
}
