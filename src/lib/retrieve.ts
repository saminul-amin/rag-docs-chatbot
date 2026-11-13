import { embedOne } from "./ai";
import { config } from "./config";
import { getDb, toVector } from "./db";
import * as mem from "./memory-store";

export interface Passage {
  /** Citation number shown to the model and the user: [1], [2], ... */
  n: number;
  chunkId: string;
  documentId: string;
  documentName: string;
  page: number | null;
  content: string;
  /** Cosine similarity between the question and the passage (0..1); null for keyword-only hits. */
  similarity: number | null;
}

export interface RetrievalResult {
  passages: Passage[];
  /** "hybrid" when semantic search ran, "keyword" when it couldn't (no key / provider down). */
  mode: "hybrid" | "keyword";
}

type HitRow = {
  id: string | number;
  document_id: string;
  name: string;
  page: number | null;
  content: string;
  similarity: number | string | null;
  score: number | string;
};

/**
 * Hybrid retrieval: semantic search (pgvector cosine distance) and keyword search
 * (Postgres full-text) run side by side, then are merged with Reciprocal Rank
 * Fusion. Semantic search catches paraphrases ("time off" vs "vacation days");
 * keyword search catches exact terms like error codes, SKUs and names
 * that embeddings tend to blur. If the question can't be embedded, the same
 * query degrades to keyword search alone instead of failing.
 */
export async function retrieve(question: string, documentIds: string[]): Promise<RetrievalResult> {
  if (documentIds.length === 0) return { passages: [], mode: "keyword" };
  let embedding: number[] | null = null;
  if (config.llm.enabled) {
    try {
      embedding = await embedOne(question);
    } catch (err) {
      console.warn("[retrieve] embedding failed, using keyword search only:", (err as Error).message);
    }
  }
  return {
    passages: await searchChunks(question, embedding, documentIds),
    mode: embedding ? "hybrid" : "keyword",
  };
}

export async function searchChunks(
  question: string,
  embedding: number[] | null,
  documentIds: string[],
): Promise<Passage[]> {
  const { topK, candidates } = config.retrieval;
  const rows: HitRow[] =
    config.storage === "memory"
      ? mem.search(question, embedding, documentIds, candidates, topK)
      : await sqlSearch(question, embedding, documentIds, candidates, topK);

  return rows.map((r, i) => ({
    n: i + 1,
    chunkId: String(r.id),
    documentId: r.document_id,
    documentName: r.name,
    page: r.page,
    content: r.content,
    similarity: r.similarity === null ? null : Number(r.similarity),
  }));
}

async function sqlSearch(
  question: string,
  embedding: number[] | null,
  documentIds: string[],
  candidates: number,
  topK: number,
): Promise<HitRow[]> {
  const db = await getDb();
  return db.query<HitRow>(
    `with scope as (
       select c.* from chunks c
        where c.document_id = any(string_to_array($2, ',')::uuid[])
     ),
     semantic as (
       select id, row_number() over (order by embedding <=> $1::vector) as rank
         from scope
        where $1::vector is not null and embedding is not null
        order by embedding <=> $1::vector
        limit $4
     ),
     keyword as (
       select id, row_number() over (order by ts_rank_cd(tsv, q) desc) as rank
         from scope, websearch_to_tsquery('english', $3) q
        where tsv @@ q
        order by ts_rank_cd(tsv, q) desc
        limit $4
     ),
     fused as (
       select coalesce(s.id, k.id) as id,
              coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as score
         from semantic s
         full outer join keyword k on k.id = s.id
     )
     select c.id, c.document_id, d.name, c.page, c.content,
            case when $1::vector is null or c.embedding is null then null
                 else 1 - (c.embedding <=> $1::vector) end as similarity,
            f.score
       from fused f
       join chunks c on c.id = f.id
       join documents d on d.id = c.document_id
      order by f.score desc, c.id
      limit $5`,
    [embedding ? toVector(embedding) : null, documentIds.join(","), keywordQuery(question), candidates, topK],
  );
}

/**
 * websearch_to_tsquery ANDs every word, which is too strict for natural questions.
 * OR the meaningful words instead, so any matching term can surface a passage.
 */
function keywordQuery(question: string): string {
  const words = question
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}\-_.]*/gu)
    ?.map((w) => w.replace(/[.\-_]+$/, ""))
    .filter((w) => w.length > 2 || /\d/.test(w))
    .slice(0, 20);
  return words?.length ? words.join(" or ") : question;
}
