import { fileURLToPath } from 'node:url';
export const fullFeaturePlugin={name:'test-full-feature-profile',setup(build){build.onResolve({filter:/release-capabilities(?:\.ts)?$/},()=>({path:fileURLToPath(new URL('./full-feature-capabilities.ts',import.meta.url))}));}};
