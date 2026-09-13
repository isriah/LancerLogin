import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { latestCompatibleInstaller } from '../apps/kiosk/src/kiosk-release.mjs';
const release = (tag_name, extra={}) => ({ tag_name, draft:false, prerelease:false, assets:[{name:'install-lancerlogin.sh'},{name:'install-lancerlogin.sh.sha256'}], ...extra });
async function lookup(payloads) {
  const calls=[];
  const result=await latestCompatibleInstaller({fetchImpl:async(url,options)=>{
    calls.push(url); assert.equal(options.redirect,'manual'); assert.equal(options.headers['user-agent'],'LancerLogin');
    assert.equal(url,calls.length===1?'https://api.github.com/repos/isriah/LancerLogin/releases/latest':'https://api.github.com/repos/isriah/LancerLogin/releases?per_page=20');
    assert.ok(calls.length<=2); return Response.json(payloads[calls.length-1]);
  }});
  return {result,calls};
}
test('fixed official compatible installer lookup matches bounded API selection', async()=>{
  assert.equal((await lookup([release('v0.22.6')])).result,'0.22.6');
  const fallback=await lookup([release('v1.0.0'),[release('v0.23.0',{draft:true}),release('v0.22.7',{prerelease:true}),release('v0.22.6'),release('v0.22.5')]]);
  assert.equal(fallback.result,'0.22.6');assert.equal(fallback.calls.length,2);
  for(const payloads of [[null], [release('v0.22.6',{assets:[]})], [release('v1.0.0'),[release('v0.22.6',{assets:[]}),release('v0.22.5')]], [release('v1.0.0'),[release('v0.22.6'),null]], [release('v1.0.0'),Array(21).fill(release('v0.22.6'))], [release('v1.0.0'),[]]]) await assert.rejects(lookup(payloads),/No compatible official/);
});
test('lookup fails closed on redirect, outage, malformed, oversized and stalled feeds', async()=>{
  for(const response of [new Response('',{status:302}),new Response('',{status:429}),new Response('{'),new Response('x'.repeat(1048577))]){
    let calls=0;await assert.rejects(latestCompatibleInstaller({fetchImpl:async()=>{calls++;return response;}}),/No compatible official/);assert.equal(calls,1);
  }
  let signal;
  await assert.rejects(latestCompatibleInstaller({deadlineMs:25,fetchImpl:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}}),/No compatible official/);
  assert.equal(signal.aborted,true);
  await assert.rejects(latestCompatibleInstaller({deadlineMs:25,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}))}),/No compatible official/);
});

test('fixed shell uses selected version and refuses failed lookup or checksum before installation', {skip:process.platform==='win32'}, async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'lancerlogin-selector-shell-'));
  try {
    const helper=await readFile('apps/kiosk/scripts/lancerlogin-install-release.sh','utf8');
    // Replace only the fixed selector invocation in a disposable copy. All shell
    // flow, URL construction, checksum verification and install handoff stay real.
    const fixture=helper.replace('/usr/bin/node /opt/lancerlogin/src/kiosk-release.mjs','selector-fixture');
    assert.notEqual(fixture,helper);
    await writeFile(join(scratch,'helper.sh'),fixture);
    const commands={
      'selector-fixture':'#!/bin/bash\n[[ "$FAIL_LOOKUP" != yes ]] || exit 1\nprintf "0.22.6"\n',
      systemctl:'#!/bin/bash\nprintf "%s\\n" "$*" >> "$FIXTURE/systemctl.log"\nexit 0\n',
      curl:'#!/bin/bash\nset -eu\nurl=""; out=""\nwhile [[ $# -gt 0 ]]; do case "$1" in https:*) url="$1";; --output) shift; out="$1";; esac; shift; done\nprintf "%s\\n" "$url" >> "$FIXTURE/urls.log"\ncase "$url" in https://github.com/isriah/LancerLogin/releases/download/v0.22.6/install-lancerlogin.sh) printf \'#!/bin/bash\\nprintf "%%s" "$LANCERLOGIN_VERSION" > "$FIXTURE/installed"\\n\' > "$out";; https://github.com/isriah/LancerLogin/releases/download/v0.22.6/install-lancerlogin.sh.sha256) if [[ "$BAD_CHECKSUM" == yes ]]; then printf "invalid" > "$out"; else (cd "$(dirname "$out")" && sha256sum install-lancerlogin.sh) > "$out"; fi;; *) exit 9;; esac\n',
    };
    for(const [name,contents] of Object.entries(commands)){await writeFile(join(scratch,name),contents);await chmod(join(scratch,name),0o755);}
    const run=(extra={})=>execFileSync('bash',[join(scratch,'helper.sh')],{env:{PATH:scratch+':'+process.env.PATH,FIXTURE:scratch,FAIL_LOOKUP:'no',BAD_CHECKSUM:'no',...extra},stdio:'pipe',timeout:10000});
    run();assert.equal(await readFile(join(scratch,'installed'),'utf8'),'0.22.6');
    const urls=await readFile(join(scratch,'urls.log'),'utf8');assert.equal(urls.trim().split('\n').length,2);
    await rm(join(scratch,'installed'));
    assert.throws(()=>run({FAIL_LOOKUP:'yes'}));assert.equal(await readFile(join(scratch,'urls.log'),'utf8'),urls);
    assert.throws(()=>run({BAD_CHECKSUM:'yes'}));await assert.rejects(readFile(join(scratch,'installed')),/ENOENT/);
    assert.match(await readFile(join(scratch,'systemctl.log'),'utf8'),/start lancerlogin-kiosk.service/);
  } finally { await rm(scratch,{recursive:true,force:true}); }
});
