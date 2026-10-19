/**
 * 加密工具：
 *  - 本工具账号库：AES-256-GCM，密钥由机器标识派生（同 Qoder-Switch 方案）
 *  - Qoder 客户端 auth.v1.dat：Chromium OSCrypt v10（AES-256-GCM），
 *    密钥来自 Local State 的 os_crypt.encrypted_key，Windows 下经 DPAPI 解包
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* 本工具账号库加密                                                     */
/* ------------------------------------------------------------------ */

function machineKey() {
  const machineName = process.env.COMPUTERNAME || process.env.HOSTNAME || "default_host";
  const userName = process.env.USERNAME || process.env.USER || "default_user";
  const material = `${machineName}_${userName}_qoder-switch2api`;
  return crypto.createHash("sha256").update(material, "utf8").digest();
}

/** 加密为 base64（[12B nonce][ciphertext+tag]） */
export function encryptSecret(plaintext) {
  const key = machineKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/** 解密 base64；非本机数据返回 null */
export function decryptSecret(payload) {
  try {
    const raw = Buffer.from(payload, "base64");
    if (raw.length < 28) return null;
    const key = machineKey();
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* OSCrypt（Qoder 客户端 auth.v1.dat）                                  */
/* ------------------------------------------------------------------ */

/**
 * Windows DPAPI 解密（CurrentUser 作用域）。
 * 通过 PowerShell 调用 ProtectedData，避免引入原生模块。
 */
export async function dpapiUnprotect(base64CipherText) {
  if (process.platform !== "win32") {
    throw new Error("DPAPI 仅支持 Windows；macOS/Linux 的 OSCrypt 密钥在系统钥匙串中，暂不支持自动读写");
  }
  const script = `
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String('${base64CipherText}')
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
    [Convert]::ToBase64String($plain)
  `.trim();
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
  );
  return Buffer.from(stdout.trim(), "base64");
}

/**
 * 读取客户端 Local State 并解出 OSCrypt AES 密钥（32 字节）。
 * 返回 null 表示无法解出（非 Windows / 文件缺失）。
 */
export async function loadOscryptKey(clientDir) {
  const localState = path.join(clientDir, "Local State");
  if (!fs.existsSync(localState)) return null;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(localState, "utf8"));
  } catch {
    return null;
  }
  const encryptedKeyB64 = json?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) return null;
  const raw = Buffer.from(encryptedKeyB64, "base64");
  // 前缀 "DPAPI" 之后才是 DPAPI 密文
  const prefix = raw.subarray(0, 5).toString("utf8");
  const cipherText = prefix === "DPAPI" ? raw.subarray(5) : raw;
  const key = await dpapiUnprotect(cipherText.toString("base64"));
  return key.length === 32 ? key : null;
}

/** OSCrypt v10 解密：[3B "v10"][12B nonce][ciphertext+tag] */
export function oscryptDecrypt(key, fileBytes) {
  if (fileBytes.length < 3 + 12 + 16) throw new Error("auth.v1.dat 文件过小");
  const version = fileBytes.subarray(0, 3).toString("utf8");
  if (version !== "v10") throw new Error(`不支持的 OSCrypt 版本: ${version || "(空)"}`);
  const nonce = fileBytes.subarray(3, 15);
  const ct = fileBytes.subarray(15, fileBytes.length - 16);
  const tag = fileBytes.subarray(fileBytes.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** OSCrypt v10 加密 */
export function oscryptEncrypt(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("v10", "utf8"), nonce, ct, tag]);
}

/* ------------------------------------------------------------------ */
/* 杂项                                                                */
/* ------------------------------------------------------------------ */

export function randomId(prefix = "id") {
  return `${prefix}_${Date.now().toString(16)}${crypto.randomBytes(4).toString("hex")}`;
}

export function uuid() {
  return crypto.randomUUID();
}

export function md5(input) {
  return crypto.createHash("md5").update(input, "utf8").digest("hex");
}

/** 机器标识（用于 OAuth machine_id / 展示） */
export function machineIdFallback() {
  return crypto.createHash("sha256").update(os.hostname() + os.userInfo().username).digest("hex").slice(0, 32);
}
