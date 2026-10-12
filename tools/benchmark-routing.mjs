#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { withGrepWrapper } from '../src/grep-wrapper.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceFiles=['native/grep2rg.c','bin/grep2rg','src/grep-wrapper.mjs','tools/build-native.mjs','tools/benchmark-routing.mjs','bin/grep2rg-native'];
const before=Object.fromEntries(sourceFiles.map(f=>[f,createHash('sha256').update(readFileSync(join(root,f))).digest('hex')]));
const fixture = mkdtempSync(join(tmpdir(), 'grep2rg-measured-'));
const repetitions = Number(process.env.GREP2RG_BENCH_REPETITIONS || 7);
const cases = [];
const sha = data => createHash('sha256').update(data).digest('hex');
const env = { ...process.env, LC_ALL: 'C', LANG: 'C' }; delete env.GREP2RG_EXPERIMENTAL_RG; delete env.POSIXLY_CORRECT;
const trace = join(fixture, 'route.log'); env.GREP2RG_ROUTE_LOG = trace;
const prefix = join(fixture, 'scope.sh'); writeFileSync(prefix, withGrepWrapper({ command: 'grep "$@"' }, '/usr/bin/bash').command);
const tree = join(fixture, 'corpus'); mkdirSync(tree);
const payload = Buffer.from(('padding abcdefghijklmnopqrstuvwxyz 0123456789\n').repeat(2048));
const paths = [];
for (let i = 0; i < 2048; i++) {
 const filename = join(tree, `${i % 3 === 0 ? '.' : ''}f${i.toString().padStart(5,'0')}.txt`); paths.push(filename);
 const data = Buffer.from(payload); if (i % 31 === 0) data.write('needle', 0); if (i % 97 === 0) data.write('needle', data.length - 24);
 writeFileSync(filename, data);
}
writeFileSync(join(tree, '.gitignore'), '*.txt\n'); paths.push(join(tree, '.gitignore'));
const single = join(fixture, 'large.txt'); writeFileSync(single, Buffer.alloc(64 * 1024 * 1024, 'x'));
const input = join(fixture, 'small.txt'); writeFileSync(input, 'head\nneedle\ntail\n');
const dense = join(fixture,'dense'); mkdirSync(dense);
const smallTree=join(fixture,'small-tree'); mkdirSync(smallTree);
for(let i=0;i<2048;i++){const data=Buffer.from(payload);data.write('needle',0);writeFileSync(join(dense,`f${i}.txt`),data);}
for(let i=0;i<32;i++)writeFileSync(join(smallTree,`f${i}.txt`),'needle\nother\n'.repeat(16));
const tiny=join(fixture,'tiny'); mkdirSync(tiny); for(let i=0;i<2048;i++)writeFileSync(join(tiny,`f${i}.txt`),'needle\nother\n'.repeat(16));
const near=join(fixture,'near-threshold');mkdirSync(near);for(let i=0;i<255;i++)writeFileSync(join(near,`f${i}.txt`),payload);
const long=join(fixture,'long-records');mkdirSync(long);const longPayload=Buffer.alloc(262144,120);longPayload.write('\nneedle\n',131072);for(let i=0;i<256;i++)writeFileSync(join(long,`f${i}.txt`),longPayload);
const patterns=join(fixture,'patterns');writeFileSync(patterns,'needle\nother\n');
const binary=join(fixture,'binary');writeFileSync(binary,Buffer.from('head\0needle\n'));
const specifications = [
 ['recursive-count', ['-arcF', 'needle', tree]],
 ['recursive-invert-count', ['-arcvF', 'needle', tree]],
 ['recursive-filenames-sparse', ['-rlF', 'needle', tree]],
 ['recursive-filenames-no-match', ['-rlF', 'absent', tree]],
 ['explicit-count', ['-acF', 'needle', ...paths]],
 ['explicit-filenames-sparse', ['-lF', 'needle', ...paths]],
 ['explicit-filenames-no-match', ['-lF', 'absent', ...paths]],
 ['single-large-count-native', ['-acF', 'needle', single]],
 ['small-file-native', ['-nF', 'needle', input]],
 ['stdin-native', ['-nF', 'needle']],
 ['regex-compatible-count', ['-acE', '(padding|needle).*012', ...paths]],
 ['recursive-dense-filenames-native', ['-rlF', 'needle', dense]],
 ['small-recursive-count-native', ['-arcF', 'needle', smallTree]],
 ['many-tiny-count-native', ['-arcF','needle',tiny]],
 ['below-threshold-count-native', ['-arcF','needle',near]],
 ['long-record-count-native', ['-arcF','needle',long]],
 ['long-record-content-native', ['-arnF','needle',long]],
 ['recursive-content', ['-arnF', 'needle', tree]],
 ['recursive-regex-content', ['-arnE', 'needle|absent', tree]],
 ['recursive-filter-native', ['-arlF','--include=*.txt','needle',tree]],
 ['recursive-dereference-native', ['-arlRF','needle',tree]],
 ['word-extraction-native', ['-aFwo', 'needle', input]],
 ['null-records-native', ['-azFc', 'needle', input]],
 ['pattern-file-native', ['-acF', '-f', patterns, input]],
 ['quiet-native', ['-aqF', 'needle', input]],
 ['binary-content-native', ['-nF', 'needle', binary]],
 ['unicode-folding-native', ['-aiF', 'K', input]],
 ['context-native', ['-aF', '-C', '3', 'needle', input]],
];
try {
 for (const [id, argv] of specifications) {
  const stdin = id === 'stdin-native' ? 'head\nneedle\ntail\n' : undefined;
  const variants = { GNU: ['/usr/bin/grep', argv], CLI: [join(root, 'bin/grep2rg'), argv], function: ['/usr/bin/bash', [prefix, ...argv]] };
  const experimentalClasses=new Set(['single-large-count-native','small-file-native','stdin-native','context-native','recursive-dense-filenames-native','small-recursive-count-native','many-tiny-count-native','below-threshold-count-native','long-record-count-native','long-record-content-native','recursive-content','recursive-regex-content','recursive-filter-native','recursive-dereference-native','word-extraction-native','null-records-native','pattern-file-native','quiet-native','binary-content-native','unicode-folding-native']);
  if(experimentalClasses.has(id))variants.Experimental=[join(root,'bin/grep2rg'),argv];
  const samples = Object.fromEntries(Object.keys(variants).map(k=>[k,[]]));
  let expected; let comparisons = 0, traceLines = [];
  for (let round = 0; round < repetitions; round++) {
   // Rotate engine order; every observation retains its complete sample.
   const labels = Object.keys(variants); const rotation = round % labels.length;
   for (const label of labels.slice(rotation).concat(labels.slice(0,rotation))) {
    writeFileSync(trace, ''); const [program,args] = variants[label];
    const started = performance.now(); const result = spawnSync(program,args,{env:label==='Experimental'?{...env,GREP2RG_EXPERIMENTAL_RG:'1'}:env,argv0:label==='GNU'?'grep':undefined,input:stdin,maxBuffer:32*1024*1024,timeout:120000});
    const ms = performance.now()-started; if(result.error || result.signal) throw result.error || Error(result.signal);
    samples[label].push(Number(ms.toFixed(3)));
    const evidence = { status:result.status, stdoutSHA256:sha(result.stdout),stderrSHA256:sha(result.stderr),stdoutBytes:result.stdout.length };
    if(label==='GNU') { if(expected && JSON.stringify(expected)!==JSON.stringify(evidence)) throw Error(`${id}: unstable GNU fixture`); expected=evidence; }
    else { traceLines.push(...readFileSync(trace,'utf8').trim().split('\n').filter(Boolean)); comparisons++; }
    // Compare immediately against an independent GNU result outside timing.
    if(label!=='GNU') { const oracle=spawnSync('/usr/bin/grep',argv,{env,argv0:'grep',input:stdin,maxBuffer:32*1024*1024}); if(result.status!==oracle.status || !result.stdout.equals(oracle.stdout) || !result.stderr.equals(oracle.stderr)) throw Error(`${id}: ${label} GNU disagreement`); }
   }
  }
  const medians=Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,[...v].sort((a,b)=>a-b)[Math.floor(v.length/2)]]));
  const row={id,argvSummary:argv.slice(0,5),operandCount:argv.length,samplesMs:samples,medianMs:medians,exactComparisons:comparisons,evidence:expected,rgNativeInvocations:traceLines.length,routeEvidence:[...new Set(traceLines)]};
  cases.push(row); console.log(JSON.stringify(row));
 }
 const files=sourceFiles; const after=Object.fromEntries(files.map(f=>[f,sha(readFileSync(join(root,f)))])); if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Source changed during benchmark');
 const report={schemaVersion:1,createdAt:new Date().toISOString(),scope:'Rotated seven-run warm-cache synthetic public CLI and private Bash function timing. All wrapper and child process startup, metadata, parallel search and ordered aggregate/full-line rendering included. GNU output/status/stderr checked independently on every sample. No universal hardware/input speed claim.',fixture:{files:paths.length,bytes:paths.length*payload.length},versions:{GNU:spawnSync('/usr/bin/grep',['--version'],{encoding:'utf8'}).stdout.split('\n')[0],rg:spawnSync('rg',['--version'],{encoding:'utf8'}).stdout.split('\n')[0],node:process.version},sourceHashes:Object.fromEntries(files.map(f=>[f,sha(readFileSync(join(root,f)))])),repetitions,cases};
 const output=process.argv[2] || join(root,'docs/automatic-performance.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n');
} finally {rmSync(fixture,{recursive:true,force:true});}
