import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, openSync, closeSync, cpSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withGrepWrapper } from '../src/grep-wrapper.mjs';
const root = fileURLToPath(new URL('../',import.meta.url));
const built=spawnSync(process.execPath,[join(root,'tools/build-native.mjs')],{encoding:'utf8'}); assert.equal(built.status,0,built.stderr);
const directory=mkdtempSync(join(tmpdir(),'grep2rg-native-oracle-')); const tree=join(directory,'tree');mkdirSync(tree);
// This suite continues to qualify the historical C route explicitly. Rust's
// default CLI/Pi integration is checked separately against its real executable.
const env={...process.env,LC_ALL:'C',LANG:'C',GREP2RG_ENGINE:'c'};delete env.GREP2RG_EXPERIMENTAL_RG;delete env.POSIXLY_CORRECT;
const trace=join(directory,'routes');env.GREP2RG_ROUTE_LOG=trace;
const files=[];const data=Buffer.from('padding abcdefghijklmnopqrstuvwxyz 0123456789\n'.repeat(6144));
for(let i=0;i<256;i++){const name=join(tree,`${i%3===0?'.':''}f${i.toString().padStart(3,'0')}${i===25?'\nline':i===63?' space':''}.txt`);const value=Buffer.from(data);if(i%17===0)value.write('needle',value.length-40);if(i%19===0)value.write('needle',value.length-80);if(i%23===0)value[2]=0;if(i%29===0)value[4]=255;writeFileSync(name,value);files.push(name);}
writeFileSync(join(tree,'.gitignore'),'*.txt\n');symlinkSync(files[0],join(tree,'ignored-symlink'));
const scope=join(directory,'scope.sh');writeFileSync(scope,withGrepWrapper({command:'grep "$@"'},'/usr/bin/bash').command);
const variants={native:join(root,'bin/grep2rg-native'),CLI:join(root,'bin/grep2rg'),function:'/usr/bin/bash'};
let comparisons=0,accelerated=0;
function run(program,args,environment=env,options={}){const result=spawnSync(program,args,{env:environment,argv0:program==='/usr/bin/grep'?'grep':undefined,maxBuffer:4*1024*1024,timeout:20000,...options});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null);return result;}
function compare(args,{environment=env,expectedRoute,options}={}){
 const expected=run('/usr/bin/grep',args,environment,options);
 for(const[name,program]of Object.entries(variants)){writeFileSync(trace,'');const actual=run(program,name==='function'?[scope,...args]:args,environment,options);assert.equal(actual.status,expected.status,`${name} status ${JSON.stringify(args.slice(0,8))}`);assert.deepEqual(actual.stdout,expected.stdout,`${name} stdout`);assert.deepEqual(actual.stderr,expected.stderr,`${name} stderr`);comparisons++;const selected=readFileSync(trace,'utf8').includes('rg-native');accelerated+=selected?1:0;if(expectedRoute!==undefined)assert.equal(selected,expectedRoute,`${name} route ${JSON.stringify(args.slice(0,8))}`);}
}
test.after(()=>rmSync(directory,{recursive:true,force:true}));
test('large native aggregate routes preserve all filename bytes, binaries, order, zero counts and exit status',()=>{
 for(const argv of [
 ['-rlF','needle',tree],['-rlF','absent',tree],['-rLF','needle',tree],['-rlFZ','needle',tree],
 ['-racF','needle',tree],['-racFnZ','needle',tree],['-racFh','needle',tree],['-racFv','needle',tree],
 ['-racF','-e','needle','-e','012345',tree],['-racE','(padding|needle).*012',tree],['-rlE','needle|absent',tree],
 ['-acF','needle',...files],['-lF','needle',...files],['--text','--count','--fixed-strings','--regexp=needle',...files],
 ['-ilF','NEEDLE',...files],['-rl','needle',tree],['-arnF','needle',tree],['-arF','needle',tree],['-arFnZ','needle',tree],['-arFh','needle',tree],['-arF','absent',tree],['-arnE','needle|absent',tree],['-racFwx','padding abcdefghijklmnopqrstuvwxyz 0123456789',tree],['-racFw','0123456789',tree],
 ['-racFy','NEEDLE',tree],['-racFi','--no-ignore-case','needle',tree],['-racF','--color=never','needle',tree],['-rcF','--binary-files=text','needle',tree],['-racFU','needle',tree],
 ])compare(argv,{expectedRoute:true});
});
test('every inventoried GNU option has a routing decision and public default oracle exercise',()=>{
 const inventory=JSON.parse(readFileSync(join(root,'tests/grep_option_inventory.json'),'utf8'));
 const audit=JSON.parse(readFileSync(join(root,'docs/automatic-routing-audit.json'),'utf8'));
 assert.deepEqual(audit.options.map(o=>o.id),inventory.options.map(o=>o.id));
 assert.deepEqual(audit.interactionFamilies.map(o=>o.family),inventory.interactionClasses);
 const patternFile=join(directory,'patterns'),excludeFile=join(directory,'exclusions');writeFileSync(patternFile,'needle\n');writeFileSync(excludeFile,'*.not-selected\n');
 for(const variant of inventory.representativeVariants){const argv=variant.argv.map(v=>v.replaceAll('$PATTERN_FILE',patternFile).replaceAll('$EXCLUDE_FILE',excludeFile));compare([...argv,'-arc',...(variant.providesPattern?[]:['needle']),tree]);}
 for(const flags of [['-i','--no-ignore-case'],['--no-ignore-case','-i'],['-l','-L'],['-L','-l'],['-c','-l'],['-l','-c'],['-H','-h'],['-h','-H'],['-F','-E'],['-E','-G'],['-F','-G'],['-a','--binary-files=binary'],['--binary-files=binary','-a'],['-w','-x'],['-x','-w'],['-i','-v'],['-Z','-H'],['-Z','-h']])compare([...flags,'-arc','needle',tree]);
});
test('recursive operand spelling preserves GNU paths and readdir order',()=>{
 for(const name of [tree+'/',tree+'//',tree+'/.',tree.replace('/tree','//tree')])compare(['-rlF','needle',name],{expectedRoute:true});
 compare(['-rlF','needle','./tree'],{expectedRoute:true,options:{cwd:directory}});
});
test('tiny-file scale hint avoids a complete preflight and retains exact GNU',()=>{
 const tiny=join(directory,'tiny');mkdirSync(tiny);for(let i=0;i<512;i++)writeFileSync(join(tiny,`file${i}`),'needle\n');
 compare(['-racF','needle',tiny],{expectedRoute:false});
});
test('large sparse long-record count and text workloads retain the measured faster GNU lane',()=>{
 const long=join(directory,'long-records');mkdirSync(long);const bytes=Buffer.alloc(262144,120);bytes.write('\nneedle\n',131072);
 for(let i=0;i<256;i++)writeFileSync(join(long,`file${i}`),bytes);
 compare(['-racF','needle',long],{expectedRoute:false});compare(['-ranF','needle',long],{expectedRoute:false});
});
test('native routing leaves invalid arguments, unknown semantics, stream ownership and GNU diagnostics unchanged',()=>{
 const variants=[['--help'],['--version'],['--imaginary'],['--b','-racF','needle',tree],['--te','-rcF','needle',tree],['-e','--','--e','-rac',tree],['-e','--','--in','-rac',tree],[],['-m'],['-qcF','needle',tree],['-rF','needle',tree],
 ['-rlF','needle','missing'],['-rlF','needle',...files,'missing'],['-aF','needle'],['-alFv','needle',...files],
 ['-racE','[[:alpha:]]+',tree],['-racG','pad.*012',tree],['-racF','needle','-e'],['-racF','',tree],
 ['-rlF','-f','missing',tree],['-rlF','--include=*.txt','needle',tree],['-RFl','needle',tree],
 ['-aFc','needle',files[0]],['-aFc','needle',...files,files[0]],['-rlF','needle\nother',tree]];
 for(const argv of variants)compare(argv,{expectedRoute:false,options:{input:'needle\n'}});
 compare(['-racF','needle',tree],{environment:{...env,GREP2RG_ACCELERATION:'gnu'},expectedRoute:false});
 compare(['-racF','needle',tree],{environment:{...env,POSIXLY_CORRECT:'1'},expectedRoute:false});
 compare(['-racFi','NEEDLE',tree],{environment:{...env,LC_ALL:'C.UTF-8'},expectedRoute:false});
});
test('caller descriptor symlink operands retain GNU before rg redirects stdout',()=>{
 const output=join(directory,'fd-output');const argv=['-acF','needle','/proc/self/fd/1',...files];
 const script='exec 1>"$1"; shift; exec -a grep "$@"';
 writeFileSync(trace,'');const expected=run('/bin/bash',['-c',script,'owned',output,'/usr/bin/grep',...argv]);const bytes=readFileSync(output);
 const actual=run('/bin/bash',['-c',script,'owned',output,join(root,'bin/grep2rg-native'),...argv]);
 assert.equal(actual.status,expected.status);assert.deepEqual(actual.stderr,expected.stderr);assert.deepEqual(readFileSync(output),bytes);assert.equal(readFileSync(trace,'utf8'),'');comparisons++;
});
test('GNU short circuit remains selected for dense first-line filename probes',()=>{
 for(const file of files){const value=Buffer.from(data);value.write('needle',0);writeFileSync(file,value);}
 compare(['-rlF','needle',tree],{expectedRoute:false});compare(['-lF','needle',...files],{expectedRoute:false});
});
test('unreadable operands and a failed rg child recover exact GNU errors without partial rg output',()=>{
 const restricted=files[0];chmodSync(restricted,0);try{compare(['-racF','needle',tree],{expectedRoute:false});}finally{chmodSync(restricted,0o600);}
 const bin=join(directory,'bin');mkdirSync(bin);writeFileSync(join(bin,'rg'),'#!/bin/sh\nprintf "unexpected\\00099\\n"\nprintf "owned rg failure\\n" >&2\nexit 2\n',{mode:0o755});
 compare(['-racF','needle',tree],{environment:{...env,PATH:`${bin}:/usr/bin:/bin`},expectedRoute:true});
});
test('sparse text publication retains GNU line numbering and raw NUL payload bytes',()=>{
 for(const file of files)writeFileSync(file,data);
 const value=Buffer.from(data);value.write('needle',value.length-20);value[value.length-12]=0;value[value.length-10]=255;
 writeFileSync(files[1],value);
 compare(['-arnFZ','needle',tree],{expectedRoute:true});
});
test('malformed text after a valid rg row falls back before publishing any row',()=>{
 const bin=join(directory,'malformed-text');mkdirSync(bin);
 writeFileSync(join(bin,'rg'),`#!/bin/sh\nprintf '%s\\000' '${files[1]}'\nprintf '1:needle\\nmissing-file\\000wrong\\n'\n`,{mode:0o755});
 compare(['-arnF','needle',tree],{environment:{...env,PATH:`${bin}:/usr/bin:/bin`},expectedRoute:true});
});
test('text exceeding the bounded unpublished buffer recovers GNU without duplicates',()=>{
 const args=['-arhwF','padding',tree],path=join(directory,'bounded-output');
 const outputHash=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
 let fd=openSync(path,'w');const expected=run('/usr/bin/grep',args,env,{stdio:['ignore',fd,'pipe']});closeSync(fd);const expectedHash=outputHash();
 for(const[name,program]of Object.entries(variants)){
  writeFileSync(trace,'');fd=openSync(path,'w');const actual=run(program,name==='function'?[scope,...args]:args,env,{stdio:['ignore',fd,'pipe']});closeSync(fd);
  assert.equal(actual.status,expected.status);assert.deepEqual(actual.stderr,expected.stderr);assert.equal(outputHash(),expectedHash);assert.ok(readFileSync(trace,'utf8').includes('rg-native'));comparisons++;accelerated++;
 }
});
test('a failed optional build disables a stale helper and leaves the public GNU fallback usable',()=>{
 const packageRoot=join(directory,'failed-build');for(const name of ['bin','tools','native'])mkdirSync(join(packageRoot,name),{recursive:true});
 for(const name of ['bin/grep2rg','bin/grep2rg-native','tools/build-native.mjs','native/grep2rg.c'])cpSync(join(root,name),join(packageRoot,name));
 const result=run(process.execPath,[join(packageRoot,'tools/build-native.mjs'),'--optional'],{...env,CC:join(directory,'absent-compiler')});
 assert.equal(result.status,0);assert.match(result.stderr.toString(),/GNU fallback/);assert.ok(!existsSync(join(packageRoot,'bin/grep2rg-native')));
 const args=['-aFc','needle',files[1]],expected=run('/usr/bin/grep',args),actual=run(join(packageRoot,'bin/grep2rg'),args);
 assert.equal(actual.status,expected.status);assert.deepEqual(actual.stdout,expected.stdout);assert.deepEqual(actual.stderr,expected.stderr);comparisons++;
});
test('real stdout failures retain GNU write error and status',()=>{
 const script='exec 1>/dev/full; exec "$@"';const args=['-racF','needle',tree];
 const expected=run('/bin/bash',['-c','exec 1>/dev/full; exec -a grep /usr/bin/grep "$@"','owned',...args]);
 const actual=run('/bin/bash',['-c',script,'owned',join(root,'bin/grep2rg-native'),...args]);
 assert.equal(actual.status,expected.status);assert.deepEqual(actual.stderr,expected.stderr);comparisons++;
});
test('automatic lane qualification reports actual independent oracle counts',(t)=>{assert.ok(accelerated>=40);t.diagnostic(JSON.stringify({campaign:'native-auto-lane',actualGNUComparisons:comparisons,acceleratedNativeInvocations:accelerated,allStdoutStderrStatusExact:true}));});
