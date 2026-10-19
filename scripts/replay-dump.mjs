// 重放 Rust 转储的请求（逐字节），并解码 body 与正常版本对比
import fs from "node:fs";

const dump = fs.readFileSync(process.argv[2] ?? "C:/Users/Administrator/AppData/Local/Temp/rust-dump.txt", "utf8");
const [headerSection, body] = dump.split("=== BODY ===\n");
const headers = {};
for (const line of headerSection.split("=== HEADERS ===\n")[1].split("\n")) {
  const idx = line.indexOf(": ");
  if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 2).trim();
}
if (!headers["content-type"]) headers["content-type"] = "application/json";
if (!headers.accept) headers.accept = "text/event-stream";
if (!headers["accept-encoding"]) headers["accept-encoding"] = "identity";

const URL_ = "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const ac = new AbortController();
const resp = await fetch(URL_, {
  method: "POST",
  headers,
  body,
  signal: ac.signal,
});
let first = "";
try {
  const reader = resp.body.getReader();
  const { value } = await reader.read();
  first = new TextDecoder().decode(value || new Uint8Array()).slice(0, 200);
} catch (e) { first = "read-err: " + e.message; }
ac.abort();
console.log(`[replay rust dump] HTTP ${resp.status} →`, first.replace(/\n/g, " "));

// 解码 body 检查内容
const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
function legacyDecode(encoded) {
  const lookup = new Map();
  for (let i = 0; i < 64; i += 1) lookup.set(CUSTOM[i], STD[i]);
  lookup.set("$", "=");
  let std = "";
  for (const ch of encoded) std += lookup.get(ch) ?? ch;
  const n = std.length;
  const a = Math.floor(n / 3);
  const restored = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return Buffer.from(restored, "base64").toString("utf8");
}
try {
  const decoded = JSON.parse(legacyDecode(body));
  console.log("=== 解码成功，字段 ===");
  console.log(Object.keys(decoded).join(","));
  console.log("messages:", JSON.stringify(decoded.messages)?.slice(0, 200));
  console.log("model_config:", JSON.stringify(decoded.model_config));
  console.log("chat_context.text:", JSON.stringify(decoded.chat_context?.text));
} catch (e) {
  console.log("解码失败:", e.message);
}
