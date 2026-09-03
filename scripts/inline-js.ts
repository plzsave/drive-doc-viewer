import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const entry = resolve(root, "src/client/main.ts");
const htmlPath = resolve(root, "dist/index.html");
const placeholder = "<!--CLIENT_JS-->";

if (!existsSync(htmlPath)) {
  throw new Error('dist/index.html not found. Did "vite build" run?');
}

let html = readFileSync(htmlPath, "utf8");
if (!html.includes(placeholder)) {
  throw new Error(`Placeholder ${placeholder} not found in dist/index.html`);
}

const result = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "iife",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Failed to bundle src/client/main.ts");
}

const js = (await result.outputs[0].text()).trim();
const safeJs = js.replace(/<\/(script)/gi, "<\\/$1");
html = html.replace(placeholder, () => `<script>\n${safeJs}\n</script>`);
writeFileSync(htmlPath, html);

console.log(`Inlined client JS (${(js.length / 1024).toFixed(1)} kB)`);
