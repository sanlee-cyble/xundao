import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 64;

export async function hashPassword(password) {
  if (String(password || "").length < 12) throw new Error("密码至少需要 12 个字符");
  const salt = randomBytes(16);
  const hash = await scrypt(String(password), salt, PASSWORD_BYTES);
  return `scrypt$${salt.toString("base64")}$${Buffer.from(hash).toString("base64")}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, saltBase64, hashBase64] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !saltBase64 || !hashBase64) return false;
  const expected = Buffer.from(hashBase64, "base64");
  const actual = Buffer.from(await scrypt(String(password), Buffer.from(saltBase64, "base64"), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requireRole(user, requiredRole) {
  if (!user || user.status !== "active") throw new Error("账号未登录或已停用");
  if (requiredRole === "admin" && user.role !== "admin") throw new Error("无管理员权限");
  return user;
}

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}
