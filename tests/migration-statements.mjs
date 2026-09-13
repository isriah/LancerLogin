// Test fixture loader: retain trigger bodies and quoted semicolons as one statement.
export function migrationStatements(sql) {
 const result=[];let current='',word='',quote='',line=false,block=false,trigger=false,depth=0;
 const flush=()=>{const token=word.toUpperCase();if(token==='TRIGGER')trigger=true;if(trigger&&(token==='BEGIN'||token==='CASE'))depth++;if(trigger&&token==='END')depth--;word='';};
 for(let i=0;i<sql.length;i++){
  const c=sql[i],next=sql[i+1];
  if(line){if(c==='\n'){line=false;current+='\n';}continue;}
  if(block){if(c==='*'&&next==='/'){block=false;i++;current+=' ';}continue;}
  if(quote){current+=c;if(c===quote){if(next===quote){current+=next;i++;}else quote='';}continue;}
  if(c==='-'&&next==='-'){flush();line=true;i++;continue;}
  if(c==='/'&&next==='*'){flush();block=true;i++;continue;}
  if(c==="'"||c==='"'||c==='`'||c==='['){flush();quote=c==='['?']':c;current+=c;continue;}
  if(/[a-zA-Z_]/.test(c)){word+=c;current+=c;continue;}
  flush();current+=c;
  if(c===';'&&depth===0){if(current.trim())result.push(current.trim());current='';trigger=false;}
 }
 flush();if(quote||block||depth!==0)throw new Error('Incomplete migration fixture SQL');if(current.trim())result.push(current.trim());return result;
}
