// Explicit Node test loader only; never imported by application or build code.
import { registerHooks } from 'node:module';
const target=new URL('../../packages/shared/src/release-capabilities.ts',import.meta.url).href;
registerHooks({load(url,context,next){if(url===target)return {format:'module',shortCircuit:true,source:"export const documentationAvailable=true; export function moduleAvailable(id){return ['hour-tracking','activity-documentation'].includes(id)}"};return next(url,context);}});
