import { config } from "./config";
import { AppError } from "./errors";

export interface ParsedPage {
  /** 1-based page number, or null for formats without pages (DOCX, TXT, MD). */
  page: number | null;
  text: string;
}

export interface ParsedDocument {
  mime: string;
  pages: ParsedPage[];
  pageCount: number;
}

export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"] as const;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function clean(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new AppError(message, 422)), ms)),
  ]);
}

async function parsePdf(data: Uint8Array): Promise<ParsedDocument> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(data, { maxImageSize: 4_000_000 });
  } catch {
    throw new AppError("That PDF couldn't be opened. It may be damaged or password-protected.", 422);
  }
  if (pdf.numPages > config.limits.maxPages) {
    throw new AppError(
      `This demo accepts PDFs of up to ${config.limits.maxPages} pages (this one has ${pdf.numPages}).`,
      413,
    );
  }
  const { text } = await withTimeout(
    extractText(pdf, { mergePages: false }),
    25_000,
    "Reading that PDF took too long. Try a smaller file.",
  );
  const pages = stripRepeatedLines((text as string[]).map((t, i) => ({ page: i + 1, text: clean(t) }))).map(
    (p) => ({ ...p, text: reflow(p.text) }),
  );
  return { mime: "application/pdf", pages, pageCount: pdf.numPages };
}

/**
 * PDFs store text as visual lines, so a sentence is broken wherever the page wrapped
 * it. Re-join wrapped lines into paragraphs, but keep breaks after short lines
 * (titles, headings) and before bullets, numbered items and table rows like "E04 ...".
 */
function reflow(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const prev = out.at(-1);
    const wrapped =
      prev !== undefined &&
      prev !== "" &&
      line !== "" &&
      prev.length >= 60 &&
      !/[.!?:]$/.test(prev) &&
      !/^([-*•]\s|\d+[.)]\s|[A-Z]\d{2,}\b)/.test(line);
    if (wrapped) out[out.length - 1] = `${prev} ${line}`;
    else out.push(line);
  }
  return out.join("\n");
}

/**
 * Removes running headers and footers ("Company name - Page 3") that repeat on most
 * pages. Left in, they pollute every chunk and skew retrieval toward page furniture.
 */
function stripRepeatedLines(pages: ParsedPage[]): ParsedPage[] {
  if (pages.length < 3) return pages;
  const key = (line: string) => line.trim().toLowerCase().replace(/\d+/g, "#");
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const k of new Set(p.text.split("\n").map(key))) {
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
  const repeated = new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
  if (repeated.size === 0) return pages;
  return pages.map((p) => ({
    ...p,
    text: clean(p.text.split("\n").filter((l) => !repeated.has(key(l))).join("\n")),
  }));
}

async function parseDocx(data: Uint8Array): Promise<ParsedDocument> {
  const mammoth = await import("mammoth");
  try {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pages: [{ page: null, text: clean(value) }],
      pageCount: 0,
    };
  } catch {
    throw new AppError("That Word file couldn't be read. Please save it as .docx and try again.", 422);
  }
}

export async function parseFile(name: string, data: Uint8Array): Promise<ParsedDocument> {
  const ext = extensionOf(name);
  let doc: ParsedDocument;
  switch (ext) {
    case ".pdf":
      doc = await parsePdf(data);
      break;
    case ".docx":
      doc = await parseDocx(data);
      break;
    case ".txt":
    case ".md":
      doc = {
        mime: ext === ".md" ? "text/markdown" : "text/plain",
        pages: [{ page: null, text: clean(new TextDecoder("utf-8").decode(data)) }],
        pageCount: 0,
      };
      break;
    default:
      throw new AppError(`Unsupported file type. Upload ${ACCEPTED_EXTENSIONS.join(", ")}.`, 415);
  }

  const totalChars = doc.pages.reduce((n, p) => n + p.text.length, 0);
  if (totalChars < 30) {
    throw new AppError(
      "No readable text found. If this is a scanned PDF, it needs OCR first (a paid add-on in a real project).",
      422,
    );
  }
  return doc;
}
