import { randomUUID } from "node:crypto";
import { embed } from "./ai";
import { chunkPages, type Chunk } from "./chunk";
import { config, SAMPLE_WORKSPACE } from "./config";
import { getDb, toVector } from "./db";
import { AppError } from "./errors";
import * as mem from "./memory-store";
import { parseFile } from "./parse";

const inMemory = config.storage === "memory";

export interface DocumentInfo {
  id: string;
  name: string;
  mime: string;
  pages: number;
  chunkCount: number;
  isSample: boolean;
  createdAt: string;
}

const INSERT_BATCH = 100;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ingestDocument(opts: {
  workspace: string;
  name: string;
  data: Uint8Array;
  isSample?: boolean;
}): Promise<DocumentInfo> {
  const parsed = await parseFile(opts.name, opts.data);
  const { chunkSize, chunkOverlap } = config.retrieval;
  return storeDocument({
    workspace: opts.workspace,
    name: opts.name,
    mime: parsed.mime,
    pageCount: parsed.pageCount,
    chunks: chunkPages(parsed.pages, chunkSize, chunkOverlap),
    isSample: opts.isSample,
  });
}

/** Embeds (when a key is set) and saves an already-parsed, already-chunked document. */
export async function storeDocument(opts: {
  workspace: string;
  name: string;
  mime: string;
  pageCount: number;
  chunks: Chunk[];
  isSample?: boolean;
  id?: string;
}): Promise<DocumentInfo> {
  const { chunks } = opts;
  if (chunks.length > config.limits.maxChunksPerDocument) {
    throw new AppError(
      `That document is too long for this demo (${chunks.length} sections; the limit is ${config.limits.maxChunksPerDocument}).`,
      413,
    );
  }

  const vectors = await tryEmbed(chunks.map((c) => embeddingText(opts.name, c.content)));

  const id = opts.id ?? randomUUID();
  const chars = chunks.reduce((n, c) => n + c.content.length, 0);

  if (inMemory) {
    mem.insertDocument(
      {
        id,
        workspace: opts.workspace,
        name: opts.name,
        mime: opts.mime,
        pages: opts.pageCount,
        chars,
        chunk_count: chunks.length,
        is_sample: !!opts.isSample,
      },
      chunks.map((c, i) => ({ ...c, embedding: vectors?.[i] ?? null })),
    );
  } else {
    await insertIntoDb(id, opts, chars, vectors);
  }

  return {
    id,
    name: opts.name,
    mime: opts.mime,
    pages: opts.pageCount,
    chunkCount: chunks.length,
    isSample: !!opts.isSample,
    createdAt: new Date().toISOString(),
  };
}

async function insertIntoDb(
  id: string,
  opts: { workspace: string; name: string; mime: string; pageCount: number; chunks: Chunk[]; isSample?: boolean },
  chars: number,
  vectors: number[][] | null,
) {
  const { chunks } = opts;
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into documents (id, workspace, name, mime, pages, chars, chunk_count, is_sample)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, opts.workspace, opts.name, opts.mime, opts.pageCount, chars, chunks.length, !!opts.isSample],
    );
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const batch = chunks.slice(i, i + INSERT_BATCH);
      const params: unknown[] = [];
      const values = batch.map((c, j) => {
        const v = vectors?.[i + j];
        params.push(id, c.idx, c.page, c.content, v ? toVector(v) : null);
        const b = j * 5;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::vector)`;
      });
      await tx.query(
        `insert into chunks (document_id, idx, page, content, embedding) values ${values.join(", ")}`,
        params,
      );
    }
  });
}

// Prefixing the document name gives each embedding a little context
// ("Refund policy: ...") which helps retrieval on short chunks.
const embeddingText = (docName: string, content: string) => `${docName}\n\n${content}`;

/**
 * Embeddings are best-effort: with no API key, or if the provider is down or out of
 * credit, the document is still stored and searchable by keyword. Missing vectors are
 * filled in later by backfillEmbeddings().
 */
async function tryEmbed(texts: string[]): Promise<number[][] | null> {
  if (!config.llm.enabled) return null;
  try {
    return await embed(texts);
  } catch (err) {
    console.warn("[ingest] embedding failed, storing for keyword search only:", (err as Error).message);
    return null;
  }
}

/** Embeds chunks that were stored without a vector. Cheap to call often; no-op without a key. */
export async function backfillEmbeddings(limit = 128): Promise<number> {
  if (!config.llm.enabled) return 0;
  if (inMemory) {
    const missing = mem.chunksMissingEmbedding(limit);
    if (missing.length === 0) return 0;
    const vectors = await tryEmbed(missing.map((r) => embeddingText(r.name, r.content)));
    if (!vectors) return 0;
    mem.setEmbeddings(new Map(missing.map((r, i) => [r.id, vectors[i]])));
    return missing.length;
  }
  const db = await getDb();
  const rows = await db.query<{ id: string | number; name: string; content: string }>(
    `select c.id, d.name, c.content
       from chunks c join documents d on d.id = c.document_id
      where c.embedding is null
      order by c.id
      limit $1`,
    [limit],
  );
  if (rows.length === 0) return 0;
  const vectors = await tryEmbed(rows.map((r) => embeddingText(r.name, r.content)));
  if (!vectors) return 0;
  await db.transaction(async (tx) => {
    for (const [i, r] of rows.entries()) {
      await tx.query(`update chunks set embedding = $1::vector where id = $2`, [toVector(vectors[i]), r.id]);
    }
  });
  return rows.length;
}

type DocRow = {
  id: string;
  name: string;
  mime: string;
  pages: number;
  chunk_count: number;
  is_sample: boolean;
  created_at: Date | string;
};

const toInfo = (r: DocRow): DocumentInfo => ({
  id: r.id,
  name: r.name,
  mime: r.mime,
  pages: r.pages,
  chunkCount: r.chunk_count,
  isSample: r.is_sample,
  createdAt: new Date(r.created_at).toISOString(),
});

/** Sample documents (shared, read-only) followed by the visitor's own uploads. */
export async function listDocuments(workspace: string): Promise<DocumentInfo[]> {
  if (inMemory) return mem.listDocuments([SAMPLE_WORKSPACE, workspace]).map(toInfo);
  const db = await getDb();
  const rows = await db.query<DocRow>(
    `select id, name, mime, pages, chunk_count, is_sample, created_at
       from documents
      where workspace = $1 or workspace = $2
      order by is_sample desc, created_at asc`,
    [SAMPLE_WORKSPACE, workspace],
  );
  return rows.map(toInfo);
}

export async function countUserDocuments(workspace: string): Promise<number> {
  if (inMemory) return mem.countUserDocuments(workspace);
  const db = await getDb();
  const [row] = await db.query<{ n: number }>(
    `select count(*)::int as n from documents where workspace = $1 and not is_sample`,
    [workspace],
  );
  return row?.n ?? 0;
}

/** Deletes one of the visitor's own documents. Sample documents can't be deleted. */
export async function deleteDocument(workspace: string, id: string): Promise<boolean> {
  if (inMemory) return mem.deleteDocument(workspace, id);
  const db = await getDb();
  const rows = await db.query(
    `delete from documents where id = $1 and workspace = $2 and not is_sample returning id`,
    [id, workspace],
  );
  return rows.length > 0;
}

/** Filters requested document ids down to the ones this visitor may search. */
export async function allowedDocumentIds(workspace: string, requested: string[]): Promise<string[]> {
  const ids = requested.filter((id) => UUID_RE.test(id)).slice(0, 50);
  if (ids.length === 0) return [];
  if (inMemory) return mem.allowedDocumentIds(workspace, ids);
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `select id from documents
      where id = any(string_to_array($1, ',')::uuid[])
        and (workspace = $2 or is_sample)`,
    [ids.join(","), workspace],
  );
  return rows.map((r) => r.id);
}

/** Uploaded documents are temporary in the public demo. */
export async function deleteExpiredUploads(): Promise<void> {
  if (inMemory) return mem.deleteExpiredUploads(config.limits.uploadRetentionHours);
  const db = await getDb();
  await db.query(
    `delete from documents
      where not is_sample and created_at < now() - make_interval(hours => $1::int)`,
    [config.limits.uploadRetentionHours],
  );
}
