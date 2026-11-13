// Central configuration. Every value can be overridden with an environment variable,
// so the same code runs against OpenRouter or OpenAI, and against Neon/Supabase/any
// Postgres with pgvector (or an embedded PGlite database for local development).

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Empty values (like the blank placeholders in .env.example) count as "not set".
const env = (name: string) => process.env[name]?.trim() || undefined;
const openRouterKey = env("OPENROUTER_API_KEY");
const apiKey = openRouterKey ?? env("OPENAI_API_KEY");

export const config = {
  llm: {
    /**
     * Without a key the app still works in "passages only" mode: keyword search plus
     * answers quoted straight from the best-matching passages. Adding a key turns on
     * semantic search and AI-written answers.
     */
    enabled: !!apiKey,
    apiKey: apiKey ?? "",
    baseURL:
      env("LLM_BASE_URL") ??
      (openRouterKey ? "https://openrouter.ai/api/v1" : undefined),
    chatModel:
      env("CHAT_MODEL") ??
      (openRouterKey ? "google/gemini-2.5-flash-lite" : "gpt-4.1-mini"),
    embeddingModel:
      env("EMBEDDING_MODEL") ??
      (openRouterKey ? "openai/text-embedding-3-small" : "text-embedding-3-small"),
    // Must match the vector(...) column size in the database schema.
    embeddingDimensions: num("EMBEDDING_DIMENSIONS", 1536),
  },

  databaseUrl: env("DATABASE_URL"),

  /**
   * Where documents live:
   *  - "postgres": DATABASE_URL is set (Neon, Supabase, RDS...). Permanent.
   *  - "pglite":   embedded WASM Postgres in ./.data. The local-dev default.
   *  - "memory":   plain in-process JavaScript. The default on Vercel without a
   *                database: booting PGlite costs ~16 s of CPU per cold start, this
   *                costs almost nothing. Uploads are temporary either way.
   */
  storage: ((): "postgres" | "pglite" | "memory" => {
    const forced = env("DB_BACKEND");
    if (forced === "postgres" || forced === "pglite" || forced === "memory") return forced;
    if (env("DATABASE_URL")) return "postgres";
    return process.env.VERCEL ? "memory" : "pglite";
  })(),

  retrieval: {
    topK: num("RETRIEVAL_TOP_K", 6),
    candidates: num("RETRIEVAL_CANDIDATES", 24),
    chunkSize: num("CHUNK_SIZE", 1000), // characters
    chunkOverlap: num("CHUNK_OVERLAP", 150),
  },

  limits: {
    maxFileBytes: num("MAX_FILE_MB", 4) * 1024 * 1024,
    maxPages: num("MAX_PAGES", 60),
    maxChunksPerDocument: num("MAX_CHUNKS_PER_DOC", 300),
    maxDocumentsPerWorkspace: num("MAX_DOCS_PER_WORKSPACE", 5),
    uploadRetentionHours: num("UPLOAD_RETENTION_HOURS", 24),
    chatPerIpPerHour: num("CHAT_PER_IP_PER_HOUR", 40),
    uploadsPerIpPerHour: num("UPLOADS_PER_IP_PER_HOUR", 10),
    chatsPerDayGlobal: num("CHATS_PER_DAY_GLOBAL", 2000),
    maxQuestionChars: 1000,
  },
} as const;

export const SAMPLE_WORKSPACE = "sample";
