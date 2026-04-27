// Bundles the client TypeScript with esbuild and copies static assets. The
// HTML copy step expands `<!-- include: <path> -->` directives so index.html
// can be split into per-component partials under src/client/partials/.
import { build } from "esbuild";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  watch as watchFs,
  writeFile,
} from "node:fs/promises";
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

const INCLUDE_RE = /<!--\s*include:\s*([^\s]+)\s*-->/g;

async function expandIncludes(html, baseDir, depth = 0) {
  if (depth > 8) throw new Error("include depth exceeded — likely a cycle");
  const parts = [];
  let lastIdx = 0;
  for (const m of html.matchAll(INCLUDE_RE)) {
    parts.push(html.slice(lastIdx, m.index));
    const file = resolve(baseDir, m[1]);
    const inner = await readFile(file, "utf8");
    parts.push(await expandIncludes(inner, dirname(file), depth + 1));
    lastIdx = m.index + m[0].length;
  }
  parts.push(html.slice(lastIdx));
  return parts.join("");
}

async function buildHtml() {
  const src = resolve(root, "src/client/index.html");
  const html = await readFile(src, "utf8");
  const expanded = await expandIncludes(html, dirname(src));
  await writeFile(resolve(outDir, "index.html"), expanded);
}

async function copyStatic() {
  await Promise.all([
    buildHtml(),
    copyFile(resolve(root, "src/client/style.css"), resolve(outDir, "style.css")),
  ]);
}

await copyStatic();

if (watch) {
  const ctx = await (await import("esbuild")).context(buildOptions);
  await ctx.watch();
  console.log("[build-client] watching for changes…");

  // esbuild's watcher only tracks the TS entry graph, so edits to static
  // assets (index.html, partials/*.html, style.css) need their own watcher.
  // Recursive so partial edits also trigger a rebuild.
  (async () => {
    const watcher = watchFs(resolve(root, "src/client"), { recursive: true });
    for await (const evt of watcher) {
      const f = evt.filename;
      if (!f) continue;
      if (f.endsWith(".html") || f.endsWith(".css")) {
        await copyStatic().catch((err) =>
          console.error("[build-client] static copy failed:", err),
        );
        console.log(`[build-client] rebuilt static (${f})`);
      }
    }
  })().catch((err) => console.error("[build-client] static watcher error:", err));
} else {
  await build(buildOptions);
}
