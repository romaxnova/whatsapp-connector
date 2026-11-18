/**
 * Browser session cookie helpers. The cookie only carries a random session id;
 * the session itself (email, expiry) lives in the database so it can be revoked.
 */
import type { Request, Response, NextFunction } from 'express';
import type { AuthStore } from './store.js';
import { SESSION_TTL } from './store.js';

export const SESSION_COOKIE = 'gc_session';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = safeDecode(value);
  }
  return out;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function setSessionCookie(res: Response, id: string, secure: boolean): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

export interface SessionInfo {
  id: string;
  email: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionInfo;
  }
}

/** Populates req.session when a valid session cookie is present. Never fails the request. */
export function attachSession(store: AuthStore) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (id) {
      const s = store.getSession(id);
      if (s) req.session = { id, email: s.email };
    }
    next();
  };
}

/**
 * CSRF protection for state-changing browser requests. A POST is accepted when
 * the Origin header is our own origin, or, when a privacy setting makes the
 * browser send `Origin: null` or none at all, when the browser-controlled
 * Sec-Fetch-Site header says the request came from this same site. Anything
 * else, including requests with neither signal, is refused.
 */
export function isSameOriginRequest(headers: Record<string, string | string[] | undefined>, origin: string): boolean {
  const got = headers['origin'];
  if (got === origin) return true;
  if (got !== undefined && got !== 'null') return false;
  return headers['sec-fetch-site'] === 'same-origin';
}

export function requireSameOrigin(origin: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (!isSameOriginRequest(req.headers, origin)) {
      res.status(403).type('text/plain').send('Cross-site request refused. Reload the page and try again.');
      return;
    }
    next();
  };
}
