import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/errors";

/**
 * Global error-handling middleware.
 *
 * Serialises AppError into the standard error shape:
 *   { error: "code_snake_case", message: "Human readable" }
 *
 * Must be registered AFTER all routes (as the last middleware).
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
    });
    return;
  }

  console.error("  Unhandled error:", err);
  res.status(500).json({
    error: "server_error",
    message: "Internal server error",
  });
}
