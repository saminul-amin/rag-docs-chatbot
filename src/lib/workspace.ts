import { SAMPLE_WORKSPACE } from "./config";
import { AppError } from "./errors";

// Each browser gets a random workspace id (kept in localStorage) so visitors only
// see their own uploads. A production build would use real user accounts instead.
const WORKSPACE_RE = /^[a-z0-9-]{16,64}$/;

export function getWorkspace(req: Request): string {
  const id = req.headers.get("x-workspace-id")?.toLowerCase() ?? "";
  if (!WORKSPACE_RE.test(id) || id === SAMPLE_WORKSPACE) {
    throw new AppError("Missing or invalid workspace id.", 400);
  }
  return id;
}
