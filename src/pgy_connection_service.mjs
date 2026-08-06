import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function encryptionKey(secret) {
  if (String(secret || "").length < 16) throw new Error("PGY 连接加密密钥至少需要 16 个字符");
  return createHash("sha256").update(String(secret)).digest();
}

export function encryptStorageState(storageState, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const plaintext = Buffer.from(
    typeof storageState === "string" ? storageState : JSON.stringify(storageState),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptStorageState(encoded, secret) {
  const [version, ivBase64, tagBase64, ciphertextBase64] = String(encoded || "").split(".");
  if (version !== "v1" || !ivBase64 || !tagBase64 || !ciphertextBase64) {
    throw new Error("蒲公英连接密文格式无效");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    Buffer.from(ivBase64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function loadEncryptedStorageState(
  encryptedStatePath,
  secret,
  { readImpl = fs.readFile } = {},
) {
  const encoded = await readImpl(encryptedStatePath, "utf8");
  const plaintext = decryptStorageState(encoded, secret);
  const parsed = JSON.parse(plaintext);
  if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
    throw new Error("蒲公英连接状态结构无效");
  }
  return parsed;
}

export function pgyProfileDirectory(root, ownerType, ownerId) {
  if (!["user", "workspace"].includes(ownerType)) throw new Error("蒲公英连接 ownerType 无效");
  const safeOwnerId = String(ownerId || "").replace(/[^\w-]/g, "");
  if (!safeOwnerId) throw new Error("蒲公英连接 ownerId 无效");
  const rootPath = path.resolve(root);
  const profilePath = path.resolve(rootPath, `${ownerType}-${safeOwnerId}`);
  if (!profilePath.startsWith(`${rootPath}${path.sep}`)) throw new Error("蒲公英资料目录越界");
  return profilePath;
}

export async function deleteLegacyPlaintextStorageStates(
  root,
  {
    readdirImpl = fs.readdir,
    unlinkImpl = fs.unlink,
  } = {},
) {
  const rootPath = path.resolve(root);
  const pending = [rootPath];
  const deleted = [];
  while (pending.length) {
    const directory = pending.pop();
    const entries = await readdirImpl(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink?.()) continue;
      const target = path.resolve(directory, entry.name);
      if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
        throw new Error("旧登录态清理路径越界");
      }
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile() && entry.name === "storage-state.json") {
        await unlinkImpl(target);
        deleted.push(target);
      }
    }
  }
  return deleted;
}

export function memoryConnectionService(seed = []) {
  const rows = new Map(seed.map((item) => [item.id, { ...item }]));
  return {
    async getForUser(userId) {
      return Array.from(rows.values()).find((item) => (
        item.ownerType === "user" && item.ownerId === userId && !item.disconnectedAt
      )) || null;
    },
    async getWorkspaceConnection(workspaceId) {
      return Array.from(rows.values()).find((item) => (
        item.ownerType === "workspace" && item.ownerId === workspaceId && !item.disconnectedAt
      )) || null;
    },
  };
}
