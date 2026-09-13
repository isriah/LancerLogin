import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Generic offline artifact: no env/config/secret input, network, signing or deploy.
export async function buildUpdaterWorker(output){
  if(typeof output!=='string'||!output.endsWith('.mjs'))throw Error('updater-build-output');
  const result=await build({entryPoints:[fileURLToPath(new URL('../apps/updater/worker.mjs',import.meta.url))],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],write:false,sourcemap:false,legalComments:'none',logLevel:'silent'});
  if(result.outputFiles.length!==1||result.outputFiles[0].contents.length>16*1024*1024)throw Error('updater-build-size');
  const path=resolve(output);await mkdir(dirname(path),{recursive:true});await writeFile(path,result.outputFiles[0].contents,{flag:'wx'});
  return {bytes:result.outputFiles[0].contents.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==4||process.argv[2]!=='--output')throw Error('updater-build-arguments');const result=await buildUpdaterWorker(process.argv[3]);process.stdout.write(`Built updater module (${result.bytes} bytes).\n`);}
  catch{process.stderr.write('Updater build failed; check arguments and use a new .mjs output path.\n');process.exitCode=1;}
}
