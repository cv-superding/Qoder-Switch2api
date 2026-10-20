/**
 * JSON 文件持久化（账号库等敏感数据整体加密存放）。
 * 原子写：临时文件 + rename。
 */
import fs from "node:fs";
import path from "node:path";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { dataFile, ensureDataDir } from "./paths.js";

function readRaw(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

/** 读取 JSON 配置文件；不存在时返回 fallback。不缓存，确保多进程 / 双模式读写一致 */
export function loadJson(name, fallback = null) {
  const raw = readRaw(dataFile(name));
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 写入 JSON 配置文件（明文，非敏感） */
export function saveJson(name, value) {
  ensureDataDir();
  atomicWrite(dataFile(name), JSON.stringify(value, null, 2));
  return value;
}

/** 读取加密的敏感数据（如账号库）；解密失败时尝试明文兼容 */
export function loadEncrypted(name, fallback = null) {
  const file = dataFile(name);
  const raw = readRaw(file);
  if (raw == null) return fallback;
  const decrypted = decryptSecret(raw.trim());
  if (decrypted != null) {
    try {
      return JSON.parse(decrypted);
    } catch {
      /* 落到明文尝试 */
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 写入加密的敏感数据 */
export function saveEncrypted(name, value) {
  ensureDataDir();
  atomicWrite(dataFile(name), encryptSecret(JSON.stringify(value)));
  return value;
}

/** 追加一行 JSONL（日志类数据，如签到记录） */
export function appendJsonl(name, entry) {
  ensureDataDir();
  const file = dataFile(name);
  fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, "utf8");
}

export function readJsonl(name, limit = 500) {
  const file = dataFile(name);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

export function dataFilePath(name) {
  return path.join(dataFile(name));
}
