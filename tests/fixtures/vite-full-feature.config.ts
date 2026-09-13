import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({plugins:[react()],resolve:{alias:[{find:/^.*\/release-capabilities(?:\.ts)?$/,replacement:fileURLToPath(new URL('../helpers/full-feature-capabilities.ts',import.meta.url))}]}});
