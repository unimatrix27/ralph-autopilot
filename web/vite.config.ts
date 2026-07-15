import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = resolve(here, "../src/web/contract");

/**
 * The discipline boundary (ADR-0031): the browser bundle — the UI and the shared
 * contract leaf — must import **nothing** from Node. Vite would otherwise quietly
 * externalize a `node:*` import and ship a broken bundle; this plugin turns any
 * first-party node-builtin import into a hard build error instead. Scoped to
 * first-party code (importer not under node_modules) so a third-party dep with a
 * legitimate node fallback isn't penalised — the boundary is about *our* code.
 */
function forbidNodeBuiltins(): PluginOption {
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  return {
    name: "forbid-node-builtins",
    enforce: "pre",
    resolveId(source, importer) {
      const isBuiltin = source.startsWith("node:") || builtins.has(source);
      if (!isBuiltin) {
        return null;
      }
      const firstParty = !importer || !importer.includes("node_modules");
      if (firstParty) {
        throw new Error(
          `Browser bundle imported Node builtin "${source}"` +
            (importer ? ` from ${importer}` : "") +
            `. The web control plane must stay browser-safe — keep node-only code out of ` +
            `the contract leaf and UI (ADR-0031).`,
        );
      }
      return null;
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [forbidNodeBuiltins(), react()],
  resolve: {
    alias: {
      "@": resolve(here, "src"),
      "@contract": resolve(contractDir, "index.ts"),
    },
  },
  server: {
    port: 5173,
    // Dev-only: the Vite dev server proxies the API to the running daemon, so
    // `npm run dev` in web/ talks to a live control plane while iterating on the UI.
    // In production the daemon serves the built SPA itself, same-origin (no proxy).
    proxy: {
      "/api": { target: "http://127.0.0.1:4280", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
