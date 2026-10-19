// 用 curl（schannel TLS 栈）重放 Rust 转储的请求，判定是否 TLS 指纹问题
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const dump = fs.readFileSync("C:/Users/Administrator/AppData/Local/Temp/rust-dump.txt", "utf8");
const [hs, body] = dump.split("=== BODY ===\n");
const lines = hs.split("=== HEADERS ===\n")[1].split("\n").filter((l) => l.includes(": "));
const headerArgs = [];
for (const l of lines) {
  const i = l.indexOf(": ");
  headerArgs.push("-H", `${l.slice(0, i)}: ${l.slice(i + 2)}`);
}
const bodyPath = "C:/Users/Administrator/AppData/Local/Temp/rust-dump-body.bin";
fs.writeFileSync(bodyPath, body, "utf8");

const url = "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const args = [
  "-s", "--noproxy", "*", "-X", "POST",
  "-w", "\n__HTTP__%{http_code}",
  "--max-time", "30",
  ...headerArgs,
  "--data-binary", `@${bodyPath}`,
  url,
];
try {
  const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  console.log(out.slice(0, 300).replace(/\n/g, " "));
} catch (e) {
  console.log("curl failed:", e.status, String(e.stdout || "").slice(0, 200), String(e.stderr || "").slice(0, 200));
}
