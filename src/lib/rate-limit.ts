import { createHash } from "node:crypto";
import { config } from "./config";
import { getDb } from "./db";
import { AppError } from "./errors";
import * as mem from "./memory-store";

// A small Postgres-backed rate limiter. It keeps a public demo from running up an
// LLM bill: per-IP limits stop one visitor from hammering it, and a global daily
// cap puts a hard ceiling on spend. IPs are stored hashed, never in plain text.

export function clientKey(req: Request): string {
  const ip =
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local";
  return createHash("sha256").update(ip).digest("hex").slice(0, 24);
}

async function hit(bucket: string, limit: number, windowSeconds: number, message: string) {
  if (config.storage === "memory") {
    // Per server instance only, which is still enough to stop one visitor hammering it.
    if (!mem.rateHit(bucket, limit, windowSeconds)) throw new AppError(message, 429);
    return;
  }
  const db = await getDb();
  const [row] = await db.query<{ n: number }>(
    `select count(*)::int as n from rate_events
      where bucket = $1 and created_at > now() - make_interval(secs => $2::int)`,
    [bucket, windowSeconds],
  );
  if ((row?.n ?? 0) >= limit) throw new AppError(message, 429);
  await db.query(`insert into rate_events (bucket) values ($1)`, [bucket]);
}

export async function limitChat(req: Request) {
  const key = clientKey(req);
  await hit(
    "chat:global",
    config.limits.chatsPerDayGlobal,
    86_400,
    "The demo has reached its daily question limit. Please try again tomorrow.",
  );
  await hit(
    `chat:${key}`,
    config.limits.chatPerIpPerHour,
    3_600,
    "You've asked a lot of questions in the last hour. Please wait a bit and try again.",
  );
}

export async function limitUpload(req: Request) {
  await hit(
    `upload:${clientKey(req)}`,
    config.limits.uploadsPerIpPerHour,
    3_600,
    "Upload limit reached for this hour. Please try again later.",
  );
}

/** Old rate events are only needed for the longest window (one day). */
export async function pruneRateEvents() {
  if (config.storage === "memory") return mem.pruneRateEvents();
  const db = await getDb();
  await db.query(`delete from rate_events where created_at < now() - interval '2 days'`);
}
