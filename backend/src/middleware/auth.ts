import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { config } from "../config";

// ── JWKS cache (fetched once, refreshed every 10 min) ──────────────

let cachedKeys: { [kid: string]: crypto.KeyObject } | null = null;
let lastFetch = 0;
const CACHE_TTL = 600_000; // 10 min

interface Jwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface JwksResponse {
  keys: Jwk[];
}

/** Convert a JWK (RSA public key) to a Node crypto.KeyObject. */
function jwkToKey(jwk: Jwk): crypto.KeyObject {
  const der = Buffer.from(
    crypto.createPublicKey({
      key: {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
      },
      format: "jwk",
    }).export({ type: "spki", format: "der" }),
  );
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

async function fetchJwks(): Promise<{ [kid: string]: crypto.KeyObject }> {
  const now = Date.now();
  if (cachedKeys && now - lastFetch < CACHE_TTL) return cachedKeys;

  const url = config.supabase.jwksUrl;
  if (!url) throw new Error("SUPABASE_JWKS_URL is not configured");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);

  const body = (await res.json()) as JwksResponse;
  const keys: { [kid: string]: crypto.KeyObject } = {};
  for (const jwk of body.keys) {
    // Only use signing keys
    if (jwk.use === "sig" || !jwk.use) {
      keys[jwk.kid] = jwkToKey(jwk);
    }
  }

  cachedKeys = keys;
  lastFetch = now;
  return keys;
}

// ── JWT verification ───────────────────────────────────────────────

interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  iat?: number;
  /** Present when email_confirm=true or if the user's email is confirmed */
  email_verified?: boolean;
  app_metadata?: { provider?: string; [key: string]: unknown };
  user_metadata?: { [key: string]: unknown };
}

/**
 * requireAuth — verifies the Supabase JWT from the Authorization header.
 *
 * On success attaches `req.user = { id: sub (Supabase UUID), email }`.
 * On failure sends 401 with the standard error shape.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return;
  }

  const token = header.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return;
  }

  try {
    // Get the JWKS keys
    let keys: { [kid: string]: crypto.KeyObject };
    try {
      keys = await fetchJwks();
    } catch {
      res.status(500).json({ error: "server_error", message: "Failed to fetch auth keys" });
      return;
    }

    // Decode header to find the key ID
    const headerEncoded = token.split(".")[0];
    if (!headerEncoded) {
      res.status(401).json({ error: "unauthorized", message: "Invalid token" });
      return;
    }

    let kid: string;
    try {
      const decodedHeader = JSON.parse(
        Buffer.from(headerEncoded, "base64").toString("utf-8"),
      ) as { kid?: string; alg?: string };
      kid = decodedHeader.kid || "";
    } catch {
      res.status(401).json({ error: "unauthorized", message: "Invalid token header" });
      return;
    }

    const key = keys[kid];
    if (!key) {
      res.status(401).json({ error: "unauthorized", message: "Invalid token key" });
      return;
    }

    // Verify the token
    const payload = jwt.verify(token, key, {
      algorithms: ["RS256"],
      issuer: `https://${config.supabase.projectRef}.supabase.co/auth/v1`,
      audience: "authenticated",
    }) as SupabaseJwtPayload;

    // Check email verification
    if (!payload.email_verified) {
      res.status(403).json({
        error: "email_not_verified",
        message: "Email not verified",
      });
      return;
    }

    req.user = {
      id: payload.sub,
      email: payload.email || "",
    };

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "unauthorized", message: "Token expired" });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: "unauthorized", message: "Invalid token" });
      return;
    }
    res.status(500).json({ error: "server_error", message: "Authentication failed" });
  }
}

/**
 * optionalAuth — attaches `req.user` if a valid Supabase JWT is present,
 * but does NOT reject the request if one is missing.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    next();
    return;
  }

  const token = header.slice(7).trim();
  if (!token) {
    next();
    return;
  }

  try {
    const keys = await fetchJwks();
    const headerEncoded = token.split(".")[0];
    if (!headerEncoded) {
      next();
      return;
    }

    let kid: string;
    try {
      const decodedHeader = JSON.parse(
        Buffer.from(headerEncoded, "base64").toString("utf-8"),
      ) as { kid?: string };
      kid = decodedHeader.kid || "";
    } catch {
      next();
      return;
    }

    const key = keys[kid];
    if (!key) {
      next();
      return;
    }

    const payload = jwt.verify(token, key, {
      algorithms: ["RS256"],
      issuer: `https://${config.supabase.projectRef}.supabase.co/auth/v1`,
      audience: "authenticated",
    }) as SupabaseJwtPayload;

    if (payload.email_verified) {
      req.user = { id: payload.sub, email: payload.email || "" };
    }
  } catch {
    // Silently ignore invalid tokens
  }
  next();
}
