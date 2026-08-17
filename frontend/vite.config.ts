import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backendInit = readFileSync(
  new URL("../backend/palserver_console/__init__.py", import.meta.url),
  "utf-8",
);
const versionMatch = backendInit.match(/^__version__\s*=\s*"([^"]+)"\s*$/m);
const appVersion = versionMatch?.[1];

if (!appVersion) {
  throw new Error("Unable to read palserver_console.__version__ for the frontend build.");
}

const versionInfoPlugin: Plugin = {
  name: "palserver-console-version-info",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "build-info.json",
      source: `${JSON.stringify({ frontendVersion: appVersion }, null, 2)}\n`,
    });
  },
};

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    __PALSERVER_CONSOLE_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), tailwindcss(), versionInfoPlugin],
});
