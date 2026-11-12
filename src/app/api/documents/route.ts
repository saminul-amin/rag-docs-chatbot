import { config } from "@/lib/config";
import {
  backfillEmbeddings,
  countUserDocuments,
  deleteExpiredUploads,
  ingestDocument,
  listDocuments,
} from "@/lib/documents";
import { AppError, errorResponse } from "@/lib/errors";
import { limitUpload, pruneRateEvents } from "@/lib/rate-limit";
import { ensureSamples } from "@/lib/samples";
import { getWorkspace } from "@/lib/workspace";

export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const workspace = getWorkspace(req);
    await ensureSamples();
    // If a key was added after documents were indexed, fill in their vectors now.
    await backfillEmbeddings();
    return Response.json({
      documents: await listDocuments(workspace),
      aiEnabled: config.llm.enabled,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const workspace = getWorkspace(req);
    await limitUpload(req);

    // Housekeeping piggybacks on uploads, so the demo needs no cron job.
    await Promise.all([deleteExpiredUploads(), pruneRateEvents()]);

    if ((await countUserDocuments(workspace)) >= config.limits.maxDocumentsPerWorkspace) {
      throw new AppError(
        `This demo holds up to ${config.limits.maxDocumentsPerWorkspace} of your documents at a time. Remove one to add another.`,
        409,
      );
    }

    const form = await req.formData().catch(() => {
      throw new AppError("Expected a file upload.", 400);
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("Expected a file upload.", 400);
    if (file.size === 0) throw new AppError("That file is empty.", 400);
    if (file.size > config.limits.maxFileBytes) {
      throw new AppError(
        `Files can be up to ${Math.round(config.limits.maxFileBytes / 1024 / 1024)} MB in this demo.`,
        413,
      );
    }

    const name = file.name.replace(/[\\/]/g, "_").slice(0, 120) || "document";
    const document = await ingestDocument({
      workspace,
      name,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    return Response.json({ document }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
