// 复现 Rust 版请求：两种 JSON 键序（Node 插入序 vs Rust 字母序）打上游，定位 500 根因
import { buildLegacyStreamHeaders, legacyEncode } from "../server/qoder/cosy.js";
import { EDITIONS } from "../server/editions.js";
import { randomUUID } from "node:crypto";

const edition = EDITIONS.domestic;
const account = JSON.parse(process.argv[2] ?? "{}");

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function buildBody(keyOrder) {
  const requestId = randomUUID();
  const prompt = "回复OK";
  const body = {
    request_id: requestId,
    chat_record_id: requestId,
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      chatPrompt: "",
      extra: {
        context: [],
        modelConfig: { is_reasoning: false, key: "auto", is_vl: false },
        originalContent: { type: "text", text: prompt },
      },
      features: [],
      imageUrls: null,
      text: { type: "text", text: prompt },
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    session_id: randomUUID(),
    code_language: "",
    source: 1,
    version: "3",
    chat_prompt: "",
    parameters: { max_tokens: 32768 },
    aliyun_user_type: "personal_standard",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    model_config: {
      key: "auto",
      display_name: "Auto",
      model: "",
      format: "openai",
      is_vl: false,
      is_reasoning: false,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: 180000,
    },
    business: {
      id: randomUUID(),
      begin_at: Date.now(),
      scene: "chat",
      type: "chat",
      sub_type: "free_input",
      name: prompt,
      language: "",
      parent_type: "",
    },
    messages: [
      {
        role: "user",
        content: "",
        contents: [{ type: "text", text: prompt }],
        response_meta: { id: "", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
        reasoning_content_signature: "",
      },
    ],
    tools: [],
  };
  return keyOrder === "sorted" ? sortKeys(body) : body;
}

async function attempt(label, keyOrder) {
  const body = buildBody(keyOrder);
  const encoded = legacyEncode(JSON.stringify(body));
  const headers = buildLegacyStreamHeaders({
    account: acct,
    edition,
    requestPath: edition.legacy.streamPath,
    requestBody: encoded,
  });
  const ac = new AbortController();
  const resp = await fetch(edition.legacy.streamUrl, {
    method: "POST",
    headers: {
      "cache-control": "no-cache",
      accept: "text/event-stream",
      "accept-encoding": "identity",
      "content-type": "application/json",
      ...headers,
    },
    body: encoded,
    signal: ac.signal,
  });
  let first = '';
  try {
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    first = new TextDecoder().decode(value || new Uint8Array()).slice(0, 160);
  } catch (e) { first = 'read-err: ' + e.message; }
  ac.abort();  console.log(`[${label}] HTTP ${resp.status} →`, first.replace(/\n/g, " ").slice(0, 150));
}

const acct = {
  securityOauthToken: process.env.TOKEN,
  uid: process.env.UID,
  name: process.env.NAME,
  email: "",
  aid: "",
  yxUid: "",
  orgId: "",
  orgName: "",
  userType: "personal_standard",
  refreshToken: process.env.REFRESH || "",
  machineId: process.env.MACHINE_ID,
  machineToken: "",
  machineType: "",
};

await attempt("insertion-order（Node 风格）", "insertion");
await new Promise((r) => setTimeout(r, 1500));
await attempt("sorted（Rust 风格）", "sorted");

// ===== 变体 C：Rust 风格 cosy 头（user_info 与 payload 均字母序，模拟 serde_json BTreeMap） =====
import crypto from "node:crypto";
import { md5 } from "../server/crypto.js";

function rustStyleCosyHeaders() {
  const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfoSorted = {
    aid: acct.aid ?? "",
    name: acct.name ?? "",
    organization_id: acct.orgId ?? "",
    organization_name: acct.orgName ?? "",
    refresh_token: acct.refreshToken ?? "",
    security_oauth_token: acct.securityOauthToken,
    uid: acct.uid,
    user_type: acct.userType ?? "personal_standard",
    yx_uid: acct.yxUid ?? "",
  };
  const iv = Buffer.from(aesKey, "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(aesKey, "utf8"), iv);
  const encryptedInfo = Buffer.concat([cipher.update(JSON.stringify(sortKeys(userInfoSorted)), "utf8"), cipher.final()]).toString("base64");
  const rsaKey = crypto.createPublicKey({ key: edition.legacy.serverPubKey, format: "pem" });
  const rsaEncryptedKey = crypto.publicEncrypt({ key: rsaKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(aesKey, "utf8")).toString("base64");
  const requestId = randomUUID().replace(/-/g, "");
  const cosyDate = String(Math.floor(Date.now() / 1000));
  const payload = { cosyVersion: edition.legacy.cosyVersion, ideVersion: "", info: encryptedInfo, requestId, version: "v1" };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return { aesKey, encryptedInfo, rsaEncryptedKey, requestId, cosyDate, payloadB64, userInfoSorted };
}

async function attemptRustCosy(label) {
  const body = buildBody("insertion");
  const encoded = legacyEncode(JSON.stringify(body));
  const c = rustStyleCosyHeaders();
  const sig = md5(`${c.payloadB64}\n${c.rsaEncryptedKey}\n${c.cosyDate}\n${encoded}\n${edition.legacy.streamPath}`);
  const authorization = `Bearer COSY.${c.payloadB64}.${sig}`;
  const ac = new AbortController();
  const resp = await fetch(edition.legacy.streamUrl, {
    method: "POST",
    headers: {
      "cache-control": "no-cache",
      accept: "text/event-stream",
      "accept-encoding": "identity",
      "content-type": "application/json",
      "cosy-clienttype": "5",
      "cosy-clientip": "169.254.198.161",
      "cosy-date": c.cosyDate,
      "cosy-key": c.rsaEncryptedKey,
      "cosy-machineid": process.env.MACHINE_ID,
      "cosy-machinetoken": Buffer.from((randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 50), "utf8").toString("base64url"),
      "cosy-machinetype": crypto.randomBytes(18).toString("hex"),
      "cosy-user": acct.uid,
      "cosy-version": edition.legacy.cosyVersion,
      "login-version": "v2",
      "x-request-id": c.requestId,
      authorization,
    },
    body: encoded,
    signal: ac.signal,
  });
  let first = "";
  try {
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    first = new TextDecoder().decode(value || new Uint8Array()).slice(0, 160);
  } catch (e) { first = "read-err: " + e.message; }
  ac.abort();
  console.log(`[${label}] HTTP ${resp.status} →`, first.replace(/\n/g, " ").slice(0, 150));
}

await new Promise((r) => setTimeout(r, 1500));
await attemptRustCosy("rust-cosy（Rust 头风格）");
