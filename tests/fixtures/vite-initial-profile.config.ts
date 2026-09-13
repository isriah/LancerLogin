import {defineConfig,mergeConfig} from 'vite';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import production from '../../apps/dashboard/vite.config';
// Only local test font serving across a worktree dependency junction; no profile alias.
export default mergeConfig(production,defineConfig({server:{fs:{allow:[fileURLToPath(new URL('../..',import.meta.url)),realpathSync(fileURLToPath(new URL('../../node_modules',import.meta.url)))]}}}));
