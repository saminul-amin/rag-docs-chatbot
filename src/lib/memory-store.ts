import { STOPWORDS, stem } from "./extractive";

// The "memory" storage backend: documents, chunks and rate-limit counters kept in
// plain JavaScript objects inside the server process. It's used on Vercel when no
// DATABASE_URL is set. It does the same job as the SQL in documents.ts,
// retrieve.ts and rate-limit.ts (hybrid search, per-workspace isolation, limits)
// without booting an embedded database, so a cold start costs milliseconds of CPU
// instead of seconds. Like the /tmp database it replaces, data lives only as long
// as the server instance.

export interface MemDoc {
  id: string;
  workspace: string;
  name: string;
  mime: string;
  pages: number;
  chars: number;
  chunk_count: number;
  is_sample: boolean;
  created_at: Date;
}

interface MemChunk {
  id: number;
  document_id: string;
  idx: number;
  page: number | null;
  content: string;
  embedding: number[] | null;
  /** Term frequencies for keyword (BM25) search. */
  tf: Map<string, number>;
  len: number;
}

export interface HitRow {
  id: number;
  document_id: string;
  name: string;
  page: number | null;
  content: string;
  similarity: number | null;
  score: number;
}

/** Hard ceiling on visitor uploads held by one instance; the oldest go first. */
const MAX_UPLOADED_DOCS = 200;

interface State {
  docs: Map<string, MemDoc>;
  chunks: Map<string, MemChunk[]>;
  nextChunkId: number;
  rate: Map<string, number[]>;
}

const g = globalThis as unknown as { __ragMem?: State };
const state: State = (g.__ragMem ??= { docs: new Map(), chunks: new Map(), nextChunkId: 1, rate: new Map() });

/** Same idea as Postgres' english text search: lower-case, drop stopwords, stem. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((w) => !STOPWORDS.has(w) && (w.length > 2 || /\d/.test(w))).map(stem);
}

export function insertDocument(
  doc: Omit<MemDoc, "created_at">,
  chunks: { idx: number; page: number | null; content: string; embedding: number[] | null }[],
): void {
  if (doc.is_sample && [...state.docs.values()].some((d) => d.is_sample && d.name === doc.name)) return;
  state.docs.set(doc.id, { ...doc, created_at: new Date() });
  state.chunks.set(
    doc.id,
    chunks.map((c) => {
      const tf = new Map<string, number>();
      const tokens = tokenize(c.content);
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { ...c, id: state.nextChunkId++, document_id: doc.id, tf, len: tokens.length };
    }),
  );

  const uploads = [...state.docs.values()].filter((d) => !d.is_sample);
  if (uploads.length > MAX_UPLOADED_DOCS) {
    uploads.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    for (const d of uploads.slice(0, uploads.length - MAX_UPLOADED_DOCS)) removeDoc(d.id);
  }
}

function removeDoc(id: string) {
  state.docs.delete(id);
  state.chunks.delete(id);
}

export const sampleNames = () =>
  new Set([...state.docs.values()].filter((d) => d.is_sample).map((d) => d.name));

export function listDocuments(workspaces: string[]): MemDoc[] {
  return [...state.docs.values()]
    .filter((d) => workspaces.includes(d.workspace))
    .sort(
      (a, b) =>
        Number(b.is_sample) - Number(a.is_sample) || a.created_at.getTime() - b.created_at.getTime(),
    );
}

export const countUserDocuments = (workspace: string) =>
  [...state.docs.values()].filter((d) => d.workspace === workspace && !d.is_sample).length;

export function deleteDocument(workspace: string, id: string): boolean {
  const d = state.docs.get(id);
  if (!d || d.workspace !== workspace || d.is_sample) return false;
  removeDoc(id);
  return true;
}

export function allowedDocumentIds(workspace: string, ids: string[]): string[] {
  return ids.filter((id) => {
    const d = state.docs.get(id);
    return !!d && (d.workspace === workspace || d.is_sample);
  });
}

export function deleteExpiredUploads(hours: number): void {
  const cutoff = Date.now() - hours * 3_600_000;
  for (const d of [...state.docs.values()]) {
    if (!d.is_sample && d.created_at.getTime() < cutoff) removeDoc(d.id);
  }
}

export function chunksMissingEmbedding(limit: number) {
  const out: { id: number; name: string; content: string }[] = [];
  for (const [docId, chunks] of state.chunks) {
    for (const c of chunks) {
      if (c.embedding) continue;
      out.push({ id: c.id, name: state.docs.get(docId)!.name, content: c.content });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function setEmbeddings(vectors: Map<number, number[]>): void {
  for (const chunks of state.chunks.values()) {
    for (const c of chunks) {
      const v = vectors.get(c.id);
      if (v) c.embedding = v;
    }
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Hybrid search, mirroring the SQL in retrieve.ts: a semantic ranking (cosine
 * similarity) and a keyword ranking (BM25) merged with Reciprocal Rank Fusion.
 */
export function search(
  question: string,
  embedding: number[] | null,
  documentIds: string[],
  candidates: number,
  topK: number,
): HitRow[] {
  const scope = documentIds.flatMap((id) => state.chunks.get(id) ?? []);
  if (scope.length === 0) return [];

  const semantic = new Map<number, { rank: number; sim: number }>();
  if (embedding) {
    scope
      .filter((c) => c.embedding)
      .map((c) => ({ c, sim: cosine(embedding, c.embedding!) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, candidates)
      .forEach(({ c, sim }, i) => semantic.set(c.id, { rank: i + 1, sim }));
  }

  const keyword = new Map<number, number>();
  const terms = [...new Set(tokenize(question))].slice(0, 20);
  if (terms.length) {
    const N = scope.length;
    const avgLen = scope.reduce((n, c) => n + c.len, 0) / N || 1;
    const idf = new Map(
      terms.map((t) => {
        const df = scope.filter((c) => c.tf.has(t)).length;
        return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))];
      }),
    );
    const k1 = 1.2;
    const b = 0.75;
    scope
      .map((c) => {
        let score = 0;
        for (const t of terms) {
          const f = c.tf.get(t);
          if (f) score += idf.get(t)! * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / avgLen)));
        }
        return { c, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, candidates)
      .forEach(({ c }, i) => keyword.set(c.id, i + 1));
  }

  return scope
    .filter((c) => semantic.has(c.id) || keyword.has(c.id))
    .map((c) => {
      const s = semantic.get(c.id);
      const k = keyword.get(c.id);
      return {
        id: c.id,
        document_id: c.document_id,
        name: state.docs.get(c.document_id)!.name,
        page: c.page,
        content: c.content,
        similarity: embedding && c.embedding ? (s?.sim ?? cosine(embedding, c.embedding)) : null,
        score: (s ? 1 / (60 + s.rank) : 0) + (k ? 1 / (60 + k) : 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, topK);
}

/** Records a hit unless the bucket is already at its limit. Returns false when over. */
export function rateHit(bucket: string, limit: number, windowSeconds: number): boolean {
  const now = Date.now();
  const recent = (state.rate.get(bucket) ?? []).filter((t) => t > now - windowSeconds * 1000);
  if (recent.length >= limit) {
    state.rate.set(bucket, recent);
    return false;
  }
  recent.push(now);
  state.rate.set(bucket, recent);
  return true;
}

export function pruneRateEvents(): void {
  const cutoff = Date.now() - 2 * 86_400_000;
  for (const [bucket, times] of state.rate) {
    const keep = times.filter((t) => t > cutoff);
    if (keep.length) state.rate.set(bucket, keep);
    else state.rate.delete(bucket);
  }
}
