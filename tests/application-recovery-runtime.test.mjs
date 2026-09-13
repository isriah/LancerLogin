import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync, constants } from 'node:sqlite';
import { assertRecoveryRuntime } from '../scripts/application-recovery-model.mjs';

test('supported recovery runtime enforces the actual SQLite authorizer',()=>{
 assertRecoveryRuntime();const db=new DatabaseSync(':memory:');
 try{db.setAuthorizer(code=>code===constants.SQLITE_CREATE_TABLE?constants.SQLITE_DENY:constants.SQLITE_OK);assert.throws(()=>db.exec('CREATE TABLE synthetic_denied(id INTEGER)'),/not authorized/);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='synthetic_denied'").get().n,0);}finally{db.close();}
});

for(const prerequisite of ['authorizer','version'])test(`missing recovery ${prerequisite} fails before model SQL or CLI execution`,()=>{
 const probe=`import {DatabaseSync} from 'node:sqlite';
 DatabaseSync.prototype.exec=function(){throw Error('Unexpected SQL execution');};
 ${prerequisite==='authorizer'?"DatabaseSync.prototype.setAuthorizer=undefined;":"Object.defineProperty(process.versions,'node',{value:'24.9.0'});"}
 try{await import('./scripts/application-recovery-spike.mjs');process.exitCode=2;}catch(error){console.log(error.message);process.exitCode=17;}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',probe],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,17,result.stderr);assert.match(result.stdout,/requires Node\.js 24\.10\.0 or later/);assert.match(result.stdout,/SQL authorization cannot be bypassed/);assert.doesNotMatch(result.stdout+result.stderr,/Unexpected SQL execution|setAuthorizer is not a function/);
});

test('complete CI verification selects the supported Node LTS line',()=>{
 const workflow=readFileSync('.github/workflows/ci.yml','utf8');const verify=workflow.match(/^  verify:\r?\n([\s\S]*?)(?=^  [\w-]+:)/m)?.[1];
 assert.ok(verify);assert.match(verify,/node-version: 24[, }]/);assert.match(verify,/npm run verify:all/);
});
