import { config } from "./config";

// A tiny database layer with two backends:
//  - DATABASE_URL set   -> real Postgres + pgvector (Neon, Supabase, RDS, local Docker...)
//  - DATABASE_URL unset -> PGlite, an embedded WASM Postgres with pgvector, stored in
//                          ./.data/pglite so the project runs locally with zero setup.
// Both speak plain SQL with $1-style parameters, so the rest of the app doesn't care.

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

const SCHEMA = (dims: number) => `
create extension if not exists vector;

create table if not exists documents (
  id          uuid primary key,
  workspace   text not null,
  name        text not null,
  mime        text not null,
  pages       int  not null default 0,
  chars       int  not null default 0,
  chunk_count int  not null default 0,
  is_sample   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists documents_workspace_idx on documents (workspace);
create unique index if not exists documents_sample_name_idx on documents (name) where is_sample;

create table if not exists chunks (
  id          bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  idx         int  not null,
  page        int,
  content     text not null,
  tsv         tsvector generated always as (to_tsvector('english', content)) stored,
  embedding   vector(${dims}) -- null until embedded (no API key yet, or provider was down)
);
create index if not exists chunks_document_idx on chunks (document_id);
create index if not exists chunks_tsv_idx on chunks using gin (tsv);
create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

create table if not exists rate_events (
  bucket     text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_events_idx on rate_events (bucket, created_at);
`;

async function createPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    max: 5,
    prepare: false, // safe behind poolers like Neon's or PgBouncer
    idle_timeout: 20,
    onnotice: () => {},
  });
  const wrap = (s: typeof sql): Queryable => ({
    async query<T extends Row>(text: string, params: unknown[] = []) {
      return (await s.unsafe(text, params as never[])) as unknown as T[];
    },
  });
  return {
    ...wrap(sql),
    async exec(text) {
      await sql.unsafe(text);
    },
    async transaction(fn) {
      return (await sql.begin((tx) => fn(wrap(tx as unknown as typeof sql)))) as never;
    },
  };
}

async function createPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { mkdirSync } = await import("node:fs");
  // On Vercel only /tmp is writable. A /tmp database is per-instance and temporary, so
  // it's fine for trying the demo, but set DATABASE_URL (e.g. Neon) for anything real.
  const dir = process.env.PGLITE_DIR ?? (process.env.VERCEL ? "/tmp/askdocs-pglite" : ".data/pglite");
  if (process.env.VERCEL) {
    console.warn("[db] DATABASE_URL is not set; using a temporary PGlite database in /tmp.");
  }
  mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir, { extensions: { vector } });
  await pg.waitReady;
  return {
    async query<T extends Row>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    },
    async exec(text) {
      await pg.exec(text);
    },
    async transaction(fn) {
      return pg.transaction((tx) =>
        fn({
          async query<T extends Row>(text: string, params: unknown[] = []) {
            return (await tx.query<T>(text, params)).rows;
          },
        }),
      );
    },
  };
}

// One shared instance per server process (survives hot reloads in development).
const globalForDb = globalThis as unknown as { __ragDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForDb.__ragDb) {
    globalForDb.__ragDb = (async () => {
      const db = config.databaseUrl
        ? await createPostgres(config.databaseUrl)
        : await createPglite();
      await db.exec(SCHEMA(config.llm.embeddingDimensions));
      return db;
    })().catch((err) => {
      globalForDb.__ragDb = undefined;
      throw err;
    });
  }
  return globalForDb.__ragDb;
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;
