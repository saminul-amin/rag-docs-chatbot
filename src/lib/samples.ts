import { createHash } from "node:crypto";
import type { Chunk } from "./chunk";
import { config, SAMPLE_WORKSPACE } from "./config";
import { getDb } from "./db";
import { storeDocument } from "./documents";
import * as mem from "./memory-store";
import SAMPLES from "./sample-data.json";

// The demo ships with a few sample documents (in /sample-docs) so visitors can try it
// without uploading anything. They're stored automatically the first time the app
// needs them, so a fresh deployment works with no manual seeding step.
//
// The documents are parsed ahead of time (`npm run samples:build` writes
// sample-data.json), because parsing PDFs on every cold start burns CPU for nothing.

const samples = SAMPLES as { name: string; mime: string; pageCount: number; chunks: Chunk[] }[];
let seeded = false;
let seeding: Promise<void> | null = null;

export function ensureSamples(): Promise<void> {
  if (seeded) return Promise.resolve();
  seeding ??= seed()
    .then(() => {
      seeded = true;
    })
    .finally(() => {
      seeding = null;
    });
  return seeding;
}

/**
 * A sample's id is derived from its file name, so every server instance gives the
 * same document the same id. A browser can then send its selection to any instance.
 */
function sampleId(name: string): string {
  const h = createHash("sha256").update(`askdocs-sample:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function seed() {
  const existing =
    config.storage === "memory"
      ? mem.sampleNames()
      : new Set(
          (await (await getDb()).query<{ name: string }>(`select name from documents where is_sample`)).map(
            (r) => r.name,
          ),
        );

  for (const s of samples) {
    if (existing.has(s.name)) continue;
    try {
      await storeDocument({
        workspace: SAMPLE_WORKSPACE,
        name: s.name,
        mime: s.mime,
        pageCount: s.pageCount,
        chunks: s.chunks,
        isSample: true,
        id: sampleId(s.name),
      });
      console.log(`[samples] loaded ${s.name}`);
    } catch (err) {
      // Another server instance may have seeded the same file at the same moment;
      // the unique index on sample names (and the fixed id) makes that safe to ignore.
      if (/documents_sample_name_idx|documents_pkey/.test(String((err as Error).message))) continue;
      throw err;
    }
  }
}
