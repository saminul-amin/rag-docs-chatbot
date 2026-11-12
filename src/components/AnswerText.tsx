"use client";

import type { ReactNode } from "react";

// A deliberately small Markdown renderer: paragraphs, bullet and numbered lists,
// **bold**, `code`, and citation markers like [2] or [1][3], which become buttons
// that jump to the matching source passage.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+(?:\s*,\s*\d+)*\])/g;

export function citedNumbers(text: string): number[] {
  const seen: number[] = [];
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of m[1].split(",").map((s) => Number(s.trim()))) {
      if (!seen.includes(n)) seen.push(n);
    }
  }
  return seen;
}

function Inline({
  text,
  validNumbers,
  onCite,
}: {
  text: string;
  validNumbers: Set<number>;
  onCite: (n: number) => void;
}) {
  const parts = text.split(INLINE);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={i} className="font-semibold text-ink">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code key={i} className="rounded bg-canvas px-1 py-0.5 font-mono text-[0.85em]">
              {part.slice(1, -1)}
            </code>
          );
        }
        const cite = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
        if (cite) {
          const nums = cite[1].split(",").map((s) => Number(s.trim()));
          return nums.map((n) =>
            validNumbers.has(n) ? (
              <button
                key={`${i}-${n}`}
                type="button"
                onClick={() => onCite(n)}
                className="mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] -translate-y-px items-center justify-center rounded-md bg-accent-soft px-1 align-middle text-[0.7rem] font-semibold text-accent ring-1 ring-accent/20 transition hover:bg-accent hover:text-white"
                aria-label={`Show source ${n}`}
              >
                {n}
              </button>
            ) : null,
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function AnswerText({
  text,
  streaming,
  validNumbers,
  onCite,
}: {
  text: string;
  streaming: boolean;
  validNumbers: Set<number>;
  onCite: (n: number) => void;
}) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push(
        <p key={blocks.length}>
          <Inline text={para.join(" ")} validNumbers={validNumbers} onCite={onCite} />
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const Tag = list.ordered ? "ol" : "ul";
      blocks.push(
        <Tag
          key={blocks.length}
          className={`space-y-1 pl-5 ${list.ordered ? "list-decimal" : "list-disc"} marker:text-muted`}
        >
          {list.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} validNumbers={validNumbers} onCite={onCite} />
            </li>
          ))}
        </Tag>,
      );
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.replace(/^#+\s*/, ""));
    }
  }
  flushPara();
  flushList();

  return (
    <div className={`space-y-3 leading-relaxed text-[0.95rem] text-ink/90 ${streaming ? "caret" : ""}`}>
      {blocks}
    </div>
  );
}
