// Exact REST-derived provider wording only. Unknown binding errors stay unknown.
const quota="Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC)";
const full=quota+'. See https://developers.cloudflare.com/d1/platform/limits/ for more details.';
const messages=new Set([quota,quota+'.',full].flatMap(text=>[text,text.replace("D1's","D1\u2019s")]).flatMap(text=>[text,text+': SQLITE_ERROR']));
const own=(value:object,key:string)=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value' in descriptor?descriptor.value:undefined;};
export function isDailyD1ReadQuota(error:unknown):boolean{
 try{
 const seen=new Set<Error>();let current=error,d1=false;
 for(let depth=0;depth<6&&current instanceof Error&&!seen.has(current);depth++){
  seen.add(current);const message=own(current,'message'),code=own(current,'code');
  if(typeof message==='string'&&message.length<=512){
   const wrapped=message.startsWith('D1_ERROR: ');d1=d1||wrapped||message==='D1_ERROR';
   if((d1||code===7500)&&messages.has(wrapped?message.slice(10):message))return true;
  }
  current=own(current,'cause');
 }
 return false;
 }catch{return false;}
}
