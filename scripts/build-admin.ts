import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, "src/apps/admin/ui");
const destination = resolve(root, "dist/admin");
await mkdir(destination, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(source, "client.ts")],
  outdir: destination,
  target: "browser",
  minify: true,
  sourcemap: "none",
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
await Promise.all(
  ["index.html", "style.css"].map((name) =>
    Bun.write(resolve(destination, name), Bun.file(resolve(source, name))),
  ),
);
console.info("Built admin UI in dist/admin");
