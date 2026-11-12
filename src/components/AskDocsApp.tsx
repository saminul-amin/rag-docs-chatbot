"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DocumentInfo } from "@/lib/documents";
import type { Passage } from "@/lib/retrieve";
import { AnswerText, citedNumbers } from "./AnswerText";
import {
  BookIcon,
  ChevronIcon,
  FileIcon,
  GithubIcon,
  SendIcon,
  SparkIcon,
  Spinner,
  TrashIcon,
  UploadIcon,
} from "./icons";

const REPO_URL = "https://github.com/saminul-amin/rag-docs-chatbot";

const SUGGESTIONS = [
  "How many vacation days do new employees get, and can they carry them over?",
  "My espresso machine shows E04. What should I do?",
  "Can I return a bag of coffee I already opened?",
  "What's the daily meal limit when travelling for work?",
];

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Passage[];
  question?: string;
  searchQuery?: string;
  answerMode?: "ai" | "passages";
  searchMode?: "hybrid" | "keyword";
  model?: string | null;
  ms?: number;
  error?: string;
  streaming?: boolean;
}

interface UploadState {
  name: string;
  error?: string;
}

function getWorkspaceId(): string {
  const KEY = "askdocs-workspace";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID(); // private mode: a fresh workspace per visit
  }
}

const newId = () => Math.random().toString(36).slice(2);

export function AskDocsApp() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDocsMobile, setShowDocsMobile] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const headers = useMemo(() => (workspace ? { "x-workspace-id": workspace } : undefined), [workspace]);

  useEffect(() => {
    setWorkspace(getWorkspaceId());
  }, []);

  const loadDocuments = useCallback(async () => {
    if (!headers) return;
    setDocsLoading(true);
    setDocsError(null);
    try {
      const res = await fetch("/api/documents", { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't load documents.");
      setDocuments(data.documents);
      setAiEnabled(data.aiEnabled !== false);
      setSelected(new Set((data.documents as DocumentInfo[]).map((d) => d.id)));
    } catch (err) {
      setDocsError((err as Error).message);
    } finally {
      setDocsLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function uploadFiles(files: FileList | File[]) {
    if (!headers) return;
    for (const file of Array.from(files)) {
      setUploads((u) => [...u, { name: file.name }]);
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/documents", { method: "POST", headers, body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status}).`);
        const doc = data.document as DocumentInfo;
        setDocuments((d) => [...d, doc]);
        setSelected((s) => new Set(s).add(doc.id));
        setUploads((u) => u.filter((x) => x.name !== file.name));
      } catch (err) {
        setUploads((u) =>
          u.map((x) => (x.name === file.name ? { ...x, error: (err as Error).message } : x)),
        );
      }
    }
  }

  async function removeDocument(id: string) {
    if (!headers) return;
    const res = await fetch(`/api/documents/${id}`, { method: "DELETE", headers });
    if (res.ok || res.status === 404) {
      setDocuments((d) => d.filter((x) => x.id !== id));
      setSelected((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const patchMessage = (id: string, patch: (m: Message) => Partial<Message>) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch(m) } : m)));

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy || !headers) return;
    setInput("");
    setBusy(true);

    const history = messages
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    const assistantId = newId();
    setMessages((ms) => [
      ...ms,
      { id: newId(), role: "user", content: q },
      { id: assistantId, role: "assistant", content: "", question: q, streaming: true },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, documentIds: [...selected], history }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "meta")
            patchMessage(assistantId, () => ({
              searchQuery: event.searchQuery,
              answerMode: event.answerMode,
              searchMode: event.searchMode,
              model: event.model,
            }));
          else if (event.type === "sources") patchMessage(assistantId, () => ({ sources: event.sources }));
          else if (event.type === "delta")
            patchMessage(assistantId, (m) => ({ content: m.content + event.text }));
          else if (event.type === "done") patchMessage(assistantId, () => ({ ms: event.ms }));
          else if (event.type === "error") throw new Error(event.message);
        }
      }
    } catch (err) {
      patchMessage(assistantId, () => ({ error: (err as Error).message }));
    } finally {
      patchMessage(assistantId, () => ({ streaming: false }));
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  const selectedCount = documents.filter((d) => selected.has(d.id)).length;
  const userDocs = documents.filter((d) => !d.isSample);

  const docsPanel = (
    <DocumentsPanel
      documents={documents}
      loading={docsLoading}
      error={docsError}
      selected={selected}
      uploads={uploads}
      userDocCount={userDocs.length}
      onToggle={toggle}
      onRemove={removeDocument}
      onUpload={uploadFiles}
      onDismissUpload={(name) => setUploads((u) => u.filter((x) => x.name !== name))}
      onRetry={loadDocuments}
    />
  );

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line bg-panel px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-white shadow-sm">
            <BookIcon width={19} height={19} />
          </div>
          <div>
            <h1 className="text-[1.05rem] font-semibold tracking-tight">AskDocs</h1>
            <p className="hidden text-xs text-muted sm:block">
              Chat with your documents. Every answer cites the passage it came from.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1.5 lg:flex">
            {[aiEnabled ? "Hybrid search" : "Keyword search", "Postgres + pgvector", "Cited answers"].map((t) => (
              <span
                key={t}
                className="rounded-full border border-line bg-canvas px-2.5 py-1 text-[0.7rem] font-medium text-muted"
              >
                {t}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowDocsMobile((v) => !v)}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium md:hidden"
          >
            Documents ({selectedCount})
          </button>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink/80 transition hover:bg-canvas"
          >
            <GithubIcon width={16} height={16} />
            <span className="hidden sm:inline">Source</span>
          </a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[22rem] shrink-0 flex-col border-r border-line bg-panel md:flex">
          {docsPanel}
        </aside>

        {showDocsMobile && (
          <div className="fixed inset-0 z-20 flex md:hidden" onClick={() => setShowDocsMobile(false)}>
            <div
              className="flex h-full w-[85%] max-w-sm flex-col bg-panel shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              {docsPanel}
            </div>
            <div className="flex-1 bg-black/30" />
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
              {messages.length === 0 ? (
                <EmptyState onPick={ask} disabled={busy || selectedCount === 0} aiEnabled={aiEnabled} />
              ) : (
                <div className="space-y-6">
                  {messages.map((m) =>
                    m.role === "user" ? (
                      <div key={m.id} className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[0.95rem] text-white shadow-sm">
                          {m.content}
                        </div>
                      </div>
                    ) : (
                      <AssistantMessage key={m.id} message={m} />
                    ),
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-line bg-canvas/80 px-4 pb-4 pt-3 backdrop-blur sm:px-6">
            <form
              className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-line bg-panel p-2 shadow-sm focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10"
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(input);
                  }
                }}
                rows={1}
                maxLength={1000}
                placeholder={
                  selectedCount === 0
                    ? "Select a document to start…"
                    : "Ask a question about your documents…"
                }
                className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-2 text-[0.95rem] outline-none placeholder:text-muted/70"
              />
              <button
                type="submit"
                disabled={busy || !input.trim() || selectedCount === 0}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Send"
              >
                {busy ? <Spinner /> : <SendIcon />}
              </button>
            </form>
            <p className="mx-auto mt-2 max-w-3xl text-center text-[0.72rem] text-muted">
              Searching {selectedCount} of {documents.length} document{documents.length === 1 ? "" : "s"}.
              Answers come only from your documents and link to their sources.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

function EmptyState({
  onPick,
  disabled,
  aiEnabled,
}: {
  onPick: (q: string) => void;
  disabled: boolean;
  aiEnabled: boolean;
}) {
  return (
    <div className="flex flex-col items-center pt-6 text-center sm:pt-14">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">
        <SparkIcon width={22} height={22} />
      </div>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight">Ask anything about your documents</h2>
      <p className="mt-2 max-w-md text-sm text-muted">
        Three sample documents from a fictional coffee company are loaded: an employee handbook, a
        machine manual and a returns policy. Upload your own PDF, Word or text file on the left.
      </p>
      {!aiEnabled && (
        <p className="mt-4 max-w-lg rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-900">
          <strong className="font-semibold">Passages-only mode.</strong> No AI key is configured, so
          answers quote the best-matching sentences from your documents (keyword search). Add an
          OpenRouter or OpenAI key to turn on AI-written answers and semantic search.
        </p>
      )}
      <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="rounded-xl border border-line bg-panel px-4 py-3 text-left text-sm text-ink/85 shadow-sm transition hover:border-accent/40 hover:bg-accent-soft/40 disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function AssistantMessage({ message: m }: { message: Message }) {
  const [active, setActive] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const sourceRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const sources = m.sources ?? [];
  const valid = useMemo(() => new Set((m.sources ?? []).map((s) => s.n)), [m.sources]);
  const pattern = useMemo(() => questionPattern(m.searchQuery ?? m.question), [m.searchQuery, m.question]);
  const cited = citedNumbers(m.content).filter((n) => valid.has(n));
  const citedSources = cited.map((n) => sources.find((s) => s.n === n)!).filter(Boolean);
  const shown = showAll ? sources : citedSources;

  function cite(n: number) {
    setActive(n);
    if (!citedSources.some((s) => s.n === n)) setShowAll(true);
    requestAnimationFrame(() => {
      const el = sourceRefs.current.get(n);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      el?.classList.remove("source-flash");
      void el?.offsetWidth;
      el?.classList.add("source-flash");
    });
  }

  const waiting = m.streaming && !m.content;

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        <BookIcon width={16} height={16} />
      </div>
      <div className="min-w-0 flex-1">
        {waiting && (
          <div className="flex items-center gap-2 py-1.5 text-sm text-muted">
            <Spinner className="text-accent" />
            {m.sources ? `Reading ${m.sources.length} passages…` : "Searching your documents…"}
          </div>
        )}
        {m.content && (
          <AnswerText text={m.content} streaming={!!m.streaming} validNumbers={valid} onCite={cite} />
        )}
        {m.error && (
          <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {m.error}
          </div>
        )}

        {!m.streaming && sources.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
                {showAll ? `All ${sources.length} retrieved passages` : `Sources (${citedSources.length})`}
              </h3>
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-xs font-medium text-accent hover:underline"
              >
                {showAll ? "Show cited only" : `Show all ${sources.length} retrieved`}
              </button>
            </div>
            <div className="space-y-2">
              {shown.map((s) => (
                <SourceCard
                  key={s.n}
                  source={s}
                  pattern={pattern}
                  active={active === s.n}
                  onToggle={() => setActive(active === s.n ? null : s.n)}
                  refCb={(el) => {
                    if (el) sourceRefs.current.set(s.n, el);
                    else sourceRefs.current.delete(s.n);
                  }}
                />
              ))}
              {shown.length === 0 && (
                <p className="text-sm text-muted">The answer didn&apos;t cite any passage.</p>
              )}
            </div>
          </div>
        )}

        {!m.streaming && m.ms !== undefined && (
          <p className="mt-3 flex flex-wrap items-center gap-x-1.5 text-[0.72rem] text-muted">
            {m.answerMode && (
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  m.answerMode === "ai" ? "bg-accent-soft text-accent" : "bg-amber-50 text-amber-800"
                }`}
              >
                {m.answerMode === "ai" ? "AI answer" : "Passages only"}
              </span>
            )}
            {m.searchQuery && m.searchQuery !== m.question ? (
              <span>Searched for &ldquo;{m.searchQuery}&rdquo; ·</span>
            ) : null}
            <span>
              {m.searchMode === "keyword" ? "keyword search" : "hybrid search"} · {sources.length}{" "}
              passages · {m.ms < 1000 ? `${m.ms} ms` : `${(m.ms / 1000).toFixed(1)}s`}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

/** Strips Markdown markup (headings, bold, italics) so source passages read as plain text. */
function plainText(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:])/gm, "$1$2");
}

const HIGHLIGHT_STOPWORDS = new Set(
  "what which when where how does have about with from that this there their your they should would could many much often shows tell".split(
    " ",
  ),
);

/** Builds a regex matching the question's key words (and their variants, via a short prefix). */
function questionPattern(question?: string): RegExp | null {
  const words = (question ?? "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((w) => (w.length >= 4 || /\d/.test(w)) && !HIGHLIGHT_STOPWORDS.has(w))
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words?.length) return null;
  return new RegExp(`\\b(${[...new Set(words)].join("|")})[\\p{L}\\p{N}]*`, "giu");
}

/** For the collapsed card: start at the sentence that best matches the question. */
function preview(text: string, pattern: RegExp | null): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!pattern) return flat;
  const sentences = flat.split(/(?<=[.!?])\s+/);
  let best = 0;
  let bestScore = 0;
  sentences.forEach((s, i) => {
    // Distinct matched words; codes and numbers ("E04") count triple since they are the most specific.
    const hits = new Set(s.match(pattern)?.map((m) => m.toLowerCase()));
    const score = [...hits].reduce((n, w) => n + (/\d/.test(w) ? 3 : 1), 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best === 0 ? flat : `…${sentences.slice(best).join(" ")}`;
}

function Highlighted({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <mark key={m.index} className="rounded-sm bg-amber-100 px-0.5 text-ink">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function SourceCard({
  source: s,
  pattern,
  active,
  onToggle,
  refCb,
}: {
  source: Passage;
  pattern: RegExp | null;
  active: boolean;
  onToggle: () => void;
  refCb: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={refCb}
      className={`rounded-xl border bg-panel transition ${active ? "border-accent/50" : "border-line"}`}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-3 py-2.5 text-left">
        <span className="mt-0.5 grid h-5 min-w-5 place-items-center rounded-md bg-accent-soft px-1 text-[0.7rem] font-semibold text-accent">
          {s.n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-ink">
            <span className="truncate">{s.documentName}</span>
            {s.page && <span className="shrink-0 text-xs font-normal text-muted">page {s.page}</span>}
            <span
              className="ml-auto shrink-0 text-[0.68rem] font-normal text-muted"
              title={s.similarity === null ? "Found by keyword search" : "Semantic similarity"}
            >
              {s.similarity === null ? "keyword match" : `${Math.round(s.similarity * 100)}% match`}
            </span>
          </span>
          {active ? (
            <span className="mt-1 block whitespace-pre-line text-[0.8rem] leading-relaxed text-ink/70">
              <Highlighted text={plainText(s.content)} pattern={pattern} />
            </span>
          ) : (
            <span className="mt-1 line-clamp-2 text-[0.8rem] leading-relaxed text-ink/70">
              <Highlighted text={preview(plainText(s.content), pattern)} pattern={pattern} />
            </span>
          )}
        </span>
        <ChevronIcon
          width={16}
          height={16}
          className={`mt-0.5 shrink-0 text-muted transition ${active ? "rotate-180" : ""}`}
        />
      </button>
    </div>
  );
}

function DocumentsPanel(props: {
  documents: DocumentInfo[];
  loading: boolean;
  error: string | null;
  selected: Set<string>;
  uploads: UploadState[];
  userDocCount: number;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onUpload: (files: FileList | File[]) => void;
  onDismissUpload: (name: string) => void;
  onRetry: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const samples = props.documents.filter((d) => d.isSample);
  const mine = props.documents.filter((d) => !d.isSample);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line p-4">
        <h2 className="text-sm font-semibold">Knowledge base</h2>
        <p className="mt-0.5 text-xs text-muted">Pick which documents the assistant can search.</p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) props.onUpload(e.dataTransfer.files);
          }}
          className={`mt-3 flex w-full flex-col items-center rounded-xl border-2 border-dashed px-4 py-5 text-center transition ${
            dragging ? "border-accent bg-accent-soft" : "border-line hover:border-accent/50 hover:bg-canvas"
          }`}
        >
          <UploadIcon className="text-accent" />
          <span className="mt-2 text-sm font-medium">Upload a document</span>
          <span className="mt-0.5 text-xs text-muted">PDF, DOCX, TXT or MD · up to 4 MB</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) props.onUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {props.uploads.map((u) => (
          <div
            key={u.name}
            className={`rounded-xl border px-3 py-2.5 text-sm ${u.error ? "border-red-200 bg-red-50" : "border-line bg-canvas"}`}
          >
            <div className="flex items-center gap-2">
              {u.error ? <FileIcon className="text-red-600" /> : <Spinner className="text-accent" />}
              <span className="truncate font-medium">{u.name}</span>
              {u.error && (
                <button
                  type="button"
                  onClick={() => props.onDismissUpload(u.name)}
                  className="ml-auto text-xs text-red-700 hover:underline"
                >
                  Dismiss
                </button>
              )}
            </div>
            <p className={`mt-1 text-xs ${u.error ? "text-red-700" : "text-muted"}`}>
              {u.error ?? "Reading, chunking and embedding…"}
            </p>
          </div>
        ))}

        {props.loading && props.documents.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="text-accent" /> Loading documents…
          </div>
        )}
        {props.error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {props.error}{" "}
            <button type="button" onClick={props.onRetry} className="font-medium underline">
              Retry
            </button>
          </div>
        )}

        {mine.length > 0 && (
          <DocGroup title="Your documents" docs={mine} {...props} removable />
        )}
        {samples.length > 0 && <DocGroup title="Sample documents" docs={samples} {...props} />}
      </div>

      <p className="border-t border-line px-4 py-3 text-[0.7rem] leading-relaxed text-muted">
        Uploads are visible only in this browser and are deleted automatically after 24 hours. Please
        don&apos;t upload confidential files to a public demo.
      </p>
    </div>
  );
}

function DocGroup({
  title,
  docs,
  selected,
  onToggle,
  onRemove,
  removable,
}: {
  title: string;
  docs: DocumentInfo[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  removable?: boolean;
}) {
  return (
    <section>
      <h3 className="mb-2 text-[0.7rem] font-semibold uppercase tracking-wider text-muted">{title}</h3>
      <ul className="space-y-1.5">
        {docs.map((d) => {
          const on = selected.has(d.id);
          return (
            <li key={d.id}>
              <label
                className={`group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                  on ? "border-accent/30 bg-accent-soft/50" : "border-line hover:bg-canvas"
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(d.id)}
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                <FileIcon className={`shrink-0 ${on ? "text-accent" : "text-muted"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{d.name}</span>
                  <span className="block text-xs text-muted">
                    {d.pages ? `${d.pages} pages · ` : ""}
                    {d.chunkCount} passages indexed
                  </span>
                </span>
                {removable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      onRemove(d.id);
                    }}
                    className="rounded-md p-1 text-muted opacity-60 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                    aria-label={`Remove ${d.name}`}
                  >
                    <TrashIcon width={16} height={16} />
                  </button>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
