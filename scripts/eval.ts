/**
 * Retrieval + answer quality check against the sample documents.
 *
 *   npm run eval
 *
 * For each question it checks (1) that the right document and page are among the
 * retrieved passages and (2) that the final answer contains the expected fact and
 * cites at least one passage. Uses a throwaway PGlite database, so it never touches
 * your real data. Costs a fraction of a cent per run. Without an API key it checks
 * keyword retrieval and the passages-only answers instead.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "askdocs-eval-"));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;

interface Case {
  q: string;
  doc: string;
  page?: number;
  expect: RegExp;
}

const CASES: Case[] = [
  { q: "How many vacation days do new employees get?", doc: "Handbook", page: 2, expect: /15/ },
  { q: "How many unused vacation days can I carry over?", doc: "Handbook", page: 2, expect: /5|five/i },
  { q: "What is the daily meal allowance when travelling?", doc: "Handbook", page: 3, expect: /\$?45/ },
  { q: "How long is paid leave for a secondary caregiver?", doc: "Handbook", page: 2, expect: /6|six/i },
  { q: "What does error E04 mean?", doc: "Manual", page: 3, expect: /grinder|portafilter|jam/i },
  { q: "How often should I descale the machine?", doc: "Manual", page: 2, expect: /2 months|two months|300/i },
  { q: "Can I use vinegar to descale?", doc: "Manual", page: 2, expect: /no|not|don't|do not/i },
  { q: "Can I return an opened bag of coffee?", doc: "Returns", expect: /different coffee|can't|cannot|not accept/i },
  { q: "What is the restocking fee for used equipment?", doc: "Returns", expect: /15%/ },
  { q: "How do I extend the warranty to three years?", doc: "Returns|Manual", expect: /regist/i },
  { q: "What is the company's policy on bringing dogs to the office?", doc: "", expect: /couldn't find|could not find|not (mention|cover|contain)|no information|doesn't (mention|say)/i },
];

async function main() {
  const { ingestDocument, listDocuments } = await import("../src/lib/documents");
  const { retrieve } = await import("../src/lib/retrieve");
  const { streamAnswer } = await import("../src/lib/chat");
  const { SAMPLE_WORKSPACE, config } = await import("../src/lib/config");
  const { extractiveAnswer } = await import("../src/lib/extractive");
  console.log(
    config.llm.enabled
      ? `Mode: AI answers (${config.llm.chatModel})\n`
      : "Mode: passages only (no API key)\n",
  );

  const sampleDir = path.join(process.cwd(), "sample-docs");
  for (const f of readdirSync(sampleDir)) {
    await ingestDocument({
      workspace: SAMPLE_WORKSPACE,
      name: f,
      data: new Uint8Array(readFileSync(path.join(sampleDir, f))),
      isSample: true,
    });
  }
  const ids = (await listDocuments("eval-workspace-000000")).map((d) => d.id);

  let retrievalHits = 0;
  let answerHits = 0;
  for (const c of CASES) {
    const { passages } = await retrieve(c.q, ids);
    const docRe = new RegExp(c.doc || "^$");
    const hit =
      !c.doc ||
      passages.some((p) => docRe.test(p.documentName) && (c.page === undefined || p.page === c.page));
    let answer = "";
    if (config.llm.enabled) {
      for await (const chunk of await streamAnswer(c.q, passages, [])) {
        answer += chunk.choices[0]?.delta?.content ?? "";
      }
    } else {
      answer = extractiveAnswer(c.q, passages);
    }
    const cites = /\[\d+\]/.test(answer);
    const ok = c.expect.test(answer) && (cites || !c.doc);
    retrievalHits += hit ? 1 : 0;
    answerHits += ok ? 1 : 0;
    console.log(`${hit ? "✓" : "✗"} retrieval  ${ok ? "✓" : "✗"} answer  ${c.q}`);
    if (!ok) console.log(`    -> ${answer.replace(/\s+/g, " ").slice(0, 220)}`);
  }
  console.log(
    `\nRetrieval: ${retrievalHits}/${CASES.length}   Answers: ${answerHits}/${CASES.length}`,
  );
  return answerHits === CASES.length && retrievalHits === CASES.length;
}

main()
  .then((pass) => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(pass ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
