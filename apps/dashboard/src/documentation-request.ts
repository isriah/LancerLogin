import { apiBaseUrl } from './dashboard-api';
export class DocumentationError extends Error { constructor(public status:number) { super('Documentation request failed'); } }
export async function documentationRequest<T>(path:string,init?:RequestInit):Promise<T> { const response=await fetch(apiBaseUrl+path,{credentials:'include',...init,headers:init?.body?{'content-type':'application/json'}:undefined}); if(!response.ok)throw new DocumentationError(response.status); return response.json(); }
