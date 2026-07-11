import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { config } from "../config";

// ── JWKS cache ─────────────────────────────────────────────────────

let cachedKeys: { [kid: string]: crypto.KeyObject } | null = null;
let lastFetch = 0;
const CACHE_TTL = 600_000; // 10 min

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

async function fetchJwks(): Promise<{ [kid: string]: crypto.KeyObject } | null> {
  const now = Date.now();
  if (cachedKeys && now - lastFetch < CACHE_TTL) return cachedKeys;

  const url = config.supabase.jwksUrl;
  if (!url) {
    console.error("  AUTH: SUPABASE_URL not configured — cannot verify JWTs");
    return null;
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.error(`  AUTH: JWKS fetch returned ${res.status}`);
      return null;
    }
    const body = await res.json() as JwksResponse;
    const keys: { [kid: string]: crypto.KeyObject } = {};
    for (const jwk of body.keys) {
      if (jwk.use === "sig" || !jwk.use) {
        keys[jwk.kid || ""] = jwkToKey(jwk);
      }
    }
    cachedKeys = keys;
    lastFetch = now;
    return keys;
  } catch (err) {
    console.error(`  AUTH: JWKS fetch failed:`, err instanceof Error ? err.message : err);
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

/** Verify a Supabase JWT. Returns null on any failure (never throws). */
async function verifySupabaseJwt(token: string): Promise<SupabaseJwtPayload | null> {
  try {
    const keys = await fetchJwks();
    if (!keys) return null;

    // Decode header to find key ID
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    let kid: string;
    try {
      kid = JSON.parse(Buffer.from(parts[0], "base64").toString("utf-8")).kid || "";
    } catch {
      return null;
    }

    const key = keys[kid];
    if (!key) return null;

    // Build issuer from project ref (or skip check if not available)
    const opts: jwt.VerifyOptions = {
      algorithms: ["RS256", "ES256"] as jwt.Algorithm[],
      clockTolerance: 60,
    };
    if (config.supabase.projectRef) {
      opts.issuer = `https://${config.supabase.projectRef}.supabase.co/auth/v1`;
    }
    opts.audience = "authenticated";

    return jwt.verify(token, key, opts) as SupabaseJwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return null;
    if (err instanceof jwt.JsonWebTokenError) return null;
    console.error("  AUTH: Unexpected JWT error:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Check email verification. Trusts JWT claim first; uses service-role API if available. */
async function isEmailVerified(payload: SupabaseJwtPayload): Promise<boolean> {
  // Fast path: JWT claim already has email_verified
  if (payload.email_verified === true) return true;

  // Fallback: query auth.users via service role API (only if key is available)
  if (config.supabase.serviceRoleKey && payload.sub && config.supabase.url) {
    try {
      const res = await fetch(
        `${config.supabase.url}/auth/v1/admin/users/${payload.sub}`,
        {
          headers: {
            apikey: config.supabase.serviceRoleKey,
            Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
          },
          signal: AbortSignal.timeout(3000),
        },
      );
      if (res.ok) {
        const user = await res.json() as { email_confirmed_at?: string | null };
        return !!user.email_confirmed_at;
      }
    } catch {
      // API call failed — fall through to deny
    }
  }

  // No service role key — trust the JWT claim (no email_verified = let through)
  // This avoids blocking all users when service role key isn't configured locally
  if (!config.supabase.serviceRoleKey) {
    return true;
  }

  return false;
}

// ── Exported middleware ────────────────────────────────────────────

/**
 * requireAuth — verifies the Supabase JWT.
 *
 * Accepts token from:
 *   1. Authorization: Bearer <token> header
 *   2. ?token=<jwt> query param (for mobile <audio> playback)
 *
 * Never crashes — always returns a proper JSON error response.
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
    const verified = await isEmailVerified(payload);
    if (!verified) {
      res.status(403).json({
        error: "email_not_verified",
        message: "Email not verified. Please check your inbox.",
      });
      return;
    }

    req.user = { id: payload.sub, email: payload.email || "" };
    next();
  } catch (err) {
    // Absolute last resort — never 500 for auth
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
