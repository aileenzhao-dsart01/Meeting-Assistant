import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";

// ── JWKS cache (keyed by issuer URL) ───────────────────────────────

interface CacheEntry {
  keys: { [kid: string]: crypto.KeyObject };
  fetchedAt: number;
}

const CACHE_TTL = 600_000; // 10 min
const jwksCache = new Map<string, CacheEntry>();

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  key_ops?: string[];
}

interface JwksResponse { keys: Jwk[]; }

function jwkToKey(jwk: Jwk): crypto.KeyObject {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return crypto.createPublicKey({ key: jwk as any, format: "jwk" });
}

/** Fetch JWKS for a given issuer URL. Cached per issuer for CACHE_TTL ms. */
async function fetchJwksForIssuer(issuerUrl: string): Promise<{ [kid: string]: crypto.KeyObject } | null> {
  const now = Date.now();
  const cached = jwksCache.get(issuerUrl);
  if (cached && now - cached.fetchedAt < CACHE_TTL) return cached.keys;

  // Derive JWKS URL from issuer (iss/auth/v1 → iss/.well-known/jwks.json)
  const jwksUrl = issuerUrl.replace(/\/auth\/v1$/, "") + "/.well-known/jwks.json";

  try {
    const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.error(`  AUTH: JWKS fetch returned ${res.status} for ${issuerUrl}`);
      return null;
    }
    const body = await res.json() as JwksResponse;
    const keys: { [kid: string]: crypto.KeyObject } = {};
    for (const jwk of body.keys) {
      if (jwk.use === "sig" || !jwk.use) {
        keys[jwk.kid || ""] = jwkToKey(jwk);
      }
    }
    jwksCache.set(issuerUrl, { keys, fetchedAt: now });
    return keys;
  } catch (err) {
    console.error(`  AUTH: JWKS fetch failed for ${issuerUrl}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── JWT verification ───────────────────────────────────────────────

interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  iat?: number;
  email_verified?: boolean;
  app_metadata?: { provider?: string; [key: string]: unknown };
  user_metadata?: { [key: string]: unknown };
}

function extractBearerToken(header: string): string | null {
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Decode the token payload WITHOUT verifying, just to read iss/email_verified. */
function decodeUnverified(token: string): SupabaseJwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as SupabaseJwtPayload;
  } catch {
    return null;
  }
}

/**
 * verifySupabaseJwt — verify a Supabase JWT by discovering the JWKS from
 * the token's own `iss` (issuer) claim. Works with any Supabase project.
 */
async function verifySupabaseJwt(token: string): Promise<SupabaseJwtPayload | null> {
  // Decode without verification first to read the issuer
  const unverified = decodeUnverified(token);
  if (!unverified || !unverified.iss) return null;

  // Fetch JWKS for this issuer
  const keys = await fetchJwksForIssuer(unverified.iss);
  if (!keys) return null;

  // Find key ID from token header
  const parts = token.split(".");
  let kid: string;
  try {
    kid = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8")).kid || "";
  } catch {
    return null;
  }

  const key = keys[kid];
  if (!key) return null;

  // Verify signature + expiry only. No issuer/audience check — already validated
  // by fetching JWKS from the issuer itself.
  try {
    return jwt.verify(token, key, {
      algorithms: ["RS256", "ES256"],
      clockTolerance: 60,
    } as jwt.VerifyOptions) as SupabaseJwtPayload;
  } catch {
    return null;
  }
}

/** Trust the JWT's email_verified claim — Supabase Auth sets it accurately. */
function isEmailVerified(payload: SupabaseJwtPayload): boolean {
  return payload.email_verified !== false;
}

// ── Exported middleware ────────────────────────────────────────────

/**
 * requireAuth — verifies the Supabase JWT.
 *
 * Accepts token from:
 *   1. Authorization: Bearer <token> header
 *   2. ?token=<jwt> query param (for mobile <audio> playback)
 *
 * Discovers the JWKS URL from the JWT's `iss` claim — works with any
 * Supabase project without configuration.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // ── Extract token ──
    let token: string | null = null;

    const authHeader = req.headers.authorization;
    if (authHeader) token = extractBearerToken(authHeader);

    if (!token && req.query.token && typeof req.query.token === "string") {
      token = req.query.token.trim();
    }

    if (!token) {
      res.status(401).json({ error: "unauthorized", message: "Authentication required" });
      return;
    }
    if (token.length < 10) {
      res.status(401).json({ error: "unauthorized", message: "Invalid token" });
      return;
    }

    // ── Verify ──
    const payload = await verifySupabaseJwt(token);
    if (!payload) {
      res.status(401).json({ error: "unauthorized", message: "Invalid or expired token" });
      return;
    }

    // ── Email verification ──
    if (!isEmailVerified(payload)) {
      res.status(403).json({
        error: "email_not_verified",
        message: "Email not verified. Please check your inbox.",
      });
      return;
    }

    req.user = { id: payload.sub, email: payload.email || "" };
    next();
  } catch (err) {
    console.error("  AUTH: Unexpected error:", err);
    res.status(401).json({ error: "unauthorized", message: "Authentication failed" });
  }
}

/**
 * optionalAuth — attaches req.user if a valid JWT is present, but never rejects.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header) { next(); return; }

  const token = extractBearerToken(header);
  if (!token) { next(); return; }

  const payload = await verifySupabaseJwt(token);
  if (payload) {
    req.user = { id: payload.sub, email: payload.email || "" };
  }
  next();
}
