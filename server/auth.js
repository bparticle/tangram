import crypto from 'node:crypto';

// A single superuser. The password lives only in the environment; the browser
// never holds it. A successful login sets an HttpOnly cookie whose value is a
// keyed digest derived from the password — unforgeable without knowing it, and
// stateless (no session store to keep in sync across serverless invocations).

const COOKIE = 'tangram_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const dev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

function secret() {
  // SESSION_SECRET lets you rotate every session without changing the password.
  // Falling back to the password keeps single-variable setups working.
  return process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'unset';
}

function sessionToken() {
  return crypto.createHmac('sha256', secret()).update('tangram-admin-v1').digest('hex');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function cookieHeader(value, maxAge) {
  const attributes = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (!dev) attributes.push('Secure');
  return attributes.join('; ');
}

export function isAuthenticated(request) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const value = parseCookies(request.headers.cookie)[COOKIE];
  return Boolean(value) && safeEqual(value, sessionToken());
}

export function requireAdmin(request, response, next) {
  if (isAuthenticated(request)) return next();
  response.status(401).json({ error: 'Authentication required' });
}

export function loginHandler(request, response) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return response.status(500).json({ error: 'Admin password is not configured' });
  const password = request.body?.password;
  if (typeof password !== 'string' || !safeEqual(password, expected)) {
    return response.status(401).json({ error: 'Incorrect password' });
  }
  response.setHeader('Set-Cookie', cookieHeader(sessionToken(), MAX_AGE));
  response.json({ authenticated: true });
}

export function logoutHandler(_request, response) {
  response.setHeader('Set-Cookie', cookieHeader('', 0));
  response.json({ authenticated: false });
}

export function sessionHandler(request, response) {
  response.json({ authenticated: isAuthenticated(request) });
}
