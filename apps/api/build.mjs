// Bundles the API, the workspace packages it uses (TypeScript sources) and its npm
// dependencies into one ESM file: the image then needs Node and nothing else.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // Optional native driver pg tries to load; the pure JS one is used.
  external: ["pg-native"],
  // CommonJS dependencies call require() and use __dirname: give the ESM bundle both.
  banner: {
    js: [
      "import { createRequire as __dnoRequire } from 'node:module';",
      "import { fileURLToPath as __dnoPath } from 'node:url';",
      "const require = __dnoRequire(import.meta.url);",
      "const __filename = __dnoPath(import.meta.url);",
      "const __dirname = __dnoPath(new URL('.', import.meta.url));",
    ].join(" "),
  },
  logLevel: "info",
});
