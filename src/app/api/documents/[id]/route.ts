import { deleteDocument, UUID_RE } from "@/lib/documents";
import { AppError, errorResponse } from "@/lib/errors";
import { getWorkspace } from "@/lib/workspace";

export async function DELETE(req: Request, ctx: RouteContext<"/api/documents/[id]">) {
  try {
    const workspace = getWorkspace(req);
    const { id } = await ctx.params;
    if (!UUID_RE.test(id) || !(await deleteDocument(workspace, id))) {
      throw new AppError("Document not found.", 404);
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
