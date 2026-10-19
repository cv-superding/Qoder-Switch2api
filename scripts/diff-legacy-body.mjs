// 对比 Node 版与 Rust 版（转写）的 legacy 请求体差异
import { buildLegacyRequest } from "../server/qoder/chat.js";

const req = {
  account: {
    userType: "personal_standard",
    securityOauthToken: "dt-test",
    uid: "uid-1",
    name: "tester",
    email: "",
    machineId: "mid",
    machineToken: "",
    machineType: "",
    refreshToken: "",
  },
  model: "auto",
  messages: [{ role: "user", content: "回复OK" }],
  tools: null,
  imageUrls: [],
  reasoningEffort: "",
  thinkingBudget: null,
};

// Node 版（插入序）
const nodeBody = buildLegacyRequest(req);

// Rust 版转写：serde_json json! 宏默认 BTreeMap → 序列化后键为字母序
// 这里用"深度排序键"模拟 serde_json::to_string 的输出
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
const rustLikeBody = JSON.parse(JSON.stringify(sortKeys(JSON.parse(JSON.stringify(nodeBody)))));

// 字段差异（忽略 uuid/时间戳类随机值）
const randomKeys = new Set(["request_id", "chat_record_id", "session_id", "id"]);
function diff(a, b, path = "") {
  const out = [];
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  for (const k of new Set([...ak, ...bk])) {
    if (randomKeys.has(k)) continue;
    const p = path ? `${path}.${k}` : k;
    const av = a?.[k];
    const bv = b?.[k];
    if (typeof av === "object" && av && typeof bv === "object" && bv) {
      out.push(...diff(av, bv, p));
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push(`${p}: node=${JSON.stringify(av)} rust=${JSON.stringify(bv)}`);
    }
  }
  return out;
}

// Rust 版的显式字段与 Node 模板对齐校验（手工列出 Rust json! 里的字段集）
const rustFields = new Set([
  "request_id", "chat_record_id", "stream", "chat_task", "chat_context", "image_urls",
  "is_reply", "is_retry", "session_id", "code_language", "source", "version", "chat_prompt",
  "parameters", "aliyun_user_type", "session_type", "agent_id", "task_id", "model_config",
  "business", "messages", "tools",
]);
const nodeFields = new Set(Object.keys(nodeBody));
console.log("node 独有字段:", [...nodeFields].filter((k) => !rustFields.has(k)));
console.log("rust 独有字段:", [...rustFields].filter((k) => !nodeFields.has(k)));
console.log("值差异:", diff(nodeBody, nodeBody).length ? diff(nodeBody, nodeBody) : "无（node 自身）");

// 重点抽查 Rust 模板与 Node 模板差异（人工列出的 Rust 值）
const rustOverrides = {
  "chat_context.extra.modelConfig": { is_reasoning: false, key: "auto", is_vl: false },
  "model_config.display_name": "Auto",
  "model_config.model": "",
  "model_config.api_key": "",
  "model_config.url": "",
  "model_config.source": "system",
  "model_config.max_input_tokens": 180000,
  "business.scene": "chat",
  "business.type": "chat",
  "business.sub_type": "free_input",
  "business.language": "",
  "business.parent_type": "",
  "code_language": "",
  "chat_prompt": "",
  "version": "3",
  "source": 1,
  "task_id": "common",
  "is_reply": true,
  "is_retry": false,
};
function get(o, p) {
  return p.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), o);
}
for (const [p, expect] of Object.entries(rustOverrides)) {
  const actual = get(nodeBody, p);
  if (JSON.stringify(actual) !== JSON.stringify(expect)) {
    console.log(`DIFF ${p}: node=${JSON.stringify(actual)} rust模板=${JSON.stringify(expect)}`);
  }
}
console.log("对照完成");
