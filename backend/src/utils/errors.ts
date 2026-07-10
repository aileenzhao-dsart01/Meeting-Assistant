/**
 * AppError — an HTTP-error with a snake_case code that the global
 * error-handler middleware serialises into the standard error shape:
 *
 *   { error: "not_found", message: "Meeting not found" }
 *
 * Throw it from route handlers / services with:
 *   throw new AppError(400, "Title is required", "validation_error");
 *   throw Errors.notFound("Meeting not found");
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = "server_error",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  notFound: (msg = "Resource not found") => new AppError(404, msg, "not_found"),
  unauthorized: (msg = "Authentication required") => new AppError(401, msg, "unauthorized"),
  forbidden: (msg = "Access denied") => new AppError(403, msg, "forbidden"),
  badRequest: (msg = "Invalid request") => new AppError(400, msg, "validation_error"),
  conflict: (msg = "Resource already exists") => new AppError(409, msg, "conflict"),
  insufficientPermissions: (msg = "Insufficient permissions") =>
    new AppError(403, msg, "insufficient_permissions"),
};
