import OpenAI from "openai";
import { config } from "./config";
import { AppError } from "./errors";

let client: OpenAI | undefined;

export function getClient(): OpenAI {
  if (!config.llm.apiKey) {
    throw new AppError(
      "No LLM API key configured. Set OPENROUTER_API_KEY (or OPENAI_API_KEY) in .env.local.",
      500,
    );
  }
  client ??= new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseURL,
    maxRetries: 2,
    timeout: 60_000,
    defaultHeaders: {
      // Optional OpenRouter attribution headers; harmless for other providers.
      "X-Title": "AskDocs RAG demo",
    },
  });
  return client;
}

const EMBED_BATCH = 64;

/** Embeds texts in batches, preserving order. */
export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await getClient().embeddings.create({
      model: config.llm.embeddingModel,
      input: batch,
      dimensions: config.llm.embeddingDimensions,
      encoding_format: "float",
    });
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    if (sorted.length !== batch.length) {
      throw new AppError("Embedding provider returned an unexpected number of vectors.", 502);
    }
    for (const d of sorted) out.push(d.embedding as number[]);
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}
