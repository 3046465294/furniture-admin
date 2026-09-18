/**
 * 鉴权与会话 —— scrypt 口令哈希 + 自签 HMAC-SHA256 令牌 + 服务端会话表。
 *
 * 为什么不用现成 JWT 库：这里只需要 HS256 的签发与校验，用 node:crypto 十几行就能写清，
 * 而且「自己写」能避免依赖链漏洞——上一版（2019 的 RuoYi）就是因为老依赖被扫出风险才不能公开跑。
 *
 * 安全要点：
 *   · 口令用 scrypt（每个用户独立盐），比对用 timingSafeEqual，避免时序侧信道
 *   · Cookie 里放的是「会话 id 的 HMAC」，服务端只存 id —— 数据库泄露也无法直接冒充登录
 *   · 登录失败按 IP + 账号双维度计数，超限锁定（防暴力破解）
 *   · Cookie 为 HttpOnly + SameSite=Strict；确认是 HTTPS 访问时再加 Secure
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { db, now } from './db.js';

const SECRET = process.env.APP_SECRET ?? 'dev-secret-change-me';
export const SESSION_COOKIE = 'fa_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 小时
const MAX_FAILED = 5;                          // 连续失败 5 次
const LOCK_MS = 10 * 60 * 1000;                // 锁定 10 分钟

// ────────────────────────── 口令 ──────────────────────────
export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const a = scryptSync(plain, salt, 64);
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ────────────────────────── 令牌（HS256 风格） ──────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadObj) {
  const body = b64url(JSON.stringify(payloadObj));
  const mac = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const expect = createHmac('sha256', SECRET).update(body).digest('base64url');
  if (expect.length !== mac.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(mac))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ────────────────────────── 会话 ──────────────────────────
export function createSession(user, ip, userAgent) {
  const id = randomUUID();
  const expires = Date.now() + SESSION_TTL_MS;
  db.prepare('insert into sessions(id,user_id,created_at,expires_at,ip,user_agent) values (?,?,?,?,?,?)')
    .run(id, user.id, Date.now(), expires, ip ?? '', (userAgent ?? '').slice(0, 200));
  // 交给浏览器的不是 id，而是它的 HMAC —— 库里只存 id
  const cookieValue = createHmac('sha256', SECRET).update(id).digest('base64url');
  return { token: sign({ sid: cookieValue, exp: expires }), expires };
}

export function destroySession(token) {
  const payload = unsign(token);
  if (!payload?.sid) return;
  for (const s of db.prepare('select id from sessions where revoked = 0').all()) {
    if (createHmac('sha256', SECRET).update(s.id).digest('base64url') === payload.sid) {
      db.prepare('update sessions set revoked = 1 where id = ?').run(s.id);
    }
  }
}

/** 从 Cookie 解析当前登录用户；无效则返回 null */
export function currentUser(req) {
  const raw = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE];
  const payload = unsign(raw);
  if (!payload?.sid) return null;
  const row = db.prepare(`
    select s.id as sid, s.expires_at, s.revoked, u.id, u.username, u.display_name, u.role, u.active
    from sessions s join users u on u.id = s.user_id where s.revoked = 0
  `).all().find((r) => createHmac('sha256', SECRET).update(r.sid).digest('base64url') === payload.sid);
  if (!row || row.revoked || row.expires_at < Date.now() || !row.active) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, sessionId: row.sid };
}

/** 在线会话数（监控面板用） */
export function activeSessionCount() {
  return db.prepare('select count(*) as c from sessions where revoked = 0 and expires_at > ?').get(Date.now()).c;
}

// ────────────────────────── 登录限流 ──────────────────────────
const attempts = new Map();   // key -> { count, until }

export function loginAllowed(key) {
  const a = attempts.get(key);
  if (!a) return true;
  if (a.until && Date.now() > a.until) { attempts.delete(key); return true; }
  return a.count < MAX_FAILED;
}
export function noteLoginFailure(key) {
  const a = attempts.get(key) ?? { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= MAX_FAILED) a.until = Date.now() + LOCK_MS;
  attempts.set(key, a);
  return { count: a.count, lockedForMs: a.until ? a.until - Date.now() : 0 };
}
export function clearLoginFailures(key) { attempts.delete(key); }
export function loginRateSnapshot() {
  const out = [];
  for (const [k, v] of attempts) out.push({ key: k, failures: v.count, locked: !!(v.until && Date.now() < v.until) });
  return out;
}

// ────────────────────────── 小工具 ──────────────────────────
export function parseCookies(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookieHeader(token, expires, secure) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookieHeader(secure) {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** 权限模型：admin 全权；operator 可改业务数据；viewer 只读 */
export const PERMISSIONS = {
  admin: ['read', 'write', 'delete', 'manage_users'],
  operator: ['read', 'write'],
  viewer: ['read'],
};
export const can = (role, action) => (PERMISSIONS[role] ?? []).includes(action);

/** 初始化管理员账号（仅在没有任何用户时执行） */
export function ensureAdmin(displayName = '系统管理员') {
  const existing = db.prepare('select count(*) as c from users').get().c;
  if (existing > 0) return null;
  const password = process.env.ADMIN_PASSWORD ?? generatePassword();
  db.prepare('insert into users(username,display_name,password_hash,role,active,created_at) values (?,?,?,?,1,?)')
    .run('admin', displayName, hashPassword(password), 'admin', now());
  return { username: 'admin', password };
}

/** 生成强口令（不含易混字符） */
export function generatePassword(len = 16) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*-_';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}
