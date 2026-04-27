// Bundles the client TypeScript with esbuild and copies static assets.
import { build } from "esbuild";
import { mkdir, copyFile, rm, watch as watchFs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "dist/client");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [resolve(root, "src/client/main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: resolve(outDir, "main.js"),
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

const staticFiles = ["index.html", "style.css"];

async function copyStatic() {
  await Promise.all(
    staticFiles.map((f) =>
      copyFile(resolve(root, "src/client", f), resolve(outDir, f)),
    ),
  );
}

await copyStatic();

if (watch) {
  const ctx = await (await import("esbuild")).context(buildOptions);
  await ctx.watch();
  console.log("[build-client] watching for changes…");

  // esbuild's watcher only tracks the TS entry graph, so edits to static
  // assets (index.html, style.css) need their own watcher — otherwise CSS
  // tweaks don't reach dist/ until the dev server is restarted.
  (async () => {
    const watcher = watchFs(resolve(root, "src/client"));
    for await (const evt of watcher) {
      if (staticFiles.includes(evt.filename)) {
        await copyStatic().catch((err) =>
          console.error("[build-client] static copy failed:", err),
        );
        console.log(`[build-client] copied ${evt.filename}`);
      }
    }
  })().catch((err) => console.error("[build-client] static watcher error:", err));
} else {
  await build(buildOptions);
}
