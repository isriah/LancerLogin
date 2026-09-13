import {fork,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// External termination, not a Promise.race around synchronous parser code.
export function runIsolated(miniflare,fixture,mime,mode='strict',{wallMs=10000,startupMs=20000}={}) {
  return new Promise((resolve,reject)=>{
    const child=fork(fileURLToPath(new URL('./input-child.mjs',import.meta.url)),[miniflare,fixture,mime,mode],
      {cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,detached:process.platform!=='win32'});
    let result=null,timedOut=false,termination=Promise.resolve();
    const terminate=()=>{timedOut=true;
      if(process.platform==='win32'){
        termination=new Promise((done,failed)=>{const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          killer.on('error',failed);killer.on('exit',code=>code===0?done():failed(new Error('PROCESS_TREE_TERMINATION_FAILED')));});
        termination.catch(reject);
      }else {try{process.kill(-child.pid,'SIGKILL');}catch(error){reject(error);}}
    };
    let timer=setTimeout(terminate,startupMs);
    child.on('message',message=>{if(message.ready){clearTimeout(timer);timer=setTimeout(terminate,wallMs);}if(message.result)result=message.result;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',()=>{clearTimeout(timer);if(timedOut){
      termination.then(()=>resolve({outcome:'runtime-terminated',code:'WALL_DEADLINE',productionEligible:false}),reject);
    }else resolve(result??{outcome:'runtime-failure',productionEligible:false});});
  });
}
