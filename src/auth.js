import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dataDir = () => path.resolve(process.env.DATA_DIR || "data");
const usersFile = () => path.join(dataDir(), "users.json");
const SESSION_HOURS = 12;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET (32+ chars) is required in production");
  return "dev-only-session-secret-change-me-please-0000";
}

// ---------- Passwords (scrypt) ----------

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || "").split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// ---------- Users ----------
// role "admin" = DBS staff (all clients). role "client" = one tenant only.

export function loadUsers() {
  if (!fs.existsSync(usersFile())) return [];
  return JSON.parse(fs.readFileSync(usersFile(), "utf8"));
}

function saveUsers(users) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = `${usersFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, usersFile());
}

export const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name || "", role: u.role, tenant_id: u.tenant_id || null };

export function createUser({ email, password, name, role, tenant_id }) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email");
  if (String(password || "").length < 10) throw new Error("Password must be at least 10 characters");
  if (!["admin", "client"].includes(role)) throw new Error("Role must be admin or client");
  if (role === "client" && !tenant_id) throw new Error("Client users need a client account");
  const users = loadUsers();
  if (users.some((u) => u.email === email)) throw new Error("A user with that email already exists");
  const user = { id: crypto.randomUUID(), email, name: name || "", role, tenant_id: role === "client" ? tenant_id : null, password: hashPassword(password), created_at: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  return publicUser(user);
}

export function deleteUser(id) {
  const users = loadUsers();
  const next = users.filter((u) => u.id !== id);
  if (next.length === users.length) throw new Error("User not found");
  saveUsers(next);
}

export function setPassword(id, password) {
  if (String(password || "").length < 10) throw new Error("Password must be at least 10 characters");
  const users = loadUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error("User not found");
  u.password = hashPassword(password);
  saveUsers(users);
}

export function authenticate(email, password) {
  const u = loadUsers().find((x) => x.email === String(email || "").trim().toLowerCase());
  // Always run scrypt so response time doesn't reveal whether the email exists.
  const ok = verifyPassword(String(password || ""), u?.password || "scrypt$00$00");
  return ok && u ? u : null;
}

// ---------- Sessions (signed cookie) ----------

const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

export function sessionCookie(user, secure) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
  const value = `${payload}.${sign(payload)}`;
  return `sid=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`;
}

export const clearCookie = (secure) => `sid=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;

export function userFromRequest(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const a = Buffer.from(sign(payload));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
  if (!data.exp || data.exp < Date.now()) return null;
  return loadUsers().find((u) => u.id === data.uid) || null;
}

// ---------- Login rate limit (per IP, in memory) ----------

const attempts = new Map();
export function loginAllowed(ip) {
  const now = Date.now();
  const rec = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  attempts.set(ip, rec);
  return rec.length < 10;
}
export function noteFailedLogin(ip) {
  attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
}
