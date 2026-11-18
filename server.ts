/**
 * ============================================================================
 * EXPRESS BACKEND & SERVER ENTRY POINT (server.ts)
 * ============================================================================
 *
 * Handles:
 * 1. User authentication (Sign up, Login, Persistent sessions, Forgot password)
 * 2. URL shortening & dashboard stats (INR paise precision)
 * 3. Visitor ad flow with IP geolocation (India-only paid views) & anti-skip
 * 4. Creator Wallet, encrypted Bank Account management (unlocks at ₹50)
 * 5. Owner-only Admin Payout Dashboard (/api/admin/*)
 */

import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import fs from 'fs';
import geoip from 'geoip-lite';
import path from 'path';
import { db } from './server/db.ts';
import { resolveVastTag } from './server/vast.ts';
import {
  BANK_UNLOCK_BALANCE_PAISE,
  MINIMUM_PAYOUT_PAISE,
  getNextPaymentWindowInfo,
  getPaisePerVerifiedView,
  isPaidCountry,
} from './src/config/rates.ts';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_COOKIE_NAME = 'linkmint_session';
const ADMIN_COOKIE_NAME = 'linkmint_admin_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Minimum ad watch time enforced on the server
const CONFIGURED_WATCH_SEC = Math.max(2, Number(process.env.MIN_AD_WATCH_SECONDS) || 4);
const MIN_AD_WATCH_MS = CONFIGURED_WATCH_SEC * 1000 - 250;
const MIN_FINAL_DWELL_MS = 0;
const CLICK_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Admin credentials
const ADMIN_EMAIL = 'akr7479505038@gmail.com';
const ADMIN_PASSWORD = 'ad747950';

app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

const BRAND_LOGO_PATH = path.resolve(
  process.cwd(),
  'public/assets/aistudio/IMG-20261118-WA3662_544ab66e.jpg'
);

app.get('/favicon.ico', (_req: Request, res: Response) => {
  if (fs.existsSync(BRAND_LOGO_PATH)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('image/jpeg').sendFile(BRAND_LOGO_PATH);
    return;
  }
  res.status(404).end();
});

app.get('/robots.txt', (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  res
    .type('text/plain')
    .send(
      `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\n\nSitemap: ${origin}/sitemap.xml\n`
    );
});

app.get('/sitemap.xml', (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const today = new Date().toISOString().split('T')[0];
  res
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url>\n` +
        `    <loc>${origin}/</loc>\n` +
        `    <lastmod>${today}</lastmod>\n` +
        `    <changefreq>daily</changefreq>\n` +
        `    <priority>1.0</priority>\n` +
        `  </url>\n` +
        `</urlset>\n`
    );
});

// ----------------------------------------------------------------------------
// ENCRYPTION & SECURITY HELPERS (AES-256-GCM FOR BANK DETAILS)
// ----------------------------------------------------------------------------

function getBankEncryptionKey(): Buffer {
  const rawSecret =
    process.env.BANK_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    'linkmint-dev-bank-encryption-key-change-me';
  return crypto.createHash('sha256').update(rawSecret).digest();
}

function encryptSensitive(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getBankEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSensitive(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) return '';
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getBankEncryptionKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function maskAccountNumber(accountNumberOrLast4: string): string {
  const last4 = accountNumberOrLast4.slice(-4);
  return `XXXXXX${last4}`;
}

function maskUpiId(upiId: string): string {
  const [userPart, domain] = upiId.split('@');
  if (!userPart || !domain) return upiId;
  const visible = userPart.slice(0, Math.min(2, userPart.length));
  return `${visible}***@${domain}`;
}

// ----------------------------------------------------------------------------
// IP GEOLOCATION & REQUEST HELPERS
// ----------------------------------------------------------------------------

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || '';
}

function isPrivateOrLoopbackIp(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, '').trim();
  if (!clean || clean === '::1' || clean === '127.0.0.1' || clean === 'localhost') {
    return true;
  }
  if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)) return true;
  if (clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80:')) return true;
  return false;
}

function detectVisitorCountry(req: Request): string {
  // 1. Check trusted CDN / cloud proxy country headers when present
  const headerCandidates = [
    req.headers['cf-ipcountry'],
    req.headers['x-vercel-ip-country'],
    req.headers['x-appengine-country'],
    req.headers['x-country-code'],
  ];

  for (const val of headerCandidates) {
    if (typeof val === 'string') {
      const code = val.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1') {
        return code;
      }
    }
  }

  // 2. Lookup public IP address in local GeoIP database
  const rawIp = getClientIp(req).replace(/^::ffff:/, '').trim();
  if (rawIp && !isPrivateOrLoopbackIp(rawIp)) {
    const geo = geoip.lookup(rawIp);
    if (geo?.country && /^[A-Z]{2}$/.test(geo.country)) {
      return geo.country.toUpperCase();
    }
    return 'XX';
  }

  // 3. Localhost / private network testing fallback (never overrides public IPs)
  const devFallback = (process.env.DEV_FALLBACK_COUNTRY || 'IN').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(devFallback) ? devFallback : 'XX';
}

function hashValue(raw: string): string {
  const salt = process.env.SESSION_SECRET || 'linkmint-default-salt';
  return crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex');
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidHttpUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function generateShortCode(length = 7): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

// ----------------------------------------------------------------------------
// DB ROW TYPES & AUTH MIDDLEWARE
// ----------------------------------------------------------------------------

interface DbUser {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  google_uid?: string | null;
  pending_balance_paise: number;
  total_earned_paise: number;
  total_paid_paise: number;
  created_at: string;
}

interface DbLink {
  id: number;
  user_id: number;
  code: string;
  original_url: string;
  clicks: number;
  paid_clicks: number;
  earnings_paise: number;
  count_views: number;
  total_link_clicks: number;
  ad_impressions: number;
  ad_started: number;
  ad_completed: number;
  ad_skipped: number;
  ad_failed: number;
  valid_ad_views: number;
  invalid_views: number;
  duplicate_views: number;
  bot_detections: number;
  created_at: string;
}

interface DbAdAttempt {
  id: string;
  session_token: string;
  link_id: number;
  stage: string;
  slot_index: number;
  ad_source: 'vast' | 'video' | 'provider_api' | 'placeholder';
  provider_name: string | null;
  ip_hash: string;
  ua_hash: string;
  required_watch_ms: number;
  impression_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  skipped_at: number | null;
  failed_at: number | null;
  final_status: string;
  rejection_reason: string | null;
  created_at: number;
}

interface DbBankAccount {
  user_id: number;
  account_holder_name: string;
  account_number_encrypted: string;
  account_last4: string;
  ifsc_code: string;
  upi_id_encrypted: string | null;
  updated_at: string;
}

interface DbVisitorSession {
  token: string;
  link_id: number;
  ip_hash: string;
  ua_hash: string;
  country_code: string;
  current_stage: 'intro' | 'page1' | 'page2' | 'page3' | 'final';
  ads_watched_on_page: number;
  stage_started_at: number;
  view_counted: number;
  completed: number;
  created_at: number;
  expires_at: number;
}

interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    name: string;
    email: string;
    createdAt: string;
  };
  adminEmail?: string;
}

function getCandidateTokens(req: Request, cookieName: string, headerName = 'authorization'): string[] {
  const tokens: string[] = [];
  const rawHeader = req.headers[headerName];
  if (typeof rawHeader === 'string' && rawHeader.startsWith('Bearer ')) {
    const bearer = rawHeader.slice(7).trim();
    if (bearer.length > 10) tokens.push(bearer);
  }
  const cookieToken = req.cookies?.[cookieName];
  if (typeof cookieToken === 'string' && cookieToken.length > 10 && !tokens.includes(cookieToken)) {
    tokens.push(cookieToken);
  }
  return tokens;
}

function setAuthCookie(req: Request, res: Response, name: string, token: string, maxAgeMs: number): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    maxAge: maxAgeMs,
    path: '/',
  });
}

function clearAuthCookie(_req: Request, res: Response, name: string): void {
  res.clearCookie(name, { httpOnly: true, sameSite: 'none', secure: true, path: '/' });
  res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
}

function attachUser(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const tokens = getCandidateTokens(req, SESSION_COOKIE_NAME);
  if (tokens.length === 0) {
    next();
    return;
  }

  for (const token of tokens) {
    const row = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.created_at, s.expires_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`
      )
      .get(hashValue(token)) as (DbUser & { expires_at: number }) | undefined;

    if (row && row.expires_at >= Date.now()) {
      req.user = {
        id: row.id,
        name: row.name,
        email: row.email,
        createdAt: row.created_at,
      };
      next();
      return;
    }

    if (row && row.expires_at < Date.now()) {
      db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(hashValue(token));
    }
  }

  next();
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Please log in to continue.' });
    return;
  }
  next();
}

function attachAdmin(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const tokens = getCandidateTokens(req, ADMIN_COOKIE_NAME, 'x-admin-authorization');
  if (tokens.length === 0) {
    next();
    return;
  }

  for (const token of tokens) {
    const row = db
      .prepare('SELECT admin_email, expires_at FROM admin_sessions WHERE token = ?')
      .get(hashValue(token)) as { admin_email: string; expires_at: number } | undefined;

    if (row && row.expires_at >= Date.now()) {
      req.adminEmail = row.admin_email;
      next();
      return;
    }

    if (row && row.expires_at < Date.now()) {
      db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(hashValue(token));
    }
  }

  next();
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.adminEmail) {
    res.status(401).json({ error: 'Admin login required.' });
    return;
  }
  next();
}

interface ClientTelemetry {
  webdriver?: boolean;
  zeroScreen?: boolean;
}

// Multi-layer bot & suspicious traffic detector for visitor and ad-tracking endpoints
function detectSuspiciousSignal(
  req: Request,
  honeypotValue?: unknown,
  clientSignals?: ClientTelemetry
): { reason: string; code: string } | null {
  if (typeof honeypotValue === 'string' && honeypotValue.trim().length > 0) {
    return { reason: 'Automated submission detected.', code: 'honeypot_triggered' };
  }

  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (!ua || ua.length < 10) {
    return {
      reason: 'Browser verification failed. Please open this link in a standard web browser.',
      code: 'missing_ua',
    };
  }

  const botPatterns = [
    'curl/',
    'wget/',
    'python-requests',
    'python-urllib',
    'httpie',
    'postmanruntime',
    'insomnia',
    'headlesschrome',
    'puppeteer',
    'playwright',
    'selenium',
    'phantomjs',
    'googlebot',
    'bingbot',
    'ahrefsbot',
    'semrushbot',
    'scrapy',
    'axios/',
    'node-fetch',
  ];

  if (botPatterns.some((pat) => ua.includes(pat))) {
    return {
      reason: 'Automated traffic is not allowed on short links.',
      code: 'bot_ua',
    };
  }

  if (req.headers['x-linkmint-client'] !== 'web') {
    return { reason: 'Invalid visitor client header.', code: 'invalid_client_header' };
  }

  if (clientSignals?.webdriver === true) {
    return {
      reason: 'Automated browser environment detected.',
      code: 'webdriver_detected',
    };
  }

  if (clientSignals?.zeroScreen === true) {
    return {
      reason: 'Invalid headless viewport detected.',
      code: 'zero_screen_detected',
    };
  }

  return null;
}

function isLikelyBot(
  req: Request,
  honeypotValue?: unknown,
  clientSignals?: ClientTelemetry
): string | null {
  return detectSuspiciousSignal(req, honeypotValue, clientSignals)?.reason ?? null;
}

const visitRateMap = new Map<string, { count: number; resetAt: number }>();

function checkVisitRateLimit(ipHash: string): boolean {
  const now = Date.now();
  const entry = visitRateMap.get(ipHash);
  if (!entry || entry.resetAt < now) {
    visitRateMap.set(ipHash, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 30) {
    return false;
  }
  entry.count += 1;
  return true;
}

app.use(attachUser);
app.use(attachAdmin);

// ----------------------------------------------------------------------------
// 1. AUTHENTICATION ROUTES (LOGIN WITH GOOGLE)
// ----------------------------------------------------------------------------

function loadFirebaseProjectId(): string {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { projectId?: string };
    return (parsed.projectId || '').trim();
  } catch {
    return '';
  }
}

const FIREBASE_PROJECT_ID = loadFirebaseProjectId();
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedGoogleCerts: Record<string, string> = {};
let cachedGoogleCertsExpiresAt = 0;

async function getGoogleCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && cachedGoogleCertsExpiresAt > now && Object.keys(cachedGoogleCerts).length > 0) {
    return cachedGoogleCerts;
  }

  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) {
    throw new Error('Could not fetch Google verification keys.');
  }

  const certs = (await res.json()) as Record<string, string>;
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

  cachedGoogleCerts = certs;
  cachedGoogleCertsExpiresAt = now + Math.max(60, maxAgeSec) * 1000;
  return certs;
}

async function verifyFirebaseIdToken(idToken: string): Promise<{
  uid: string;
  email: string;
  name: string;
}> {
  if (!FIREBASE_PROJECT_ID) {
    throw new Error('Google Sign-In project configuration is missing on the server.');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid Google sign-in token format.');
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Google token algorithm.');
  }

  let certs = await getGoogleCerts(false);
  let cert = certs[header.kid];
  if (!cert) {
    certs = await getGoogleCerts(true);
    cert = certs[header.kid];
  }
  if (!cert) {
    throw new Error('Google signing certificate not found.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const signatureOk = verifier.verify(cert, Buffer.from(sigB64, 'base64url'));
  if (!signatureOk) {
    throw new Error('Invalid Google token signature.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
  if (payload.aud !== FIREBASE_PROJECT_ID || payload.iss !== expectedIssuer) {
    throw new Error('Google token project mismatch.');
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Google sign-in session expired. Please try again.');
  }
  if (payload.iat && payload.iat > nowSec + 300) {
    throw new Error('Google token issue time is invalid.');
  }
  if (!payload.sub || !payload.email || !isValidEmail(payload.email)) {
    throw new Error('Google account email is missing.');
  }
  if (payload.email_verified === false) {
    throw new Error('Please verify your Gmail address with Google first.');
  }

  const email = payload.email.trim().toLowerCase();
  const displayName =
    typeof payload.name === 'string' && payload.name.trim().length >= 2
      ? payload.name.trim().slice(0, 80)
      : email.split('@')[0];

  return {
    uid: payload.sub,
    email,
    name: displayName,
  };
}

app.get('/api/auth/me', (req: AuthenticatedRequest, res: Response) => {
  res.json({ user: req.user || null });
});

app.post('/api/auth/google', async (req: Request, res: Response) => {
  try {
    const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken.trim() : '';
    if (!idToken) {
      res.status(400).json({ error: 'Missing Google sign-in token.' });
      return;
    }

    const verified = await verifyFirebaseIdToken(idToken);
    const nowIso = new Date().toISOString();

    let user = db
      .prepare('SELECT * FROM users WHERE LOWER(email) = ?')
      .get(verified.email) as DbUser | undefined;

    if (!user) {
      const insertResult = db
        .prepare(
          `INSERT INTO users
           (name, email, password_hash, google_uid, pending_balance_paise, total_earned_paise, total_paid_paise, created_at)
           VALUES (?, ?, '', ?, 0, 0, 0, ?)`
        )
        .run(verified.name, verified.email, verified.uid, nowIso);

      const userId = Number(insertResult.lastInsertRowid);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as DbUser;
    } else {
      db.prepare(
        `UPDATE users
         SET google_uid = COALESCE(NULLIF(google_uid, ''), ?),
             name = CASE WHEN TRIM(name) = '' THEN ? ELSE name END
         WHERE id = ?`
      ).run(verified.uid, verified.name, user.id);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as DbUser;
    }

    const rawSessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;

    db.prepare(
      'INSERT INTO auth_sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(hashValue(rawSessionToken), user.id, expiresAt, nowIso);

    setAuthCookie(req, res, SESSION_COOKIE_NAME, rawSessionToken, SESSION_TTL_MS);

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.created_at,
      },
      sessionToken: rawSessionToken,
    });
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Could not verify Google account. Please try again.',
    });
  }
});

app.post('/api/auth/signup', (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Please use Login with Google.' });
});

app.post('/api/auth/login', (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Please use Login with Google.' });
});

app.post('/api/auth/forgot-password', (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Please use Login with Google.' });
});

app.post('/api/auth/reset-password', (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Please use Login with Google.' });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const tokens = getCandidateTokens(req, SESSION_COOKIE_NAME);
  for (const token of tokens) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(hashValue(token));
  }
  clearAuthCookie(req, res, SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// 2. SHORT LINK MANAGEMENT ROUTES (LOGGED-IN USERS)
// ----------------------------------------------------------------------------

const LINK_SELECT_COLUMNS = `
  id, code, original_url, clicks, paid_clicks, earnings_paise, count_views,
  total_link_clicks, ad_impressions, ad_started, ad_completed, ad_skipped,
  ad_failed, valid_ad_views, invalid_views, duplicate_views, bot_detections,
  created_at
`;

function formatShortLink(row: DbLink) {
  return {
    id: row.id,
    code: row.code,
    originalUrl: row.original_url,
    clicks: row.clicks,
    paidClicks: row.paid_clicks,
    earningsPaise: row.earnings_paise,
    countViews: row.count_views !== 0,
    totalLinkClicks: row.total_link_clicks ?? 0,
    adImpressions: row.ad_impressions ?? 0,
    adStarted: row.ad_started ?? 0,
    adCompleted: row.ad_completed ?? 0,
    adSkipped: row.ad_skipped ?? 0,
    adFailed: row.ad_failed ?? 0,
    validAdViews: row.valid_ad_views ?? 0,
    invalidViews: row.invalid_views ?? 0,
    duplicateViews: row.duplicate_views ?? 0,
    botDetections: row.bot_detections ?? 0,
    createdAt: row.created_at,
  };
}

app.get('/api/links', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const userRow = db
    .prepare('SELECT total_earned_paise FROM users WHERE id = ?')
    .get(userId) as { total_earned_paise: number } | undefined;

  const rows = db
    .prepare(
      `SELECT ${LINK_SELECT_COLUMNS}
       FROM links
       WHERE user_id = ?
       ORDER BY id DESC`
    )
    .all(userId) as DbLink[];

  let totalClicks = 0;
  let totalPaidClicks = 0;
  let totalLinkClicks = 0;
  let adImpressions = 0;
  let adStarted = 0;
  let adCompleted = 0;
  let adSkipped = 0;
  let adFailed = 0;
  let validAdViews = 0;
  let invalidViews = 0;
  let duplicateViews = 0;
  let botDetections = 0;

  const links = rows.map((row) => {
    const formatted = formatShortLink(row);
    totalClicks += formatted.clicks;
    totalPaidClicks += formatted.paidClicks;
    totalLinkClicks += formatted.totalLinkClicks;
    adImpressions += formatted.adImpressions;
    adStarted += formatted.adStarted;
    adCompleted += formatted.adCompleted;
    adSkipped += formatted.adSkipped;
    adFailed += formatted.adFailed;
    validAdViews += formatted.validAdViews;
    invalidViews += formatted.invalidViews;
    duplicateViews += formatted.duplicateViews;
    botDetections += formatted.botDetections;
    return formatted;
  });

  res.json({
    totalLinks: links.length,
    totalClicks,
    totalPaidClicks,
    totalEarnedPaise: userRow?.total_earned_paise ?? 0,
    totalLinkClicks,
    adImpressions,
    adStarted,
    adCompleted,
    adSkipped,
    adFailed,
    validAdViews,
    invalidViews,
    duplicateViews,
    botDetections,
    links,
  });
});

app.get('/api/links/:id/analytics', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const linkId = Number(req.params.id);
  if (!Number.isInteger(linkId) || linkId <= 0) {
    res.status(400).json({ error: 'Invalid link ID.' });
    return;
  }

  const row = db
    .prepare(
      `SELECT ${LINK_SELECT_COLUMNS}
       FROM links
       WHERE id = ? AND user_id = ?`
    )
    .get(linkId, req.user!.id) as DbLink | undefined;

  if (!row) {
    res.status(404).json({ error: 'Link not found.' });
    return;
  }

  const recentEvents = db
    .prepare(
      `SELECT id, ad_attempt_id, event_type, ad_source, status, reason, created_at
       FROM ad_events
       WHERE link_id = ?
       ORDER BY id DESC
       LIMIT 50`
    )
    .all(linkId) as Array<{
    id: number;
    ad_attempt_id: string;
    event_type: string;
    ad_source: string;
    status: string;
    reason: string | null;
    created_at: number;
  }>;

  res.json({
    link: formatShortLink(row),
    recentEvents: recentEvents.map((ev) => ({
      id: ev.id,
      adAttemptId: ev.ad_attempt_id,
      eventType: ev.event_type,
      adSource: ev.ad_source,
      status: ev.status,
      reason: ev.reason,
      createdAt: ev.created_at,
    })),
  });
});

app.post('/api/links', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const rawUrl = typeof req.body?.originalUrl === 'string' ? req.body.originalUrl.trim() : '';
  const countViews = req.body?.countViews === false ? 0 : 1;

  if (!isValidHttpUrl(rawUrl)) {
    res.status(400).json({
      error: 'Please enter a valid web link starting with http:// or https://',
    });
    return;
  }

  if (rawUrl.length > 2048) {
    res.status(400).json({ error: 'That URL is too long (maximum 2,048 characters).' });
    return;
  }

  let code = generateShortCode(7);
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = db.prepare('SELECT id FROM links WHERE code = ?').get(code);
    if (!taken) break;
    code = generateShortCode(7);
  }

  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO links (user_id, code, original_url, clicks, paid_clicks, earnings_paise, count_views, created_at)
       VALUES (?, ?, ?, 0, 0, 0, ?, ?)`
    )
    .run(req.user!.id, code, rawUrl, countViews, createdAt);

  const inserted = db
    .prepare(`SELECT ${LINK_SELECT_COLUMNS} FROM links WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as DbLink;

  res.status(201).json({
    link: formatShortLink(inserted),
  });
});

app.patch('/api/links/:id/view-counting', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const linkId = Number(req.params.id);
  if (!Number.isInteger(linkId) || linkId <= 0) {
    res.status(400).json({ error: 'Invalid link ID.' });
    return;
  }

  const countViews = req.body?.countViews === false ? 0 : 1;
  const result = db
    .prepare('UPDATE links SET count_views = ? WHERE id = ? AND user_id = ?')
    .run(countViews, linkId, req.user!.id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Link not found.' });
    return;
  }

  const updated = db
    .prepare(`SELECT ${LINK_SELECT_COLUMNS} FROM links WHERE id = ?`)
    .get(linkId) as DbLink;

  res.json({
    link: formatShortLink(updated),
  });
});

app.delete('/api/links/:id', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const linkId = Number(req.params.id);
  if (!Number.isInteger(linkId) || linkId <= 0) {
    res.status(400).json({ error: 'Invalid link ID.' });
    return;
  }

  const result = db
    .prepare('DELETE FROM links WHERE id = ? AND user_id = ?')
    .run(linkId, req.user!.id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Link not found.' });
    return;
  }

  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// 3. WALLET, PAYOUT HISTORY & ENCRYPTED BANK ACCOUNT ROUTES
// ----------------------------------------------------------------------------

function formatMaskedBank(row: DbBankAccount | undefined) {
  if (!row) return null;
  let maskedUpiId: string | null = null;
  if (row.upi_id_encrypted) {
    const plainUpi = decryptSensitive(row.upi_id_encrypted);
    maskedUpiId = plainUpi ? maskUpiId(plainUpi) : null;
  }
  return {
    accountHolderName: row.account_holder_name,
    maskedAccountNumber: maskAccountNumber(row.account_last4),
    ifscCode: row.ifsc_code,
    hasUpiId: Boolean(row.upi_id_encrypted),
    maskedUpiId,
    updatedAt: row.updated_at,
  };
}

app.get('/api/wallet', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const userRow = db
    .prepare('SELECT pending_balance_paise, total_earned_paise, total_paid_paise FROM users WHERE id = ?')
    .get(userId) as
    | { pending_balance_paise: number; total_earned_paise: number; total_paid_paise: number }
    | undefined;

  const pendingBalancePaise = userRow?.pending_balance_paise ?? 0;
  const totalEarnedPaise = userRow?.total_earned_paise ?? 0;
  const totalPaidPaise = userRow?.total_paid_paise ?? 0;
  const unpaidApprovedPaise = Math.max(0, totalEarnedPaise - totalPaidPaise);
  const payoutProgressPaise = pendingBalancePaise + unpaidApprovedPaise;

  const bankRow = db
    .prepare('SELECT * FROM bank_accounts WHERE user_id = ?')
    .get(userId) as DbBankAccount | undefined;

  const bankUnlocked =
    payoutProgressPaise >= BANK_UNLOCK_BALANCE_PAISE ||
    totalEarnedPaise >= BANK_UNLOCK_BALANCE_PAISE ||
    Boolean(bankRow);

  const paidRows = db
    .prepare(
      `SELECT id, amount_paise, status, window_label, bank_masked, created_at, paid_at
       FROM payouts
       WHERE user_id = ?
       ORDER BY id DESC`
    )
    .all(userId) as Array<{
    id: number;
    amount_paise: number;
    status: string;
    window_label: string;
    bank_masked: string;
    created_at: string;
    paid_at: string | null;
  }>;

  const payouts = paidRows.map((row) => ({
    id: `paid-${row.id}`,
    date: row.paid_at || row.created_at,
    amountPaise: row.amount_paise,
    status: (row.status === 'paid' ? 'Paid' : 'Pending') as 'Pending' | 'Paid',
    windowLabel: row.window_label,
    bankMasked: row.bank_masked,
  }));

  // If the user has reached ₹200+ combined unpaid balance, reflect their pending cycle
  if (payoutProgressPaise >= MINIMUM_PAYOUT_PAISE) {
    const windowInfo = getNextPaymentWindowInfo();
    payouts.unshift({
      id: 'pending-current',
      date: windowInfo.shortLabel,
      amountPaise: payoutProgressPaise,
      status: 'Pending',
      windowLabel: windowInfo.label,
      bankMasked: bankRow ? maskAccountNumber(bankRow.account_last4) : 'Bank not added yet',
    });
  }

  res.json({
    totalEarnedPaise,
    totalPaidPaise,
    pendingBalancePaise,
    minimumPayoutPaise: MINIMUM_PAYOUT_PAISE,
    bankUnlockPaise: BANK_UNLOCK_BALANCE_PAISE,
    bankUnlocked,
    bankAccount: formatMaskedBank(bankRow),
    payouts,
  });
});

app.post('/api/bank', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const userRow = db
      .prepare(
        'SELECT email, pending_balance_paise, total_earned_paise, total_paid_paise FROM users WHERE id = ?'
      )
      .get(userId) as
      | {
          email: string;
          pending_balance_paise: number;
          total_earned_paise: number;
          total_paid_paise: number;
        }
      | undefined;

    if (!userRow) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    const existingBank = db
      .prepare('SELECT * FROM bank_accounts WHERE user_id = ?')
      .get(userId) as DbBankAccount | undefined;

    const payoutProgressPaise =
      userRow.pending_balance_paise + Math.max(0, userRow.total_earned_paise - userRow.total_paid_paise);

    // Enforce ₹50 unlock requirement before adding bank details
    if (
      !existingBank &&
      payoutProgressPaise < BANK_UNLOCK_BALANCE_PAISE &&
      userRow.total_earned_paise < BANK_UNLOCK_BALANCE_PAISE
    ) {
      res.status(403).json({ error: 'Reach ₹50 to add your bank account.' });
      return;
    }

    // Require Google account re-verification when changing an already-saved bank account
    if (existingBank) {
      const googleIdToken =
        typeof req.body?.googleIdToken === 'string' ? req.body.googleIdToken.trim() : '';
      if (!googleIdToken) {
        res.status(400).json({
          error: 'Please confirm your Gmail account with Google to change your bank details.',
        });
        return;
      }
      try {
        const verified = await verifyFirebaseIdToken(googleIdToken);
        if (verified.email !== userRow.email.trim().toLowerCase()) {
          res.status(403).json({
            error: 'Selected Google account does not match your signed-in Gmail.',
          });
          return;
        }
      } catch {
        res.status(403).json({
          error: 'Could not verify your Google account. Bank details were not changed.',
        });
        return;
      }
    }

    const accountHolderName =
      typeof req.body?.accountHolderName === 'string' ? req.body.accountHolderName.trim() : '';
    const accountNumber =
      typeof req.body?.accountNumber === 'string' ? req.body.accountNumber.trim() : '';
    const confirmAccountNumber =
      typeof req.body?.confirmAccountNumber === 'string' ? req.body.confirmAccountNumber.trim() : '';
    const ifscCode =
      typeof req.body?.ifscCode === 'string' ? req.body.ifscCode.trim().toUpperCase() : '';
    const upiId = typeof req.body?.upiId === 'string' ? req.body.upiId.trim() : '';

    if (accountHolderName.length < 2 || accountHolderName.length > 100) {
      res.status(400).json({ error: 'Please enter the account holder name (2 to 100 characters).' });
      return;
    }
    if (!/^\d{9,18}$/.test(accountNumber)) {
      res.status(400).json({
        error: 'Account number must contain digits only (9 to 18 digits).',
      });
      return;
    }
    if (accountNumber !== confirmAccountNumber) {
      res.status(400).json({ error: 'Account numbers do not match.' });
      return;
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
      res.status(400).json({
        error: 'Please enter a valid 11-character IFSC code (example: SBIN0001234).',
      });
      return;
    }
    if (upiId && !/^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/.test(upiId)) {
      res.status(400).json({
        error: 'Please enter a valid UPI ID (example: name@bank) or leave it blank.',
      });
      return;
    }

    const encryptedAccount = encryptSensitive(accountNumber);
    const encryptedUpi = upiId ? encryptSensitive(upiId) : null;
    const last4 = accountNumber.slice(-4);
    const updatedAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO bank_accounts
       (user_id, account_holder_name, account_number_encrypted, account_last4, ifsc_code, upi_id_encrypted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         account_holder_name = excluded.account_holder_name,
         account_number_encrypted = excluded.account_number_encrypted,
         account_last4 = excluded.account_last4,
         ifsc_code = excluded.ifsc_code,
         upi_id_encrypted = excluded.upi_id_encrypted,
         updated_at = excluded.updated_at`
    ).run(userId, accountHolderName, encryptedAccount, last4, ifscCode, encryptedUpi, updatedAt);

    const savedRow = db
      .prepare('SELECT * FROM bank_accounts WHERE user_id = ?')
      .get(userId) as DbBankAccount;

    res.json({ bankAccount: formatMaskedBank(savedRow) });
  } catch {
    res.status(500).json({ error: 'Could not save bank details. Please try again.' });
  }
});

// ----------------------------------------------------------------------------
// 4. VISITOR FLOW ROUTES (ONE-TIME TOKEN, WATCH TIME, INDIA-ONLY EARNING)
// ----------------------------------------------------------------------------

function formatVisitorState(session: DbVisitorSession, code: string) {
  let pageNumber = 0;
  if (session.current_stage === 'page1') pageNumber = 1;
  if (session.current_stage === 'page2') pageNumber = 2;
  if (session.current_stage === 'page3') pageNumber = 3;
  if (session.current_stage === 'final') pageNumber = 4;

  return {
    sessionToken: session.token,
    code,
    stage: session.current_stage,
    pageNumber,
    adsWatchedOnPage: session.ads_watched_on_page,
    totalPages: 3,
    adsPerPage: 3,
    minWatchSeconds: CONFIGURED_WATCH_SEC,
    viewCounted: session.view_counted === 1,
    canProceedToNextPage:
      (session.current_stage === 'page1' ||
        session.current_stage === 'page2' ||
        session.current_stage === 'page3') &&
      session.ads_watched_on_page >= 3,
  };
}

/**
 * Credits 1 View (+ ₹0.20 to pending balance for verified India traffic)
 * immediately once all ads are watched, guarded by `view_counted = 0`.
 */
function creditCompletedAdsView(session: DbVisitorSession): {
  countedView: boolean;
  countedEarning: boolean;
} {
  const now = Date.now();
  const countryPaid = isPaidCountry(session.country_code);
  const earnPaise = getPaisePerVerifiedView(session.country_code);

  const tx = db.transaction((): { countedView: boolean; countedEarning: boolean } => {
    const markCounted = db
      .prepare('UPDATE visitor_sessions SET view_counted = 1 WHERE token = ? AND view_counted = 0')
      .run(session.token);

    if (markCounted.changes === 0) {
      return { countedView: false, countedEarning: false };
    }

    const link = db.prepare('SELECT id, user_id, count_views FROM links WHERE id = ?').get(session.link_id) as
      | { id: number; user_id: number; count_views: number }
      | undefined;

    if (!link) {
      return { countedView: false, countedEarning: false };
    }

    // Count 1 View immediately once all ads have been watched
    db.prepare('UPDATE links SET clicks = clicks + 1 WHERE id = ?').run(link.id);

    if (!countryPaid || earnPaise <= 0) {
      return { countedView: true, countedEarning: false };
    }

    db.prepare(
      'INSERT INTO verified_clicks (link_id, ip_hash, country_code, earned_paise, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(link.id, session.ip_hash, session.country_code, earnPaise, now);

    db.prepare(
      'UPDATE links SET paid_clicks = paid_clicks + 1, earnings_paise = earnings_paise + ? WHERE id = ?'
    ).run(earnPaise, link.id);

    // Adds ₹0.20 ONLY to creator's pending balance; total_earned_paise updates when approved by admin
    db.prepare('UPDATE users SET pending_balance_paise = pending_balance_paise + ? WHERE id = ?').run(
      earnPaise,
      link.user_id
    );

    return { countedView: true, countedEarning: true };
  });

  return tx();
}

app.post('/api/vast/resolve', async (req: Request, res: Response) => {
  const botReason = isLikelyBot(req, req.body?.website, req.body?.clientSignals);
  if (botReason) {
    res.status(403).json({ error: botReason });
    return;
  }

  const vastTagUrl = typeof req.body?.vastTagUrl === 'string' ? req.body.vastTagUrl.trim() : '';
  if (!vastTagUrl || !isValidHttpUrl(vastTagUrl)) {
    res.status(400).json({ error: 'Invalid VAST tag URL.' });
    return;
  }

  try {
    const resolved = await resolveVastTag(vastTagUrl);
    res.json(resolved);
  } catch {
    res.status(502).json({ error: 'Could not reach VAST ad server.' });
  }
});

app.post('/api/visit/start', (req: Request, res: Response) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code) {
    res.status(400).json({ error: 'Missing short link code.' });
    return;
  }

  const link = db.prepare('SELECT id, code FROM links WHERE code = ?').get(code) as
    | { id: number; code: string }
    | undefined;

  if (!link) {
    res.status(404).json({ error: 'This short link does not exist or was removed.' });
    return;
  }

  const ipHash = hashValue(getClientIp(req));
  const now = Date.now();

  // Always record Total Link Click (a link click does NOT count as an ad view)
  db.prepare('UPDATE links SET total_link_clicks = total_link_clicks + 1 WHERE id = ?').run(link.id);

  const suspicious = detectSuspiciousSignal(req, req.body?.website, req.body?.clientSignals);
  if (suspicious) {
    const attemptId = `bot-${crypto.randomBytes(12).toString('hex')}`;
    db.prepare(
      'UPDATE links SET invalid_views = invalid_views + 1, bot_detections = bot_detections + 1 WHERE id = ?'
    ).run(link.id);
    db.prepare(
      `INSERT INTO ad_events (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
       VALUES (?, ?, 'blocked-start', 'invalid', 'vast', 'rejected', ?, ?, ?)`
    ).run(attemptId, link.id, suspicious.code, ipHash, now);
    res.status(403).json({ error: suspicious.reason });
    return;
  }

  if (!checkVisitRateLimit(ipHash)) {
    const attemptId = `rate-${crypto.randomBytes(12).toString('hex')}`;
    db.prepare(
      'UPDATE links SET invalid_views = invalid_views + 1, bot_detections = bot_detections + 1 WHERE id = ?'
    ).run(link.id);
    db.prepare(
      `INSERT INTO ad_events (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
       VALUES (?, ?, 'rate-limit', 'invalid', 'vast', 'rejected', 'rate_limit_exceeded', ?, ?)`
    ).run(attemptId, link.id, ipHash, now);
    res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  const uaHash = hashValue(req.headers['user-agent'] || 'unknown');
  const countryCode = detectVisitorCountry(req);

  const session: DbVisitorSession = {
    token,
    link_id: link.id,
    ip_hash: ipHash,
    ua_hash: uaHash,
    country_code: countryCode,
    current_stage: 'intro',
    ads_watched_on_page: 0,
    stage_started_at: now,
    view_counted: 0,
    completed: 0,
    created_at: now,
    expires_at: now + 30 * 60 * 1000,
  };

  db.prepare(
    `INSERT INTO visitor_sessions
     (token, link_id, ip_hash, ua_hash, country_code, current_stage, ads_watched_on_page, stage_started_at, view_counted, completed, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.token,
    session.link_id,
    session.ip_hash,
    session.ua_hash,
    session.country_code,
    session.current_stage,
    session.ads_watched_on_page,
    session.stage_started_at,
    session.view_counted,
    session.completed,
    session.created_at,
    session.expires_at
  );

  res.json(formatVisitorState(session, link.code));
});

app.post('/api/visit/ad-attempt', (req: Request, res: Response) => {
  const token = typeof req.body?.sessionToken === 'string' ? req.body.sessionToken.trim() : '';
  const session = db
    .prepare('SELECT * FROM visitor_sessions WHERE token = ?')
    .get(token) as DbVisitorSession | undefined;

  if (!session || session.completed === 1 || session.expires_at < Date.now()) {
    res.status(400).json({ error: 'This link session expired. Please refresh the page.' });
    return;
  }

  const suspicious = detectSuspiciousSignal(req, req.body?.website, req.body?.clientSignals);
  if (suspicious) {
    const attemptId = `bot-${crypto.randomBytes(12).toString('hex')}`;
    db.prepare(
      'UPDATE links SET invalid_views = invalid_views + 1, bot_detections = bot_detections + 1 WHERE id = ?'
    ).run(session.link_id);
    db.prepare(
      `INSERT INTO ad_events (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
       VALUES (?, ?, ?, 'invalid', 'vast', 'rejected', ?, ?, ?)`
    ).run(attemptId, session.link_id, session.token, suspicious.code, session.ip_hash, Date.now());
    res.status(403).json({ error: suspicious.reason });
    return;
  }

  const uaHash = hashValue(req.headers['user-agent'] || 'unknown');
  if (uaHash !== session.ua_hash) {
    res.status(403).json({ error: 'Session verification mismatch.' });
    return;
  }

  const rawSource = typeof req.body?.adSource === 'string' ? req.body.adSource : 'placeholder';
  const adSource: DbAdAttempt['ad_source'] =
    rawSource === 'vast' || rawSource === 'video' || rawSource === 'provider_api'
      ? rawSource
      : 'placeholder';
  const providerName =
    typeof req.body?.providerName === 'string' ? req.body.providerName.trim().slice(0, 60) : null;
  const stage = session.current_stage;
  const slotIndex = stage === 'intro' ? 0 : session.ads_watched_on_page + 1;
  const now = Date.now();
  const attemptId = crypto.randomBytes(16).toString('hex');

  db.prepare(
    `INSERT INTO ad_attempts
     (id, session_token, link_id, stage, slot_index, ad_source, provider_name, ip_hash, ua_hash, required_watch_ms, final_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    attemptId,
    session.token,
    session.link_id,
    stage,
    slotIndex,
    adSource,
    providerName,
    session.ip_hash,
    session.ua_hash,
    MIN_AD_WATCH_MS,
    adSource === 'placeholder' ? 'placeholder' : 'pending',
    now
  );

  res.json({
    adAttemptId: attemptId,
    adSource,
    requiredWatchSeconds: CONFIGURED_WATCH_SEC,
  });
});

app.post('/api/visit/ad-event', (req: Request, res: Response) => {
  const token = typeof req.body?.sessionToken === 'string' ? req.body.sessionToken.trim() : '';
  const adAttemptId = typeof req.body?.adAttemptId === 'string' ? req.body.adAttemptId.trim() : '';
  const eventType = typeof req.body?.eventType === 'string' ? req.body.eventType.trim() : '';

  const allowedEvents = new Set([
    'impression',
    'start',
    'firstQuartile',
    'midpoint',
    'thirdQuartile',
    'complete',
    'skip',
    'fail',
  ]);

  if (!token || !adAttemptId || !allowedEvents.has(eventType)) {
    res.status(400).json({ error: 'Invalid advertisement event payload.' });
    return;
  }

  const session = db
    .prepare('SELECT * FROM visitor_sessions WHERE token = ?')
    .get(token) as DbVisitorSession | undefined;

  if (!session || session.completed === 1 || session.expires_at < Date.now()) {
    res.status(400).json({ error: 'Visitor session expired.' });
    return;
  }

  const attempt = db
    .prepare('SELECT * FROM ad_attempts WHERE id = ? AND session_token = ?')
    .get(adAttemptId, token) as DbAdAttempt | undefined;

  if (!attempt) {
    res.status(404).json({ error: 'Advertisement attempt not found.' });
    return;
  }

  const now = Date.now();
  const uaHash = hashValue(req.headers['user-agent'] || 'unknown');
  const suspicious = detectSuspiciousSignal(req, req.body?.website, req.body?.clientSignals);

  const txResult = db.transaction((): {
    statusCode: number;
    recorded: boolean;
    duplicateEvent?: boolean;
    validView?: boolean;
    invalidReason?: string;
    ignoredPlaceholder?: boolean;
    error?: string;
  } => {
    // 1. Check bot / UA mismatch / suspicious signals
    if (suspicious || uaHash !== attempt.ua_hash) {
      const reason = suspicious ? suspicious.code : 'ua_mismatch';
      db.prepare(
        'UPDATE links SET invalid_views = invalid_views + 1, bot_detections = bot_detections + 1 WHERE id = ?'
      ).run(attempt.link_id);
      db.prepare(
        "UPDATE ad_attempts SET final_status = 'invalid', rejection_reason = ? WHERE id = ? AND final_status = 'pending'"
      ).run(reason, attempt.id);
      db.prepare(
        `INSERT OR IGNORE INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, 'invalid', ?, 'rejected', ?, ?, ?)`
      ).run(attempt.id, attempt.link_id, token, attempt.ad_source, reason, attempt.ip_hash, now);
      return {
        statusCode: 403,
        recorded: false,
        invalidReason: reason,
        error: suspicious?.reason || 'Session verification mismatch.',
      };
    }

    // 2. Placeholder guard: NEVER generate fake impressions or fake views when no real ad provider is active
    if (attempt.ad_source === 'placeholder') {
      if (eventType === 'impression') {
        db.prepare('UPDATE ad_attempts SET impression_at = COALESCE(impression_at, ?) WHERE id = ?').run(
          now,
          attempt.id
        );
      } else if (eventType === 'start') {
        db.prepare('UPDATE ad_attempts SET started_at = COALESCE(started_at, ?) WHERE id = ?').run(
          now,
          attempt.id
        );
      } else if (eventType === 'complete') {
        db.prepare('UPDATE ad_attempts SET completed_at = COALESCE(completed_at, ?) WHERE id = ?').run(
          now,
          attempt.id
        );
      }
      return { statusCode: 200, recorded: false, ignoredPlaceholder: true };
    }

    // 3. Prevent duplicate event counting via unique (ad_attempt_id, event_type) check
    const alreadyRecorded = db
      .prepare('SELECT id FROM ad_events WHERE ad_attempt_id = ? AND event_type = ?')
      .get(attempt.id, eventType);
    if (alreadyRecorded) {
      return { statusCode: 200, recorded: false, duplicateEvent: true };
    }

    // 4. Verify strict event sequence & timing per event type
    if (eventType === 'impression') {
      if (attempt.final_status !== 'pending') {
        return { statusCode: 400, recorded: false, error: 'Ad attempt already finalized.' };
      }
      db.prepare('UPDATE ad_attempts SET impression_at = ? WHERE id = ?').run(now, attempt.id);
      db.prepare('UPDATE links SET ad_impressions = ad_impressions + 1 WHERE id = ?').run(
        attempt.link_id
      );
      db.prepare(
        `INSERT INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, 'impression', ?, 'accepted', NULL, ?, ?)`
      ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);
      return { statusCode: 200, recorded: true };
    }

    if (eventType === 'start') {
      if (attempt.final_status !== 'pending') {
        return { statusCode: 400, recorded: false, error: 'Ad attempt already finalized.' };
      }
      if (!attempt.impression_at) {
        db.prepare('UPDATE links SET invalid_views = invalid_views + 1 WHERE id = ?').run(
          attempt.link_id
        );
        db.prepare(
          `INSERT INTO ad_events
           (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
           VALUES (?, ?, ?, 'start', ?, 'rejected', 'missing_impression_event', ?, ?)`
        ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);
        return {
          statusCode: 400,
          recorded: false,
          invalidReason: 'missing_impression_event',
          error: 'Ad impression must occur before start.',
        };
      }
      db.prepare('UPDATE ad_attempts SET started_at = ? WHERE id = ?').run(now, attempt.id);
      db.prepare('UPDATE links SET ad_started = ad_started + 1 WHERE id = ?').run(attempt.link_id);
      db.prepare(
        `INSERT INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, 'start', ?, 'accepted', NULL, ?, ?)`
      ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);
      return { statusCode: 200, recorded: true };
    }

    if (
      eventType === 'firstQuartile' ||
      eventType === 'midpoint' ||
      eventType === 'thirdQuartile'
    ) {
      if (!attempt.started_at || attempt.final_status !== 'pending') {
        return { statusCode: 400, recorded: false, error: 'Ad must start before quartiles.' };
      }
      db.prepare(
        `INSERT INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, ?, ?, 'accepted', NULL, ?, ?)`
      ).run(attempt.id, attempt.link_id, token, eventType, attempt.ad_source, attempt.ip_hash, now);
      return { statusCode: 200, recorded: true };
    }

    if (eventType === 'skip') {
      if (attempt.final_status !== 'pending') {
        return { statusCode: 400, recorded: false, error: 'Ad attempt already finalized.' };
      }
      db.prepare(
        "UPDATE ad_attempts SET skipped_at = ?, final_status = 'skipped' WHERE id = ?"
      ).run(now, attempt.id);
      db.prepare('UPDATE links SET ad_skipped = ad_skipped + 1 WHERE id = ?').run(attempt.link_id);
      db.prepare(
        `INSERT INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, 'skip', ?, 'accepted', 'user_skipped_ad', ?, ?)`
      ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);
      return { statusCode: 200, recorded: true, validView: false };
    }

    if (eventType === 'fail') {
      if (attempt.final_status !== 'pending') {
        return { statusCode: 400, recorded: false, error: 'Ad attempt already finalized.' };
      }
      db.prepare(
        "UPDATE ad_attempts SET failed_at = ?, final_status = 'failed' WHERE id = ?"
      ).run(now, attempt.id);
      db.prepare('UPDATE links SET ad_failed = ad_failed + 1 WHERE id = ?').run(attempt.link_id);
      db.prepare(
        `INSERT INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, 'fail', ?, 'accepted', 'ad_playback_or_vast_failed', ?, ?)`
      ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);
      return { statusCode: 200, recorded: true, validView: false };
    }

    // eventType === 'complete'
    if (attempt.final_status !== 'pending') {
      return { statusCode: 400, recorded: false, error: 'Ad attempt already finalized.' };
    }

    if (!attempt.impression_at || !attempt.started_at) {
      db.prepare(
        'UPDATE links SET invalid_views = invalid_views + 1, bot_detections = bot_detections + 1 WHERE id = ?'
      ).run(attempt.link_id);
      db.prepare(
        "UPDATE ad_attempts SET final_status = 'invalid', rejection_reason = 'missing_start_event' WHERE id = ?"
      ).run(attempt.id);
      db.prepare(
        `INSERT INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, 'complete', ?, 'rejected', 'missing_start_event', ?, ?)`
      ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);
      return {
        statusCode: 400,
        recorded: false,
        invalidReason: 'missing_start_event',
        error: 'Cannot complete ad without impression and start events.',
      };
    }

    const watchElapsedMs = now - attempt.started_at;
    if (watchElapsedMs < attempt.required_watch_ms) {
      db.prepare(
        'UPDATE links SET invalid_views = invalid_views + 1, bot_detections = bot_detections + 1 WHERE id = ?'
      ).run(attempt.link_id);
      db.prepare(
        "UPDATE ad_attempts SET final_status = 'invalid', rejection_reason = 'timing_too_fast' WHERE id = ?"
      ).run(attempt.id);
      db.prepare(
        `INSERT INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, 'complete', ?, 'rejected', 'timing_too_fast', ?, ?)`
      ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);
      return {
        statusCode: 400,
        recorded: false,
        invalidReason: 'timing_too_fast',
        error: 'Ad completion time failed server verification.',
      };
    }

    // Genuine playback completion reached
    db.prepare('UPDATE links SET ad_completed = ad_completed + 1 WHERE id = ?').run(attempt.link_id);

    // Check 24h duplicate view for same (link_id, ip_hash, stage, slot_index)
    const dupCutoff = now - CLICK_DEDUP_WINDOW_MS;
    const recentValid = db
      .prepare(
        `SELECT id FROM valid_ad_views_log
         WHERE link_id = ? AND ip_hash = ? AND stage = ? AND slot_index = ? AND created_at > ?
         LIMIT 1`
      )
      .get(attempt.link_id, attempt.ip_hash, attempt.stage, attempt.slot_index, dupCutoff);

    if (recentValid) {
      db.prepare(
        'UPDATE links SET duplicate_views = duplicate_views + 1, invalid_views = invalid_views + 1 WHERE id = ?'
      ).run(attempt.link_id);
      db.prepare(
        "UPDATE ad_attempts SET completed_at = ?, final_status = 'invalid', rejection_reason = 'duplicate_view' WHERE id = ?"
      ).run(now, attempt.id);
      db.prepare(
        `INSERT INTO ad_events
         (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
         VALUES (?, ?, ?, 'complete', ?, 'rejected', 'duplicate_view', ?, ?)`
      ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);
      return {
        statusCode: 200,
        recorded: true,
        validView: false,
        invalidReason: 'duplicate_view',
      };
    }

    // Record valid ad view
    db.prepare(
      `INSERT INTO valid_ad_views_log
       (link_id, ad_attempt_id, ip_hash, ua_hash, stage, slot_index, ad_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      attempt.link_id,
      attempt.id,
      attempt.ip_hash,
      attempt.ua_hash,
      attempt.stage,
      attempt.slot_index,
      attempt.ad_source,
      now
    );

    db.prepare('UPDATE links SET valid_ad_views = valid_ad_views + 1 WHERE id = ?').run(
      attempt.link_id
    );
    db.prepare(
      "UPDATE ad_attempts SET completed_at = ?, final_status = 'valid' WHERE id = ?"
    ).run(now, attempt.id);
    db.prepare(
      `INSERT INTO ad_events
       (ad_attempt_id, link_id, session_token, event_type, ad_source, status, reason, ip_hash, created_at)
       VALUES (?, ?, ?, 'complete', ?, 'accepted', NULL, ?, ?)`
    ).run(attempt.id, attempt.link_id, token, attempt.ad_source, attempt.ip_hash, now);

    return { statusCode: 200, recorded: true, validView: true };
  });

  const outcome = txResult();
  if (outcome.error) {
    res.status(outcome.statusCode).json(outcome);
    return;
  }
  res.json(outcome);
});

app.post('/api/visit/complete-ad', (req: Request, res: Response) => {
  const botReason = isLikelyBot(req, req.body?.website, req.body?.clientSignals);
  if (botReason) {
    res.status(403).json({ error: botReason });
    return;
  }

  const token = typeof req.body?.sessionToken === 'string' ? req.body.sessionToken.trim() : '';
  const adAttemptId = typeof req.body?.adAttemptId === 'string' ? req.body.adAttemptId.trim() : '';
  if (!token) {
    res.status(400).json({ error: 'Missing visitor session token.' });
    return;
  }

  const session = db
    .prepare('SELECT * FROM visitor_sessions WHERE token = ?')
    .get(token) as DbVisitorSession | undefined;

  if (!session || session.completed === 1 || session.expires_at < Date.now()) {
    res.status(400).json({ error: 'This link session expired. Please refresh the page.' });
    return;
  }

  const uaHash = hashValue(req.headers['user-agent'] || 'unknown');
  if (uaHash !== session.ua_hash) {
    res.status(403).json({ error: 'Session verification mismatch.' });
    return;
  }

  const attempt = adAttemptId
    ? (db
        .prepare('SELECT * FROM ad_attempts WHERE id = ? AND session_token = ?')
        .get(adAttemptId, token) as DbAdAttempt | undefined)
    : undefined;

  const isFailedOrSkippedRealAd =
    attempt && (attempt.final_status === 'failed' || attempt.final_status === 'skipped');

  const elapsed = Date.now() - session.stage_started_at;
  if (!isFailedOrSkippedRealAd && elapsed < MIN_AD_WATCH_MS) {
    res.status(400).json({
      error: 'Please finish watching the ad before continuing.',
      remainingMs: MIN_AD_WATCH_MS - elapsed,
    });
    return;
  }

  let nextStage = session.current_stage;
  let nextAdsWatched = session.ads_watched_on_page;

  if (session.current_stage === 'intro') {
    nextStage = 'page1';
    nextAdsWatched = 0;
  } else if (
    session.current_stage === 'page1' ||
    session.current_stage === 'page2' ||
    session.current_stage === 'page3'
  ) {
    if (session.ads_watched_on_page >= 3) {
      res.status(400).json({ error: 'All ads on this page are complete. Click Next Page.' });
      return;
    }
    nextAdsWatched = session.ads_watched_on_page + 1;
  } else {
    res.status(400).json({ error: 'All video ads are already completed.' });
    return;
  }

  const now = Date.now();
  db.prepare(
    `UPDATE visitor_sessions
     SET current_stage = ?, ads_watched_on_page = ?, stage_started_at = ?
     WHERE token = ?`
  ).run(nextStage, nextAdsWatched, now, token);

  let viewCounted = session.view_counted;
  // As soon as all ads on the final ad page (Page 3, Ad 3) are watched, count the view & credit ₹0.20 immediately
  if (session.current_stage === 'page3' && nextAdsWatched === 3 && session.view_counted === 0) {
    const credit = creditCompletedAdsView(session);
    if (credit.countedView) {
      viewCounted = 1;
    }
  }

  const link = db.prepare('SELECT code FROM links WHERE id = ?').get(session.link_id) as {
    code: string;
  };

  const updated: DbVisitorSession = {
    ...session,
    current_stage: nextStage,
    ads_watched_on_page: nextAdsWatched,
    stage_started_at: now,
    view_counted: viewCounted,
  };

  res.json(formatVisitorState(updated, link.code));
});

app.post('/api/visit/next-page', (req: Request, res: Response) => {
  const botReason = isLikelyBot(req, req.body?.website);
  if (botReason) {
    res.status(403).json({ error: botReason });
    return;
  }

  const token = typeof req.body?.sessionToken === 'string' ? req.body.sessionToken.trim() : '';
  const session = db
    .prepare('SELECT * FROM visitor_sessions WHERE token = ?')
    .get(token) as DbVisitorSession | undefined;

  if (!session || session.completed === 1 || session.expires_at < Date.now()) {
    res.status(400).json({ error: 'This link session expired. Please refresh the page.' });
    return;
  }

  if (session.ads_watched_on_page < 3) {
    res.status(400).json({
      error: 'Please watch all 3 ads on this page before moving to the next page.',
    });
    return;
  }

  let nextStage: DbVisitorSession['current_stage'] = session.current_stage;
  if (session.current_stage === 'page1') nextStage = 'page2';
  else if (session.current_stage === 'page2') nextStage = 'page3';
  else if (session.current_stage === 'page3') nextStage = 'final';
  else {
    res.status(400).json({ error: 'Cannot advance from the current stage.' });
    return;
  }

  const now = Date.now();
  db.prepare(
    `UPDATE visitor_sessions
     SET current_stage = ?, ads_watched_on_page = 0, stage_started_at = ?
     WHERE token = ?`
  ).run(nextStage, now, token);

  let viewCounted = session.view_counted;
  if (nextStage === 'final' && session.view_counted === 0) {
    const credit = creditCompletedAdsView(session);
    if (credit.countedView) {
      viewCounted = 1;
    }
  }

  const link = db.prepare('SELECT code FROM links WHERE id = ?').get(session.link_id) as {
    code: string;
  };

  const updated: DbVisitorSession = {
    ...session,
    current_stage: nextStage,
    ads_watched_on_page: 0,
    stage_started_at: now,
    view_counted: viewCounted,
  };

  res.json(formatVisitorState(updated, link.code));
});

app.post('/api/visit/get-link', (req: Request, res: Response) => {
  const botReason = isLikelyBot(req, req.body?.website);
  if (botReason) {
    res.status(403).json({ error: botReason });
    return;
  }

  const token = typeof req.body?.sessionToken === 'string' ? req.body.sessionToken.trim() : '';
  const session = db
    .prepare('SELECT * FROM visitor_sessions WHERE token = ?')
    .get(token) as DbVisitorSession | undefined;

  if (!session || session.completed === 1 || session.expires_at < Date.now()) {
    res.status(400).json({ error: 'This link session has already been used or expired.' });
    return;
  }

  if (session.current_stage !== 'final') {
    res.status(400).json({ error: 'Please complete all 3 pages before getting the link.' });
    return;
  }

  const dwellMs = Date.now() - session.stage_started_at;
  if (dwellMs < MIN_FINAL_DWELL_MS) {
    res.status(400).json({ error: 'Almost ready — please click Get Link again.' });
    return;
  }

  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(session.link_id) as
    | DbLink
    | undefined;
  if (!link) {
    res.status(404).json({ error: 'Original link no longer exists.' });
    return;
  }

  // Mark session completed; if view was not already counted when all ads finished, count it once now
  const markDone = db
    .prepare('UPDATE visitor_sessions SET completed = 1 WHERE token = ? AND completed = 0')
    .run(token);

  let countedView = session.view_counted === 1;
  let countedEarning = false;
  if (markDone.changes > 0 && session.view_counted === 0) {
    const credit = creditCompletedAdsView(session);
    countedView = credit.countedView;
    countedEarning = credit.countedEarning;
  }

  res.json({
    originalUrl: link.original_url,
    countedView,
    countedEarning,
  });
});

// ----------------------------------------------------------------------------
// 5. OWNER ADMIN ROUTES (/api/admin/*)
// ----------------------------------------------------------------------------

app.get('/api/admin/me', (req: AuthenticatedRequest, res: Response) => {
  res.json({
    adminEmail: req.adminEmail || null,
    usingDefaultPassword: false,
  });
});

app.post('/api/admin/login', (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid admin email or password.' });
    return;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const createdAt = new Date().toISOString();

  db.prepare(
    'INSERT INTO admin_sessions (token, admin_email, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).run(hashValue(rawToken), email, expiresAt, createdAt);

  setAuthCookie(req, res, ADMIN_COOKIE_NAME, rawToken, ADMIN_SESSION_TTL_MS);

  res.json({ adminEmail: email, adminToken: rawToken });
});

app.post('/api/admin/logout', (req: Request, res: Response) => {
  const tokens = getCandidateTokens(req, ADMIN_COOKIE_NAME, 'x-admin-authorization');
  for (const token of tokens) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(hashValue(token));
  }
  clearAuthCookie(req, res, ADMIN_COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/admin/payouts', requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const pendingRows = db
    .prepare(
      `SELECT
         u.id AS user_id,
         u.name,
         u.email,
         u.pending_balance_paise,
         u.total_earned_paise,
         u.total_paid_paise,
         COALESCE((SELECT SUM(l.clicks) FROM links l WHERE l.user_id = u.id), 0) AS total_views,
         COALESCE((SELECT SUM(l.paid_clicks) FROM links l WHERE l.user_id = u.id), 0) AS paid_views,
         EXISTS(SELECT 1 FROM bank_accounts b WHERE b.user_id = u.id) AS has_bank_details
       FROM users u
       WHERE u.pending_balance_paise > 0
       ORDER BY u.pending_balance_paise DESC, u.id ASC`
    )
    .all() as Array<{
    user_id: number;
    name: string;
    email: string;
    pending_balance_paise: number;
    total_earned_paise: number;
    total_paid_paise: number;
    total_views: number;
    paid_views: number;
    has_bank_details: number;
  }>;

  const pendingUsers = pendingRows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    totalViews: row.total_views,
    paidViews: row.paid_views,
    pendingBalancePaise: row.pending_balance_paise,
    totalEarnedPaise: row.total_earned_paise,
    totalPaidPaise: row.total_paid_paise,
    hasBankDetails: row.has_bank_details === 1,
  }));

  const rows = db
    .prepare(
      `SELECT
         u.id AS user_id,
         u.name,
         u.email,
         u.pending_balance_paise,
         u.total_earned_paise,
         u.total_paid_paise,
         COALESCE((SELECT SUM(l.clicks) FROM links l WHERE l.user_id = u.id), 0) AS total_views,
         COALESCE((SELECT SUM(l.paid_clicks) FROM links l WHERE l.user_id = u.id), 0) AS paid_views,
         b.account_holder_name,
         b.account_number_encrypted,
         b.ifsc_code,
         b.upi_id_encrypted
       FROM users u
       JOIN bank_accounts b ON b.user_id = u.id
       WHERE (u.pending_balance_paise + MAX(0, u.total_earned_paise - u.total_paid_paise)) >= ?
       ORDER BY (u.pending_balance_paise + MAX(0, u.total_earned_paise - u.total_paid_paise)) DESC`
    )
    .all(MINIMUM_PAYOUT_PAISE) as Array<{
    user_id: number;
    name: string;
    email: string;
    pending_balance_paise: number;
    total_earned_paise: number;
    total_paid_paise: number;
    total_views: number;
    paid_views: number;
    account_holder_name: string;
    account_number_encrypted: string;
    ifsc_code: string;
    upi_id_encrypted: string | null;
  }>;

  const eligibleUsers = rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    totalViews: row.total_views,
    paidViews: row.paid_views,
    pendingBalancePaise:
      row.pending_balance_paise + Math.max(0, row.total_earned_paise - row.total_paid_paise),
    totalEarnedPaise: row.total_earned_paise,
    totalPaidPaise: row.total_paid_paise,
    bankDetails: {
      accountHolderName: row.account_holder_name,
      accountNumber: decryptSensitive(row.account_number_encrypted),
      ifscCode: row.ifsc_code,
      upiId: row.upi_id_encrypted ? decryptSensitive(row.upi_id_encrypted) : null,
    },
  }));

  const statsUsers = db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number };
  const statsLinks = db
    .prepare(
      `SELECT
         COUNT(*) AS totalLinks,
         COALESCE(SUM(total_link_clicks), 0) AS totalLinkClicks,
         COALESCE(SUM(clicks), 0) AS totalViews,
         COALESCE(SUM(paid_clicks), 0) AS totalPaidViews,
         COALESCE(SUM(ad_impressions), 0) AS adImpressions,
         COALESCE(SUM(ad_started), 0) AS adStarted,
         COALESCE(SUM(ad_completed), 0) AS adCompleted,
         COALESCE(SUM(ad_skipped), 0) AS adSkipped,
         COALESCE(SUM(ad_failed), 0) AS adFailed,
         COALESCE(SUM(valid_ad_views), 0) AS validAdViews,
         COALESCE(SUM(invalid_views), 0) AS invalidViews,
         COALESCE(SUM(duplicate_views), 0) AS duplicateViews,
         COALESCE(SUM(bot_detections), 0) AS botDetections
       FROM links`
    )
    .get() as {
    totalLinks: number;
    totalLinkClicks: number;
    totalViews: number;
    totalPaidViews: number;
    adImpressions: number;
    adStarted: number;
    adCompleted: number;
    adSkipped: number;
    adFailed: number;
    validAdViews: number;
    invalidViews: number;
    duplicateViews: number;
    botDetections: number;
  };

  const recentPaidRows = db
    .prepare(
      `SELECT p.id, p.user_id, u.name AS user_name, u.email AS user_email, p.amount_paise, p.window_label, p.bank_masked, p.reference_note, p.paid_at, p.created_at
       FROM payouts p
       JOIN users u ON u.id = p.user_id
       WHERE p.status = 'paid'
       ORDER BY p.id DESC
       LIMIT 30`
    )
    .all() as Array<{
    id: number;
    user_id: number;
    user_name: string;
    user_email: string;
    amount_paise: number;
    window_label: string;
    bank_masked: string;
    reference_note: string | null;
    paid_at: string | null;
    created_at: string;
  }>;

  const recentPaid = recentPaidRows.map((p) => ({
    id: p.id,
    userId: p.user_id,
    userName: p.user_name,
    userEmail: p.user_email,
    amountPaise: p.amount_paise,
    windowLabel: p.window_label,
    bankMasked: p.bank_masked,
    referenceNote: p.reference_note,
    paidAt: p.paid_at || p.created_at,
  }));

  const allUserRows = db
    .prepare(
      `SELECT
         u.id AS user_id,
         u.name,
         u.email,
         u.pending_balance_paise,
         u.total_earned_paise,
         u.total_paid_paise,
         u.created_at,
         COALESCE((SELECT COUNT(*) FROM links l WHERE l.user_id = u.id), 0) AS total_links,
         COALESCE((SELECT SUM(l.clicks) FROM links l WHERE l.user_id = u.id), 0) AS total_views,
         COALESCE((SELECT SUM(l.paid_clicks) FROM links l WHERE l.user_id = u.id), 0) AS paid_views,
         EXISTS(SELECT 1 FROM bank_accounts b WHERE b.user_id = u.id) AS has_bank_details
       FROM users u
       ORDER BY u.id DESC`
    )
    .all() as Array<{
    user_id: number;
    name: string;
    email: string;
    pending_balance_paise: number;
    total_earned_paise: number;
    total_paid_paise: number;
    created_at: string;
    total_links: number;
    total_views: number;
    paid_views: number;
    has_bank_details: number;
  }>;

  const allUsers = allUserRows.map((row) => {
    const payoutEligiblePaise =
      row.pending_balance_paise + Math.max(0, row.total_earned_paise - row.total_paid_paise);
    return {
      userId: row.user_id,
      name: row.name,
      email: row.email,
      totalLinks: row.total_links,
      totalViews: row.total_views,
      paidViews: row.paid_views,
      pendingBalancePaise: row.pending_balance_paise,
      totalEarnedPaise: row.total_earned_paise,
      totalPaidPaise: row.total_paid_paise,
      payoutEligiblePaise,
      isTwoHundredComplete: payoutEligiblePaise >= MINIMUM_PAYOUT_PAISE,
      hasBankDetails: row.has_bank_details === 1,
      createdAt: row.created_at,
    };
  });

  res.json({
    adminEmail: req.adminEmail,
    platformStats: {
      totalUsers: statsUsers.cnt,
      totalLinks: statsLinks.totalLinks,
      totalLinkClicks: statsLinks.totalLinkClicks,
      totalViews: statsLinks.totalViews,
      totalPaidViews: statsLinks.totalPaidViews,
      adImpressions: statsLinks.adImpressions,
      adStarted: statsLinks.adStarted,
      adCompleted: statsLinks.adCompleted,
      adSkipped: statsLinks.adSkipped,
      adFailed: statsLinks.adFailed,
      validAdViews: statsLinks.validAdViews,
      invalidViews: statsLinks.invalidViews,
      duplicateViews: statsLinks.duplicateViews,
      botDetections: statsLinks.botDetections,
    },
    allUsers,
    pendingUsers,
    eligibleUsers,
    recentPaid,
  });
});

app.get('/api/admin/users/:userId', requireAdmin, (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'Invalid user ID.' });
    return;
  }

  const userRow = db
    .prepare(
      'SELECT id, name, email, pending_balance_paise, total_earned_paise, total_paid_paise, created_at FROM users WHERE id = ?'
    )
    .get(userId) as
    | {
        id: number;
        name: string;
        email: string;
        pending_balance_paise: number;
        total_earned_paise: number;
        total_paid_paise: number;
        created_at: string;
      }
    | undefined;

  if (!userRow) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const linkRows = db
    .prepare(`SELECT ${LINK_SELECT_COLUMNS} FROM links WHERE user_id = ? ORDER BY id DESC`)
    .all(userId) as DbLink[];

  const aggStats = db
    .prepare(
      `SELECT
         COALESCE(SUM(total_link_clicks), 0) AS totalLinkClicks,
         COALESCE(SUM(clicks), 0) AS totalViews,
         COALESCE(SUM(paid_clicks), 0) AS paidViews,
         COALESCE(SUM(invalid_views), 0) AS invalidViews,
         COALESCE(SUM(duplicate_views), 0) AS duplicateViews,
         COALESCE(SUM(bot_detections), 0) AS botDetections
       FROM links
       WHERE user_id = ?`
    )
    .get(userId) as {
    totalLinkClicks: number;
    totalViews: number;
    paidViews: number;
    invalidViews: number;
    duplicateViews: number;
    botDetections: number;
  };

  const bankRow = db
    .prepare(
      `SELECT account_holder_name, account_number_encrypted, ifsc_code, upi_id_encrypted, updated_at
       FROM bank_accounts
       WHERE user_id = ?`
    )
    .get(userId) as
    | {
        account_holder_name: string;
        account_number_encrypted: string;
        ifsc_code: string;
        upi_id_encrypted: string | null;
        updated_at: string;
      }
    | undefined;

  const payoutRows = db
    .prepare(
      `SELECT id, amount_paise, status, window_label, bank_masked, reference_note, created_at, paid_at
       FROM payouts
       WHERE user_id = ?
       ORDER BY id DESC`
    )
    .all(userId) as Array<{
    id: number;
    amount_paise: number;
    status: string;
    window_label: string;
    bank_masked: string;
    reference_note: string | null;
    created_at: string;
    paid_at: string | null;
  }>;

  const payoutEligiblePaise =
    userRow.pending_balance_paise +
    Math.max(0, userRow.total_earned_paise - userRow.total_paid_paise);

  res.json({
    user: {
      userId: userRow.id,
      name: userRow.name,
      email: userRow.email,
      totalLinks: linkRows.length,
      totalViews: aggStats.totalViews,
      paidViews: aggStats.paidViews,
      pendingBalancePaise: userRow.pending_balance_paise,
      totalEarnedPaise: userRow.total_earned_paise,
      totalPaidPaise: userRow.total_paid_paise,
      payoutEligiblePaise,
      isTwoHundredComplete: payoutEligiblePaise >= MINIMUM_PAYOUT_PAISE,
      hasBankDetails: Boolean(bankRow),
      createdAt: userRow.created_at,
    },
    stats: aggStats,
    bankDetails: bankRow
      ? {
          accountHolderName: bankRow.account_holder_name,
          accountNumber: decryptSensitive(bankRow.account_number_encrypted),
          ifscCode: bankRow.ifsc_code,
          upiId: bankRow.upi_id_encrypted ? decryptSensitive(bankRow.upi_id_encrypted) : null,
          updatedAt: bankRow.updated_at,
        }
      : null,
    links: linkRows.map(formatShortLink),
    payouts: payoutRows.map((p) => ({
      id: p.id,
      amountPaise: p.amount_paise,
      status: p.status,
      windowLabel: p.window_label,
      bankMasked: p.bank_masked,
      referenceNote: p.reference_note,
      createdAt: p.created_at,
      paidAt: p.paid_at,
    })),
  });
});

app.patch('/api/admin/users/:userId/balances', requireAdmin, (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'Invalid user ID.' });
    return;
  }

  const pendingBalancePaise = Number(req.body?.pendingBalancePaise);
  const totalEarnedPaise = Number(req.body?.totalEarnedPaise);
  const totalPaidPaise = Number(req.body?.totalPaidPaise);

  const isValidPaise = (n: number) =>
    Number.isInteger(n) && n >= 0 && n <= 1_000_000_000;

  if (
    !isValidPaise(pendingBalancePaise) ||
    !isValidPaise(totalEarnedPaise) ||
    !isValidPaise(totalPaidPaise)
  ) {
    res.status(400).json({ error: 'Please enter valid non-negative INR balance amounts.' });
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as
    | { id: number }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  db.prepare(
    `UPDATE users
     SET pending_balance_paise = ?, total_earned_paise = ?, total_paid_paise = ?
     WHERE id = ?`
  ).run(pendingBalancePaise, totalEarnedPaise, totalPaidPaise, userId);

  res.json({
    ok: true,
    pendingBalancePaise,
    totalEarnedPaise,
    totalPaidPaise,
  });
});

app.delete('/api/admin/users/:userId', requireAdmin, (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'Invalid user ID.' });
    return;
  }

  const deleteTx = db.transaction(() => {
    const existing = db
      .prepare('SELECT id, name, email FROM users WHERE id = ?')
      .get(userId) as { id: number; name: string; email: string } | undefined;

    if (!existing) {
      return { error: 'User not found.', status: 404 as const };
    }

    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM bank_accounts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM payouts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM links WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    return {
      ok: true as const,
      deletedUserId: userId,
      deletedEmail: existing.email,
      deletedName: existing.name,
    };
  });

  const outcome = deleteTx();
  if ('error' in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

  res.json(outcome);
});

app.post('/api/admin/pending/:userId/approve', requireAdmin, (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'Invalid user ID.' });
    return;
  }

  const approveTx = db.transaction(() => {
    const userRow = db
      .prepare('SELECT id, pending_balance_paise FROM users WHERE id = ?')
      .get(userId) as { id: number; pending_balance_paise: number } | undefined;

    if (!userRow) {
      return { error: 'User not found.', status: 404 as const };
    }

    if (userRow.pending_balance_paise <= 0) {
      return { error: 'No pending balance to add to Total Earned.', status: 400 as const };
    }

    const updated = db
      .prepare(
        `UPDATE users
         SET total_earned_paise = total_earned_paise + ?, pending_balance_paise = 0
         WHERE id = ? AND pending_balance_paise = ?`
      )
      .run(userRow.pending_balance_paise, userId, userRow.pending_balance_paise);

    if (updated.changes === 0) {
      return { error: 'Pending balance changed. Please refresh and try again.', status: 409 as const };
    }

    return { ok: true as const, approvedPaise: userRow.pending_balance_paise };
  });

  const outcome = approveTx();
  if ('error' in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

  res.json(outcome);
});

app.post('/api/admin/payouts/:userId/mark-paid', requireAdmin, (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'Invalid user ID.' });
    return;
  }

  const referenceNote =
    typeof req.body?.referenceNote === 'string' ? req.body.referenceNote.trim().slice(0, 120) : '';
  const allowWithoutBank = Boolean(req.body?.allowWithoutBank);

  const markPaidTx = db.transaction(() => {
    const userRow = db
      .prepare(
        'SELECT id, pending_balance_paise, total_earned_paise, total_paid_paise FROM users WHERE id = ?'
      )
      .get(userId) as
      | {
          id: number;
          pending_balance_paise: number;
          total_earned_paise: number;
          total_paid_paise: number;
        }
      | undefined;

    if (!userRow) {
      return { error: 'User not found.', status: 404 as const };
    }

    const bankRow = db
      .prepare('SELECT account_last4 FROM bank_accounts WHERE user_id = ?')
      .get(userId) as { account_last4: string } | undefined;

    if (!bankRow && !allowWithoutBank) {
      return { error: 'User has not added bank details yet.', status: 400 as const };
    }

    const unpaidApprovedPaise = Math.max(0, userRow.total_earned_paise - userRow.total_paid_paise);
    const payablePaise = userRow.pending_balance_paise + unpaidApprovedPaise;
    if (payablePaise < MINIMUM_PAYOUT_PAISE) {
      return { error: 'User balance is below the ₹200 minimum payout.', status: 400 as const };
    }

    const nowIso = new Date().toISOString();
    const windowInfo = getNextPaymentWindowInfo();
    const bankMasked = bankRow ? maskAccountNumber(bankRow.account_last4) : 'Admin completed';

    db.prepare(
      `INSERT INTO payouts (user_id, amount_paise, status, window_label, bank_masked, reference_note, created_at, paid_at)
       VALUES (?, ?, 'paid', ?, ?, ?, ?, ?)`
    ).run(
      userId,
      payablePaise,
      windowInfo.shortLabel,
      bankMasked,
      referenceNote || null,
      nowIso,
      nowIso
    );

    db.prepare(
      `UPDATE users
       SET total_earned_paise = total_earned_paise + ?,
           total_paid_paise = total_paid_paise + ?,
           pending_balance_paise = 0
       WHERE id = ?`
    ).run(userRow.pending_balance_paise, payablePaise, userId);

    return { ok: true as const, paidPaise: payablePaise };
  });

  const outcome = markPaidTx();
  if ('error' in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

  res.json(outcome);
});

// ----------------------------------------------------------------------------
// 6. FRONTEND SERVING (VITE IN DEV, DIST IN PRODUCTION)
// ----------------------------------------------------------------------------

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Kamaolink server running at http://localhost:${PORT}`);
  });
}

startServer();
