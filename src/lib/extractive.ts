import type { Passage } from "./retrieve";

// "Passages only" answers: used when no LLM key is configured, or when the LLM
// provider fails. Instead of generating text, pick the sentences from the retrieved
// passages that best match the question and cite them. Nothing is invented, so the
// answer is always traceable, just less fluent than an AI-written one.

export const STOPWORDS = new Set(
  (
    "a about after all also am an and any are as at be been but by can could did do does " +
    "for from get got had has have how i if in into is it its me my no not of on or our " +
    "should so than that the their them then there these they this to up was we what when " +
    "where which who why will with would you your many much more most please tell know " +
    "often long mean means need happen way show shows say says help want see give anything something take takes"
  ).split(" "),
);

export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w) && (w.length > 2 || /\d/.test(w))).map(stem));
}

/** Matches lines that start a new item: bullets, numbered items, headings, codes like "E04". */
const NEW_ITEM = /^([-*•]\s|#{1,6}\s|\d+[.)]\s|[A-Z]\d{2,}\b)/;

/**
 * Splits a passage into sentences. PDF text wraps mid-sentence, so lines are first
 * re-joined, except where a line starts a new bullet, heading or table row, or the
 * previous line was a short title.
 */
function sentences(content: string): string[] {
  const blocks: string[] = [];
  for (const line of content.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const prev = blocks.at(-1);
    const prevIsTitle = prev !== undefined && prev.length < 40 && !/[.!?:,;]$/.test(prev);
    if (prev === undefined || NEW_ITEM.test(line) || prevIsTitle || /[.!?:]$/.test(prev)) {
      blocks.push(line);
    } else {
      blocks[blocks.length - 1] = `${prev} ${line}`;
    }
  }
  return blocks
    .map((b) => b.replace(/^([-*•]|#{1,6}|\d+[.)])\s+/, ""))
    .flatMap((b) => b.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/))
    .map((s) => s.trim())
    .filter((s) => {
      const words = s.split(/\s+/).length;
      // Skip titles ("Aria Home Espresso Machine: User Manual"): short and unpunctuated.
      return s.length > 25 && (words >= 7 || (words >= 4 && /[.!?]$/.test(s)));
    });
}

/** Normalised form used to drop repeats caused by overlapping chunks. */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const NOT_FOUND_TEXT =
  "I couldn't find anything about that in the selected documents. Try rephrasing, or select more documents on the left.";

export function extractiveAnswer(question: string, passages: Passage[]): string {
  const q = [...terms(question)];
  if (q.length === 0 || passages.length === 0) return NOT_FOUND_TEXT;

  const candidates = passages.flatMap((p, rank) =>
    sentences(p.content).map((text, i) => ({ n: p.n, text, order: rank * 1000 + i, terms: terms(text) })),
  );

  // Weight each question word by how rare it is in the retrieved text (IDF), so a
  // sentence has to cover the specific words of the question, not just generic
  // ones. Words that never appear count as much as the rarest word that does: a
  // question about "dogs" isn't answered by sentences that only share "policy" and
  // "company" with it. Codes and numbers ("E04", "2026") count extra.
  const N = candidates.length;
  const weight = new Map(
    q.map((t) => {
      const df = candidates.filter((c) => c.terms.has(t)).length;
      const idf = Math.log(1 + N / Math.max(df, 1));
      return [t, /\d/.test(t) ? idf * 1.5 : idf];
    }),
  );
  const total = [...weight.values()].reduce((a, b) => a + b, 0);

  const scored = candidates
    .map((c) => ({
      ...c,
      score: q.reduce((sum, t) => sum + (c.terms.has(t) ? weight.get(t)! : 0), 0) / total,
    }))
    .filter((c) => c.score >= 0.4);
  // Drop weak extras: keep only sentences close to the best match.
  const top = Math.max(...scored.map((c) => c.score), 0);
  const strong = scored.filter((c) => c.score >= top * 0.6);
  if (scored.length === 0) return NOT_FOUND_TEXT;

  const best: typeof strong = [];
  for (const c of strong.sort((a, b) => b.score - a.score || a.order - b.order)) {
    const key = norm(c.text);
    if (best.some((b) => similar(norm(b.text), key))) continue;
    best.push(c);
    if (best.length === 3) break;
  }
  best.sort((a, b) => a.order - b.order);

  const clip = (s: string) => (s.length > 320 ? `${s.slice(0, 317).trimEnd()}…` : s);
  return [
    "Here are the passages from your documents that best match your question:",
    "",
    ...best.map((b) => `- ${clip(b.text)} [${b.n}]`),
  ].join("\n");
}

/** True when two sentences are the same or near-copies (overlapping chunks cut them differently). */
function similar(a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) return true;
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.8;
}
