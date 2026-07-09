import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { JwtPayload } from "../types";

/**
 * requireAuth — rejects the request with 401 if no valid Bearer JWT is present.
 * On success it attaches `req.user = { id, email }`.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "Authentication required" });
    return;
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    req.user = { id: decoded.userId, email: decoded.email };
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

/**
 * optionalAuth — attaches `req.user` if a valid Bearer token is present,
 * but does NOT reject the request if one is missing.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    next();
    return;
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    req.user = { id: decoded.userId, email: decoded.email };
  } catch {
    // silently ignore invalid tokens
  }
  next();
}
