/**
 * Pre-parses the sample documents in /sample-docs into src/lib/sample-data.json.
 *
 *   npm run samples:build   (also runs automatically before `npm run build`)
 *
 * Reading PDFs is the most CPU-hungry thing the app does, so the server loads the
 * samples from this JSON instead of re-parsing them on every cold start.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chunkPages } from "../src/lib/chunk";
import { config } from "../src/lib/config";
import { ACCEPTED_EXTENSIONS, parseFile } from "../src/lib/parse";

async function main() {
  const dir = path.join(process.cwd(), "sample-docs");
  const files = readdirSync(dir)
    .filter((f) => ACCEPTED_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)))
    .sort();
  const { chunkSize, chunkOverlap } = config.retrieval;
  const out = [];
  for (const name of files) {
    const parsed = await parseFile(name, new Uint8Array(readFileSync(path.join(dir, name))));
    out.push({
      name,
      mime: parsed.mime,
      pageCount: parsed.pageCount,
      chunks: chunkPages(parsed.pages, chunkSize, chunkOverlap),
    });
  }
  const target = path.join(process.cwd(), "src", "lib", "sample-data.json");
  writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
  console.log(`Wrote ${out.length} sample documents to ${path.relative(process.cwd(), target)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
