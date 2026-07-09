import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/errors";

/**
 * Global error-handling middleware.
 *
 * - Catches AppError instances and returns structured JSON with the correct status code.
 * - Catches everything else and returns a generic 500.
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
      success: false,
      error: err.message,
      code: err.code,
    });
    return;
  }

  console.error(" Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: "Internal server error",
  });
}
