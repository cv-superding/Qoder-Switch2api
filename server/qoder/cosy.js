/**
 * Qoder Cosy 认证协议（复刻自 qoder2api/internal/qoder/legacy.go 与
 * Qoder-Switch/src-tauri/src/auth/cosy.rs）：
 *
 *  1. 生成随机 AES key（uuid 无横线前 16 位）
 *  2. AES-128-CBC（IV = key 本身，服务端约定）加密用户信息 JSON
 *  3. RSA PKCS1v15 加密 AES key → cosy-key
 *  4. payload = { version, requestId, info, cosyVersion, ideVersion } → base64
 *  5. sig = md5(payload_b64 + "\n" + cosy_key + "\n" + cosy_date + "\n" + body + "\n" + path)
 *  6. authorization: Bearer COSY.<payload_b64>.<sig>
 *
 * 请求体再经过 legacyEncode（自定义 base64 字母表 + 分段重排）编码。
 */
import crypto from "node:crypto";
import { md5, uuid } from "../crypto.js";

const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const CUSTOM_PAD = "$";

function aesKeyMaterial() {
  return uuid().replace(/-/g, "").slice(0, 16);
}

/** AES-128-CBC 加密（IV 复用 key，Qoder 服务端约定，非标准实践） */
function cosyAesEncrypt(plaintext, key) {
  const iv = Buffer.from(key, "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), iv);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
}

function cosyRsaEncrypt(pubKeyPem, plain) {
  const key = crypto.createPublicKey({ key: pubKeyPem, format: "pem" });
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, plain);
}

function pkcs7Pad(buf, blockSize) {
  const padding = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(padding, padding)]);
}

/**
 * 构建 Cosy 请求头。
 */
export function buildCosyHeaders({ token, userId, name, email, requestPath, requestBody, edition, identity = {} }) {
  const aesKey = aesKeyMaterial();
  const userInfo = {
    name: name || identity.name || "",
    aid: identity.aid || "",
    uid: userId || identity.uid || "",
    yx_uid: identity.yxUid || "",
    organization_id: identity.orgId || "",
    organization_name: identity.orgName || "",
    user_type: identity.userType || "personal_standard",
    security_oauth_token: token,
    refresh_token: identity.refreshToken || "",
  };
  const encryptedInfo = cosyAesEncrypt(JSON.stringify(userInfo), aesKey).toString("base64");
  const rsaEncryptedKey = cosyRsaEncrypt(edition.legacy.serverPubKey, Buffer.from(aesKey, "utf8")).toString("base64");
  const requestId = uuid().replace(/-/g, "");
  const cosyDate = String(Math.floor(Date.now() / 1000));
  const payload = {
    version: "v1",
    requestId,
    info: encryptedInfo,
    cosyVersion: edition.legacy.cosyVersion,
    ideVersion: "",
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const sig = md5(`${payloadB64}\n${rsaEncryptedKey}\n${cosyDate}\n${requestBody}\n${requestPath}`);
  return {
    authorization: `Bearer COSY.${payloadB64}.${sig}`,
    cosyUser: userId || identity.uid || "",
    cosyKey: rsaEncryptedKey,
    cosyDate,
    requestId,
  };
}

/**
 * Qoder 自定义 base64：先标准 base64，再做「末段前置」重排，最后逐字符替换字母表。
 * （复刻自 qoder2api legacyEncode）
 */
export function legacyEncode(plaintext) {
  const std = Buffer.from(plaintext, "utf8").toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  const lookup = new Map();
  for (let i = 0; i < 64; i += 1) lookup.set(STD_ALPHABET[i], CUSTOM_ALPHABET[i]);
  lookup.set("=", CUSTOM_PAD);
  let out = "";
  for (const ch of rearranged) out += lookup.get(ch) ?? ch;
  return out;
}

/** legacyEncode 的逆变换：还原明文 */
export function legacyDecode(encoded) {
  const lookup = new Map();
  for (let i = 0; i < 64; i += 1) lookup.set(CUSTOM_ALPHABET[i], STD_ALPHABET[i]);
  lookup.set(CUSTOM_PAD, "=");
  let std = "";
  for (const ch of encoded) std += lookup.get(ch) ?? ch;
  const n = std.length;
  const a = Math.floor(n / 3);
  // encoded = std[n-a:] + std[a:n-a] + std[:a]
  const restored = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return Buffer.from(restored, "base64").toString("utf8");
}

/** legacy 流式请求的完整 Cosy 头（含 machine 系列头） */
export function buildLegacyStreamHeaders({ account, edition, requestPath, requestBody }) {
  // machine token/type 缺失时生成随机值（与 qoder2api 参考实现一致）
  const machineToken = account.machineToken || randomMachineToken();
  const machineType = account.machineType || randomHex(18);
  const machineId = account.machineId || randomUUID();
  const cosy = buildCosyHeaders({
    token: account.securityOauthToken,
    userId: account.uid,
    name: account.name,
    email: account.email,
    requestPath,
    requestBody,
    edition,
    identity: account,
  });
  return {
    "cache-control": "no-cache",
    "cosy-data-policy": "AGREE",
    authorization: cosy.authorization,
    "content-type": "application/json",
    "cosy-clienttype": "5",
    "cosy-clientip": "169.254.198.161",
    "cosy-date": cosy.cosyDate,
    "cosy-key": cosy.cosyKey,
    "cosy-machineid": machineId,
    "cosy-machinetoken": machineToken,
    "cosy-machinetype": machineType,
    "cosy-user": cosy.cosyUser,
    "cosy-version": edition.legacy.cosyVersion,
    "login-version": "v2",
    "x-request-id": cosy.requestId,
  };
}

function randomMachineToken() {
  const raw = (uuid() + uuid()).slice(0, 50);
  return Buffer.from(raw, "utf8").toString("base64url");
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

export { pkcs7Pad };
