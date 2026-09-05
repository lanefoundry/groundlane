import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/container/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist/container",
  clean: true,
  // tsup 8 removes `node:` by default. That turns the Node 22 built-in
  // `node:sqlite` into a nonexistent third-party `sqlite` package.
  removeNodeProtocol: false,
});
