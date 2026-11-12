/** An error whose message is safe to show to the user. */
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Converts any thrown value into a JSON error response without leaking internals. */
export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return Response.json(
    { error: "Something went wrong on our side. Please try again." },
    { status: 500 },
  );
}
