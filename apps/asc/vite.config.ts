import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// Used by `cf build` / `cf dev`; tests use vitest.config.ts.
export default defineConfig({
  plugins: [cloudflare()],
});
