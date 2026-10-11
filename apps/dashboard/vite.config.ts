import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export default defineConfig({ plugins: [react()], define: { __LANCERLOGIN_VERSION__: JSON.stringify(version) }, build: { sourcemap: true } });
