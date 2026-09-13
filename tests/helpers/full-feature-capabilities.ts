/** Test-only substitution. Production imports the shared fixed initial profile. */
export const documentationAvailable: boolean = true;
export function moduleAvailable(id:string){return ['hour-tracking','activity-documentation'].includes(id);}
