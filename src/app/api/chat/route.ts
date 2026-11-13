import { standaloneQuestion, streamAnswer, type Turn } from "@/lib/chat";
import { config } from "@/lib/config";
import { allowedDocumentIds } from "@/lib/documents";
import { AppError, errorResponse } from "@/lib/errors";
import { extractiveAnswer } from "@/lib/extractive";
import { limitChat } from "@/lib/rate-limit";
import { retrieve, type Passage } from "@/lib/retrieve";
import { ensureSamples } from "@/lib/samples";
import { getWorkspace } from "@/lib/workspace";

export const maxDuration = 60;

// The response is newline-delimited JSON so the UI can show sources immediately
// and then stream the answer token by token:
//   {"type":"sources","sources":[...]}   {"type":"delta","text":"..."}   {"type":"done",...}
type Event =
  | {
      type: "meta";
      searchQuery: string;
      searchMode: "hybrid" | "keyword";
      answerMode: "ai" | "passages";
      model: string | null;
    }
  | { type: "sources"; sources: Passage[] }
  | { type: "delta"; text: string }
  | { type: "done"; ms: number }
  | { type: "error"; message: string };

function parseBody(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const question = typeof b.question === "string" ? b.question.trim() : "";
  if (!question) throw new AppError("Please type a question.");
  if (question.length > config.limits.maxQuestionChars) {
    throw new AppError(`Questions can be up to ${config.limits.maxQuestionChars} characters.`);
  }
  const documentIds = Array.isArray(b.documentIds)
    ? b.documentIds.filter((x): x is string => typeof x === "string")
    : [];
  const history: Turn[] = Array.isArray(b.history)
    ? b.history
        .filter(
          (t): t is Turn =>
            !!t &&
            typeof t === "object" &&
            ((t as Turn).role === "user" || (t as Turn).role === "assistant") &&
            typeof (t as Turn).content === "string",
        )
        .slice(-6)
    : [];
  return { question, documentIds, history };
}

export async function POST(req: Request) {
  const started = Date.now();
  let input: ReturnType<typeof parseBody>;
  let workspace: string;
  try {
    workspace = getWorkspace(req);
    input = parseBody(await req.json().catch(() => null));
    await limitChat(req);
  } catch (err) {
    return errorResponse(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: Event) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        // A fresh server instance may get a question before it has served the
        // document list, so make sure the samples are there (a no-op after the first call).
        await ensureSamples();
        const ids = await allowedDocumentIds(workspace, input.documentIds);
        if (ids.length === 0) {
          send({ type: "sources", sources: [] });
          send({ type: "delta", text: "Select at least one document on the left, then ask again." });
          send({ type: "done", ms: Date.now() - started });
          return;
        }

        const searchQuery = await standaloneQuestion(input.history, input.question);
        const { passages, mode: searchMode } = await retrieve(searchQuery, ids);

        // Open the AI stream before announcing the answer mode, so that if the
        // provider is unreachable we can still answer with the passages themselves.
        let completion: Awaited<ReturnType<typeof streamAnswer>> | null = null;
        if (config.llm.enabled) {
          try {
            completion = await streamAnswer(input.question, passages, input.history);
          } catch (err) {
            console.warn("[chat] LLM unavailable, answering with passages only:", (err as Error).message);
          }
        }

        send({
          type: "meta",
          searchQuery,
          searchMode,
          answerMode: completion ? "ai" : "passages",
          model: completion ? config.llm.chatModel : null,
        });
        send({ type: "sources", sources: passages });

        if (completion) {
          for await (const chunk of completion) {
            const text = chunk.choices[0]?.delta?.content;
            if (text) send({ type: "delta", text });
          }
        } else {
          send({ type: "delta", text: extractiveAnswer(searchQuery, passages) });
        }
        send({ type: "done", ms: Date.now() - started });
      } catch (err) {
        console.error(err);
        send({
          type: "error",
          message:
            err instanceof AppError
              ? err.message
              : "The AI service didn't respond. Please try again in a moment.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
