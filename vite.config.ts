// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    resolve: {
      alias: [
        // `ai` → @ai-sdk/gateway → @vercel/oidc (Node build) does CJS require("node:fs"/"node:path"), which makes the
        // bundler emit a top-level createRequire(import.meta.url) that crashes every Worker request at startup.
        // The OIDC token is unused here (we never call the Vercel gateway), so use its fs-free variant.
        {
          find: /^@vercel\/oidc$/,
          replacement: fileURLToPath(new URL("./node_modules/@vercel/oidc/dist/index-browser.js", import.meta.url)),
        },
      ],
    },
  },
});
