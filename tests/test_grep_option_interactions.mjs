// Finite black-box verification: every ordered pair of the declared spelling
// variants and every subset of nine boolean flags. This is not all possible
// grep argv sequences. The oracle is the independently installed GNU binary.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { planGrep } from '../src/grep-wrapper.mjs';

const cli = fileURLToPath(new URL('../src/grep-wrapper.mjs', import.meta.url));
const inventoryPath = fileURLToPath(new URL('./grep_option_inventory.json', import.meta.url));
const deep = process.env.GREP2RG_DEEP === '1';
const parallelism = 8;
const seed = 'ordered-gnu-options-v1';
const comparedCases = new Set();
const envBase = { ...process.env, LC_ALL: 'C', GREP_COLORS: '', GREP_COLOR: '', TERM: 'xterm' };
delete envBase.POSIXLY_CORRECT;

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'grep2rg-interactions-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const identity = createHash('sha256');
  const put = (path, content) => {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
    writeFileSync(join(cwd, path), raw);
    identity.update(JSON.stringify([path, raw.length])).update(raw);
  };
  const data = Buffer.from('head\nfoo foo\nFOO\nalpha\n\nno4\nno5\nno6\nno7\nno8\nfoobar\n42\nx foo y\nno match\nfoo\r\nlast');
  put('input-a.txt', data);
  put('input b.txt', 'foo\nother\n\r\nalpha foo\nnone\nfoo\n');
  put('records-a.nul', data.toString().replaceAll('\n', '\0'));
  put('records b.nul', 'foo\0other\0\r\0alpha foo\0none\0foo\0');
  put('empty.txt', '');
  put('patterns.txt', 'foo\n');
  put('patterns-empty.txt', '');
  put('exclude.txt', 'skip*\n');
  put('exclude-empty.txt', '');
  put('-dash.txt', '-foo\nfoo\n');
  mkdirSync(join(cwd, 'tree')); mkdirSync(join(cwd, 'tree', 'excluded'));
  put('tree/keep.txt', data);
  put('tree/skip.txt', 'foo\n');
  put('tree/.hidden.txt', 'foo\n');
  put('tree/excluded/inside.txt', 'foo\n');
  return { cwd, data, identity: identity.digest('hex') };
}

function execute(program, argv, f, env, input) {
  return new Promise((resolve) => {
    const output = [], errors = [];
    let length = 0, failure = null, closed = false;
    const child = spawn(program, argv, { cwd: f.cwd, env, argv0: program === '/usr/bin/grep' ? 'grep' : undefined, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stop = (reason) => {
      failure ??= reason;
      if (closed || !child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure += `; ${error.code}`; }
    };
    const deadline = setTimeout(() => stop('15-second subprocess deadline'), 15000);
    for (const [stream, chunks] of [[child.stdout, output], [child.stderr, errors]]) stream.on('data', (chunk) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) stop('2-MiB output limit'); else chunks.push(chunk);
    });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(`stdin: ${error.code}`); });
    child.once('error', (error) => { failure = `spawn: ${error.code}`; });
    child.once('close', (status, signal) => {
      closed = true; clearTimeout(deadline);
      resolve({ status, signal, failure, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) });
    });
    // A file-only GNU call may close stdin immediately. Never write an unused
    // fixture to that pipe; quiet/m-count calls with real stdin can still EPIPE.
    if (input === undefined) child.stdin.end(); else child.stdin.end(input);
  });
}

function summarize(buffer) {
  return { bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), leadingHex: buffer.subarray(0, 80).toString('hex') };
}
function mismatch(oracle, actual, item) {
  if (!oracle.failure && !actual.failure && !oracle.signal && !actual.signal && oracle.status === actual.status && oracle.stdout.equals(actual.stdout) && oracle.stderr.equals(actual.stderr)) return null;
  const description = (result) => ({ status: result.status, signal: result.signal, failure: result.failure, stdout: summarize(result.stdout), stderr: summarize(result.stderr) });
  return { seed, case: item.id, argv: item.argv, env: item.env ?? {}, stdin: item.input === undefined ? null : summarize(item.input), expected: description(oracle), actual: description(actual) };
}
function replaceMarkers(value) {
  return String(value).replaceAll('$PATTERN_FILE', 'patterns.txt').replaceAll('$EMPTY_PATTERN_FILE', 'patterns-empty.txt').replaceAll('$EXCLUDE_FILE', 'exclude.txt').replaceAll('$EMPTY_EXCLUDE_FILE', 'exclude-empty.txt').replaceAll('$MISSING_FILE', 'missing-file').replaceAll('$DASH_FILE', '-dash.txt').replaceAll('$TEXT_FILE', 'input-a.txt');
}
function appendCase(target, seen, item) {
  const identity = caseIdentity(item);
  if (seen.has(identity)) return false;
  seen.add(identity); target.push(item); return true;
}
function caseIdentity(item, fixtureIdentity = null) {
  return JSON.stringify([item.argv, item.env ?? {}, item.input === undefined ? null : summarize(item.input).sha256, fixtureIdentity]);
}
function caseFor(id, options, f, env = {}) {
  const args = options.flatMap((variant) => variant.argv.map(replaceMarkers));
  if (!options.some((variant) => variant.providesPattern)) args.push('-e', 'foo');
  const recursive = args.some((arg) => ['-r', '-R', '--recursive', '--dereference-recursive', '--directories=recurse', '-drecurse'].includes(arg));
  const labeled = args.some((arg) => arg === '--label' || arg.startsWith('--label='));
  const paths = recursive ? ['tree'] : labeled ? ['input-a.txt', '-', 'input b.txt'] : ['input-a.txt', 'input b.txt'];
  return { id, argv: ['-a', ...args, '--', ...paths], env, input: paths.includes('-') ? f.data : undefined };
}

async function campaign(t, f, items, expectedMinimum) {
  // Groups share a fixture recipe, so identical argv/env/stdin comparisons
  // repeated by another generator receive no second execution or coverage credit.
  const uniqueItems = items.filter((item) => {
    const identity = caseIdentity(item, f.identity);
    if (comparedCases.has(identity)) return false;
    comparedCases.add(identity); return true;
  });
  const failures = [];
  let next = 0, completed = 0, failed = 0, rg = 0, native = 0;
  await Promise.all(Array.from({ length: parallelism }, async () => {
    while (next < uniqueItems.length) {
      const item = uniqueItems[next++], env = { ...envBase, ...(item.env ?? {}) };
      const plan = planGrep(item.argv, { env, stat: (path) => statSync(join(f.cwd, path)) });
      if (plan.backend === 'rg') rg++; else native++;
      const [oracle, actual] = await Promise.all([
        execute('/usr/bin/grep', item.argv, f, env, item.input), execute(process.execPath, [cli, ...item.argv], f, env, item.input),
      ]);
      const difference = mismatch(oracle, actual, item);
      if (difference) { failed++; if (failures.length < 12) failures.push({ ...difference, fixtureSHA256: f.identity }); }
      completed++;
    }
  }));
  t.diagnostic(JSON.stringify({ seed, fixtureSHA256: f.identity, actualComparisons: completed, declaredDistinctCases: items.length, duplicateCasesAlreadyCovered: items.length - uniqueItems.length, mismatches: failed, rgRoutingPlans: rg, nativeRoutingPlans: native, parallelism }));
  assert.equal(completed, uniqueItems.length);
  assert.ok(items.length >= expectedMinimum, 'finite campaign must not silently lose declared coverage');
  assert.equal(failed, 0, `GNU option-interaction mismatches (first ${failures.length}):\n${JSON.stringify(failures, null, 2)}`);
  return { rg, native };
}

function loadInventory() {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  assert.ok(Array.isArray(inventory.representativeVariants), 'inventory needs the declared spelling-variant scope');
  const variants = inventory.representativeVariants.map((variant) => ({ ...variant, argv: variant.argv.map(String) }));
  assert.equal(new Set(variants.map((variant) => JSON.stringify(variant.argv))).size, variants.length, 'variant argv must be unique');
  assert.ok(variants.length >= 64, 'include all long spellings and representative short spellings');
  return { inventory, variants };
}

test('every documented GNU short and long option is represented in the independent invocation inventory', (t) => {
  const { variants } = loadInventory();
  const help = spawnSync('/usr/bin/grep', ['--help'], { env: envBase, argv0: 'grep', encoding: 'utf8' });
  assert.equal(help.status, 0); assert.equal(help.stderr, '');
  const documented = new Set(help.stdout.match(/--[a-z][a-z-]*/g));
  const included = new Set(variants.flatMap((variant) => variant.argv.flatMap((arg) => arg.match(/--[a-z][a-z-]*/g) ?? [])));
  for (const option of documented) assert.ok(included.has(option), `missing documented GNU spelling ${option}`);
  const documentedShort = new Set(Array.from(help.stdout.matchAll(/^\s{2}(-[A-Za-z])(?=[,\s])/gm), (match) => match[1]));
  const includedShort = new Set(variants.flatMap((variant) => variant.argv.filter((arg) => /^-[A-Za-z]/.test(arg)).map((arg) => arg.slice(0, 2))));
  for (const option of documentedShort) assert.ok(includedShort.has(option), `missing documented GNU short spelling ${option}`);
  t.diagnostic(JSON.stringify({ documentedLongOptions: documented.size, documentedShortOptions: documentedShort.size, declaredSpellingVariants: variants.length }));
});

test('every ordered pair of the declared GNU option spellings matches the public wrapper', { timeout: 600000 }, async (t) => {
  const f = fixture(t), { variants } = loadInventory(), items = [], seen = new Set();
  for (const first of variants) for (const second of variants) {
    appendCase(items, seen, caseFor(`pair:${first.id}>${second.id}`, [first, second], f));
  }
  assert.equal(items.length, variants.length ** 2, 'every ordered pair, including repeats, must be distinct');
  const result = await campaign(t, f, items, 4096);
  assert.ok(result.rg > 1000, 'ordered-pair campaign must exercise rg as well as native fallback');
});

test('all 512 subsets of a nine-flag boolean core match GNU on varied records', { timeout: 120000 }, async (t) => {
  const f = fixture(t), core = ['-i', '-w', '-x', '-v', '-o', '-n', '-b', '-H', '-z'], items = [], seen = new Set();
  for (let mask = 0; mask < 2 ** core.length; mask++) {
    const flags = core.filter((_, bit) => mask & (1 << bit));
    const paths = flags.includes('-z') ? ['records-a.nul', 'records b.nul'] : ['input-a.txt', 'input b.txt'];
    appendCase(items, seen, { id: `subset:${mask.toString(2).padStart(core.length, '0')}`, argv: ['-aF', ...flags, '-e', 'foo', '--', ...paths] });
  }
  assert.equal(items.length, 512);
  await campaign(t, f, items, 512);
});

test('inventory lexical cases exercise abbreviations, clusters, permutation and missing values through the public CLI', { timeout: 60000 }, async (t) => {
  const f = fixture(t), { inventory } = loadInventory(), items = [], seen = new Set();
  assert.ok(inventory.lexicalCases.length >= 10);
  for (const lexical of inventory.lexicalCases) {
    const examples = lexical.examples ?? [lexical.argv];
    for (const [index, raw] of examples.entries()) {
      const args = (Array.isArray(raw) ? raw : [raw]).map(replaceMarkers);
      for (const env of lexical.environmentVariants ?? [{}]) {
        let item;
        if (lexical.id === 'missing-value') {
          item = { id: `lexical:${lexical.id}:${index}`, argv: ['-a', '-e', 'foo', 'input-a.txt', ...args], env };
        } else if (['end-options', 'option-permutation', 'dash-stdin'].includes(lexical.id)) {
          item = { id: `lexical:${lexical.id}:${index}`, argv: args, env, input: lexical.id === 'dash-stdin' ? f.data : undefined };
        } else {
          const providesPattern = args.some((arg) => /^-(?:e|f)/.test(arg) || /^--(?:regexp|file)(?:=|$)/.test(arg));
          item = caseFor(`lexical:${lexical.id}:${index}`, [{ argv: args, providesPattern }], f, env);
        }
        appendCase(items, seen, item);
      }
    }
  }
  await campaign(t, f, items, 40);
});

test('valued options, spellings and repeated order-sensitive settings preserve GNU boundaries', { timeout: deep ? 600000 : 180000 }, async (t) => {
  const f = fixture(t), { inventory } = loadInventory(), items = [], seen = new Set();
  const groups = [
    { id: 'count', forms: ['-m', '--max-count'], values: ['0', '1', '2', '999', '18446744073709551616', '-1', 'bad'] },
    { id: 'before', forms: ['-B', '--before-context'], values: ['0', '1', '2', '999', '-1', 'bad'] },
    { id: 'after', forms: ['-A', '--after-context'], values: ['0', '1', '2', '999', '-1', 'bad'] },
    { id: 'context', forms: ['-C', '--context'], values: ['0', '1', '2', '999', '-1', 'bad'] },
    { id: 'binary', forms: ['--binary-files'], values: ['binary', 'text', 'without-match', 'bad'] },
    { id: 'directory', forms: ['-d', '--directories'], values: ['read', 'recurse', 'skip', 'bad'] },
    { id: 'device', forms: ['-D', '--devices'], values: ['read', 'skip', 'bad'] },
    { id: 'color', forms: ['--color', '--colour'], values: ['always', 'never', 'auto', 'bad'] },
    { id: 'pattern', forms: ['-e', '--regexp'], values: ['foo', 'FOO', 'foo\nalpha', '', '[', 'not-found-xyz'], providesPattern: true },
    { id: 'pattern-file', forms: ['-f', '--file'], values: ['patterns.txt', 'patterns-empty.txt', 'missing-patterns'], providesPattern: true },
    { id: 'label', forms: ['--label'], values: ['stream', '', 'a b', '$literal:line'] },
    { id: 'include', forms: ['--include'], values: ['*.txt', 'input*', 'none*', '[a-z]*', ''] },
    { id: 'exclude', forms: ['--exclude'], values: ['*.txt', 'input*', 'none*', '[a-z]*', ''] },
    { id: 'exclude-directory', forms: ['--exclude-dir'], values: ['excluded', '*', 'no*'] },
    { id: 'exclude-file', forms: ['--exclude-from'], values: ['exclude.txt', 'exclude-empty.txt', 'missing-exclusions'] },
    { id: 'separator', forms: ['--group-separator'], values: ['--', 'NEXT', '', '\t'] },
  ];
  const modifiers = deep ? [[], ['-v'], ['-o'], ['-c'], ['-l'], ['-L'], ['-q'], ['-nbHTZ'], ['-C0'], ['-C2'], ['--color=always'], ['-r']] : [[], ['-v'], ['-c'], ['-C2']];
  for (const group of groups) for (const form of group.forms) for (const value of group.values) {
    const spellings = [[form, value], [form.startsWith('--') ? `${form}=${value}` : `${form}${value}`]];
    for (const argv of spellings) for (const modifier of modifiers) {
      appendCase(items, seen, caseFor(`value:${group.id}:${argv.join(':')}:${modifier.join(',')}`, [{ argv, providesPattern: group.providesPattern }, { argv: modifier }], f));
    }
    const first = { argv: [form, value], providesPattern: group.providesPattern };
    for (const override of group.values.slice(0, deep ? undefined : 3)) {
      appendCase(items, seen, caseFor(`repeat:${group.id}:${value}>${override}:${form}`, [first, { argv: [form, override], providesPattern: group.providesPattern }], f));
    }
  }
  // Every independently catalogued boundary gets a direct CLI comparison too.
  // Deep adds inverse/output neighbors; it does not explode every value pair.
  const ids = { count: 'max-count', before: 'before-context', after: 'after-context', binary: 'binary-files', directory: 'directories', device: 'devices', pattern: 'regexp', 'pattern-file': 'file', 'exclude-directory': 'exclude-dir', 'exclude-file': 'exclude-from', separator: 'group-separator' };
  for (const group of groups) {
    const option = inventory.options.find((entry) => entry.id === (ids[group.id] ?? group.id));
    assert.ok(option, `inventory must identify ${group.id}`);
    const values = new Set([...(option.values ?? []), ...(option.invalidValues ?? [])]);
    for (const form of group.forms) for (const rawValue of values) {
      const value = replaceMarkers(rawValue);
      for (const argv of [[form, value], [form.startsWith('--') ? `${form}=${value}` : `${form}${value}`]]) {
        for (const modifier of deep ? [[], ['-v'], ['-o', '-nb']] : [[]]) {
          appendCase(items, seen, caseFor(`inventory-boundary:${option.id}:${argv.join(':')}:${modifier.join(',')}`, [{ argv, providesPattern: group.providesPattern }, { argv: modifier }], f));
        }
      }
    }
  }
  await campaign(t, f, items, deep ? 1500 : 300);
});
