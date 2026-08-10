import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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
  define: {
    __PALSERVER_CONSOLE_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), versionInfoPlugin],
});
