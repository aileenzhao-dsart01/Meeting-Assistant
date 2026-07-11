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

function jwkToKey(jwk: Jwk): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
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
  email_verified?: boolean;
  app_metadata?: { provider?: string; [key: string]: unknown };
  user_metadata?: { [key: string]: unknown };
}

/** Shared verification options — clock skew tolerance for Render's clock. */
const VERIFY_OPTS: jwt.VerifyOptions = {
  algorithms: ["RS256"] as jwt.Algorithm[],
  clockTolerance: 60, // 60s leeway for Render container clock skew
};

/** Extract Bearer token from header (case-insensitive). */
function extractBearerToken(header: string): string | null {
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Verify a Supabase JWT and return the payload, or null if invalid. */
async function verifySupabaseJwt(token: string): Promise<SupabaseJwtPayload | null> {
  try {
    const keys = await fetchJwks();

    // Decode header to find the key ID
    const headerEncoded = token.split(".")[0];
    if (!headerEncoded) return null;

    let kid: string;
    try {
      kid = JSON.parse(Buffer.from(headerEncoded, "base64").toString("utf-8")).kid || "";
    } catch {
      return null;
    }

    const key = keys[kid];
    if (!key) return null;

    const payload = jwt.verify(token, key, {
      ...VERIFY_OPTS,
      issuer: `https://${config.supabase.projectRef}.supabase.co/auth/v1`,
      audience: "authenticated",
    }) as SupabaseJwtPayload;

    return payload;
  } catch {
    return null;
  }
}

/** Check email verification — first from JWT claim, fallback to service-role query. */
async function isEmailVerified(payload: SupabaseJwtPayload): Promise<boolean> {
  // JWT claim check (most common case — Supabase includes this when email confirm is on)
  if (payload.email_verified === true) return true;

  // Fallback: query auth.users using service role key
  if (config.supabase.serviceRoleKey && payload.sub) {
    try {
      const res = await fetch(
        `${config.supabase.url}/auth/v1/admin/users/${payload.sub}`,
        {
          headers: {
            apikey: config.supabase.serviceRoleKey,
            Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
          },
        },
      );
      if (res.ok) {
        const user = await res.json() as { email_confirmed_at?: string | null };
        return !!user.email_confirmed_at;
      }
    } catch {
      // fallback silently — deny if we can't verify
    }
  }

  return false;
}

// ── Exported middleware ────────────────────────────────────────────

/**
 * requireAuth — verifies the Supabase JWT from the Authorization header
 * (or ?token= query param for routes that need it, like audio).
 *
 * On success attaches `req.user = { id, email }`.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Try Authorization header first, then ?token= query param
  let token: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    token = extractBearerToken(authHeader);
  }
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

  const payload = await verifySupabaseJwt(token);
  if (!payload) {
    res.status(401).json({ error: "unauthorized", message: "Invalid or expired token" });
    return;
  }

  // Check email verification
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
  if (!header) {
    next();
    return;
  }

  const token = extractBearerToken(header);
  if (!token) {
    next();
    return;
  }

  const payload = await verifySupabaseJwt(token);
  if (payload) {
    req.user = { id: payload.sub, email: payload.email || "" };
  }
  next();
}
