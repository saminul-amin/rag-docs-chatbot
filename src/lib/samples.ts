import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLE_WORKSPACE } from "./config";
import { getDb } from "./db";
import { ingestDocument } from "./documents";
import { ACCEPTED_EXTENSIONS } from "./parse";

// The demo ships with a few sample documents (in /sample-docs) so visitors can try it
// without uploading anything. They're ingested automatically the first time the app
// needs them, so a fresh deployment works with no manual seeding step.

const SAMPLE_DIR = path.join(process.cwd(), "sample-docs");
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

async function seed() {
  const db = await getDb();
  const existing = new Set(
    (await db.query<{ name: string }>(`select name from documents where is_sample`)).map((r) => r.name),
  );

  let files: string[];
  try {
    files = (await readdir(SAMPLE_DIR)).filter((f) =>
      ACCEPTED_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)),
    );
  } catch {
    return; // no sample folder: nothing to seed
  }

  for (const file of files.sort()) {
    if (existing.has(file)) continue;
    const data = new Uint8Array(await readFile(path.join(SAMPLE_DIR, file)));
    try {
      await ingestDocument({ workspace: SAMPLE_WORKSPACE, name: file, data, isSample: true });
      console.log(`[samples] ingested ${file}`);
    } catch (err) {
      // Another server instance may have seeded the same file at the same moment;
      // the unique index on sample names makes that safe to ignore.
      if (String((err as Error).message).includes("documents_sample_name_idx")) continue;
      throw err;
    }
  }
}
