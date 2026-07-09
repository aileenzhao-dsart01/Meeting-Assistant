/**
 * AppError — an HTTP-error with a status code that the global error-handler
 * middleware picks up and serialises into a JSON response.
 *
 * Throw it from route handlers / services with:
 *   throw new AppError(400, "Title is required");
 *   throw Errors.notFound("Meeting not found");
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  notFound: (msg = "Resource not found") => new AppError(404, msg, "NOT_FOUND"),
  unauthorized: (msg = "Authentication required") => new AppError(401, msg, "UNAUTHORIZED"),
  forbidden: (msg = "Access denied") => new AppError(403, msg, "FORBIDDEN"),
  badRequest: (msg = "Invalid request") => new AppError(400, msg, "BAD_REQUEST"),
  conflict: (msg = "Resource already exists") => new AppError(409, msg, "CONFLICT"),
};
