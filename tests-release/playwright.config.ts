import base from '../playwright.config';
import {fileURLToPath} from 'node:url';
export default {...base,testDir:'.',testMatch:'*.spec.ts',webServer:(base.webServer as any[]).map(server=>({...server,cwd:fileURLToPath(new URL('..',import.meta.url)),command:server.command.replace('vite-full-feature.config.ts','vite-initial-profile.config.ts')}))};
