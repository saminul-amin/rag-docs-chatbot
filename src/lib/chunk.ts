import type { ParsedPage } from "./parse";

export interface Chunk {
  idx: number;
  page: number | null;
  content: string;
}

/**
 * Splits text into ~`size`-character chunks along natural boundaries
 * (paragraphs, then lines, then sentences, then words), with a small overlap so an
 * answer that straddles two chunks is still retrievable. Chunks never cross a page
 * boundary, which keeps page citations exact.
 */
export function chunkPages(pages: ParsedPage[], size: number, overlap: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (const { page, text } of pages) {
    if (!text.trim()) continue;
    for (const content of pack(split(text.trim(), size, 0), size, overlap)) {
      chunks.push({ idx: chunks.length, page, content });
    }
  }
  return chunks;
}

interface Unit {
  text: string;
  /** Separator that joined this unit to the previous one in the original text. */
  sep: string;
}

const LEVELS: { re: RegExp; sep: string }[] = [
  { re: /\n\s*\n/, sep: "\n\n" }, // paragraphs
  { re: /\n/, sep: "\n" }, // lines
  { re: /(?<=[.!?])\s+/, sep: " " }, // sentences
  { re: /\s+/, sep: " " }, // words
];

function split(text: string, size: number, level: number, sep = ""): Unit[] {
  if (text.length <= size) return [{ text, sep }];
  if (level >= LEVELS.length) {
    // A single "word" longer than a chunk: hard-cut it.
    const out: Unit[] = [];
    for (let i = 0; i < text.length; i += size) out.push({ text: text.slice(i, i + size), sep: i ? "" : sep });
    return out;
  }
  const { re, sep: levelSep } = LEVELS[level];
  return text
    .split(re)
    .map((t) => t.trim())
    .filter(Boolean)
    .flatMap((part, i) => split(part, size, level + 1, i === 0 ? sep : levelSep));
}

function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return "";
  const tail = text.slice(-overlap);
  // Start the overlap at a sentence boundary if there is one, otherwise a word boundary.
  const sentence = tail.search(/[.!?]\s+\S/);
  if (sentence !== -1) return tail.slice(sentence + 1).trim();
  const space = tail.search(/\s/);
  return space === -1 ? "" : tail.slice(space + 1).trim();
}

function pack(units: Unit[], size: number, overlap: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const { text, sep } of units) {
    if (cur && cur.length + sep.length + text.length > size) {
      out.push(cur);
      const tail = overlapTail(cur, overlap);
      cur = tail && tail.length + 1 + text.length <= size ? `${tail} ${text}` : text;
    } else {
      cur = cur ? cur + (sep || " ") + text : text;
    }
  }
  if (cur) out.push(cur);
  return out;
}
