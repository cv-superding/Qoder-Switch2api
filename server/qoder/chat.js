/**
 * Qoder 双后端聊天：
 *  - legacy：IDE 登录态（securityOauthToken）走 Cosy 签名的 SSE 流式接口
 *    （复刻自 qoder2api/internal/qoder/legacy.go）
 *  - cloud：PAT 走 Cloud Agents API（复刻自 internal/qoder/cloud.go 与
 *    Qoder 官方 Cloud Agents 文档）
 *
 * 统一产出归一化事件：
 *  { type: "content" | "reasoning" | "tool_calls" | "usage" | "done" | "error", ... }
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fetchJson, openSse } from "../http.js";
import { buildLegacyStreamHeaders, legacyEncode } from "./cosy.js";

/* ================================================================= */
/* 公共工具                                                            */
/* ================================================================= */

function uuid() {
  return randomUUID();
}

function normalizeModelKey(model) {
  const normalized = (model || "").toLowerCase().trim();
  switch (normalized) {
    case "":
    case "auto":
    case "default":
      return "auto";
    case "lite":
      return "lite";
    case "claude-sonnet-4.5":
    case "claude_sonnet_4_5":
    case "sonnet":
    case "claude":
      return "auto";
    default:
      return (model || "").trim();
  }
}

function latestPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i].role || "").trim() !== "user") continue;
    const text = normalizeContent(messages[i].content);
    if (text.trim()) return text;
  }
  return "";
}

function normalizeContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object" && item.type === "text") parts.push(item.text || "");
      else if (item && typeof item === "object" && item.type === "image_url") {
        const url = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
        if (url) parts.push(`[image] ${url}`);
      }
    }
    return parts.join("\n");
  }
  const text = JSON.stringify(content);
  return typeof text === "string" ? text : "";
}

function reasoningEnabled(req) {
  const effort = (req.reasoningEffort || "").toLowerCase().trim();
  return Boolean(effort) || req.thinkingType === "enabled" || req.thinkingType === "adaptive";
}

function normalizeReasoningEffort(raw) {
  switch ((raw || "").toLowerCase().trim()) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "max";
    default:
      return "";
  }
}

function budgetToEffort(budget) {
  if (!budget || budget <= 0) return "medium";
  if (budget <= 4000) return "low";
  if (budget <= 12000) return "medium";
  if (budget <= 24000) return "high";
  return "max";
}

function maxTokensForEffort(effort) {
  switch (effort) {
    case "low":
      return 8192;
    case "medium":
      return 16384;
    case "high":
      return 24576;
    default:
      return 32768;
  }
}

/* ================================================================= */
/* legacy 后端（IDE 登录态 + Cosy 签名）                                */
/* ================================================================= */

function newLegacyTemplate() {
  return {
    request_id: uuid(),
    // 注意：不要携带 request_set_id —— 国内版网关（gateway.qoder.com.cn）实测会挂起不返回。
    // 国际版 api3.qoder.sh 未验证该字段必要性，统一不带。
    chat_record_id: uuid(),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      chatPrompt: "",
      extra: {
        context: [],
        modelConfig: { is_reasoning: false, key: "auto" },
        originalContent: { type: "text", text: "" },
      },
      features: [],
      imageUrls: null,
      text: { type: "text", text: "" },
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    session_id: uuid(),
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
      id: uuid(),
      begin_at: Date.now(),
      scene: "chat",
      type: "chat",
      sub_type: "free_input",
      name: "",
      language: "",
      parent_type: "",
    },
    messages: [],
    tools: defaultTools(),
  };
}

function defaultTools() {
  return [
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read a local file or image attachment referenced in the conversation.",
        parameters: {
          type: "object",
          properties: { file_path: { type: "string", description: "Path of the file to read." } },
          required: ["file_path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "Bash",
        description: "Execute a shell command when the client allows command execution.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "The command to execute." } },
          required: ["command"],
        },
      },
    },
  ];
}

function legacyMessages(messages) {
  const out = [];
  for (const message of messages) {
    const role = (message.role || "user").trim() || "user";
    if (role === "user") {
      const contents = legacyUserContents(message.content);
      if (contents.length === 0) continue;
      out.push({
        role: "user",
        content: "",
        contents,
        response_meta: { id: "", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
        reasoning_content_signature: "",
      });
    } else if (role === "assistant") {
      const entry = { role: "assistant", content: normalizeContent(message.content) };
      if (message.tool_calls && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) {
        entry.tool_calls = message.tool_calls;
      }
      if (!String(entry.content || "").trim() && !entry.tool_calls) continue;
      out.push(entry);
    } else if (role === "tool") {
      const text = normalizeContent(message.content);
      if (!text.trim()) continue;
      out.push({ role: "tool", tool_call_id: message.tool_call_id || "", content: text });
    } else {
      const text = normalizeContent(message.content);
      if (!text.trim()) continue;
      out.push({ role, content: text });
    }
  }
  return out;
}

function legacyUserContents(content) {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    const out = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text") {
        if ((part.text || "").trim()) out.push({ type: "text", text: part.text });
      } else if (part.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (url) out.push({ type: "image_url", image_url: { url } });
      }
    }
    if (out.length > 0) return out;
    const text = normalizeContent(content);
    return text.trim() ? [{ type: "text", text }] : [];
  }
  const text = normalizeContent(content);
  return text.trim() ? [{ type: "text", text }] : [];
}

function buildLegacyRequest(req) {
  const body = newLegacyTemplate();
  const requestId = uuid();
  body.request_id = requestId;
  body.chat_record_id = requestId;
  body.session_id = uuid();
  body.stream = true;
  body.aliyun_user_type = req.account.userType || "personal_standard";

  const modelKey = normalizeModelKey(req.model);
  const isReasoning = reasoningEnabled(req);
  const isVl = (req.imageUrls || []).length > 0;
  body.model_config.key = modelKey;
  body.model_config.is_reasoning = isReasoning;
  body.model_config.is_vl = isVl;
  body.chat_context.extra.modelConfig.key = modelKey;
  body.chat_context.extra.modelConfig.is_reasoning = isReasoning;
  body.chat_context.extra.modelConfig.is_vl = isVl;

  body.business.id = uuid();
  body.business.begin_at = Date.now();
  const prompt = latestPrompt(req.messages);
  body.business.name = prompt.length > 30 ? prompt.slice(0, 30) : prompt;

  body.chat_context.text.text = prompt;
  body.chat_context.extra.originalContent.text = prompt;
  if (isVl) body.chat_context.imageUrls = req.imageUrls;
  if (isVl) body.image_urls = req.imageUrls;

  // reasoning 参数
  let effort = normalizeReasoningEffort(req.reasoningEffort);
  if (!effort && isReasoning) effort = budgetToEffort(req.thinkingBudget);
  if (effort) {
    body.parameters.reasoning_effort = effort;
    body.parameters.max_tokens = Math.max(body.parameters.max_tokens || 0, maxTokensForEffort(effort));
  }

  body.messages = legacyMessages(req.messages);
  if (req.tools && Object.keys(req.tools).length > 0) {
    body.tools = Array.isArray(req.tools) ? req.tools : [req.tools];
  } else if (isVl) {
    // 带图片时保留默认工具（Read/Bash），与 qoder2api 行为一致
  } else {
    body.tools = [];
  }
  return body;
}

/** 解析 legacy SSE 的一行 data（{body: <openai chunk>}） */
function parseLegacyLine(dataLine) {
  if (!dataLine || dataLine === "[DONE]") return null;
  let envelope;
  try {
    envelope = JSON.parse(dataLine);
  } catch {
    return null;
  }

  let chunk = null;
  if (typeof envelope?.body === "string") {
    try {
      chunk = JSON.parse(envelope.body);
    } catch {
      chunk = null;
    }
  } else if (envelope?.body && typeof envelope.body === "object") {
    chunk = envelope.body;
  }

  const statusCode = Number(envelope?.statusCodeValue ?? envelope?.statusCode ?? envelope?.status ?? 0);
  const chunkError =
    chunk?.error?.message ||
    (typeof chunk?.error === "string" ? chunk.error : "") ||
    envelope?.error?.message ||
    (typeof envelope?.error === "string" ? envelope.error : "");
  const failed = (Number.isFinite(statusCode) && statusCode >= 400) || Boolean(chunkError);
  if (failed) {
    const detail = chunkError || chunk?.message || envelope?.message || envelope?.headers?.["error"] || "";
    const suffix = detail ? `: ${String(detail).slice(0, 300)}` : "";
    return [{ type: "error", error: `上游 HTTP ${statusCode >= 400 ? statusCode : "?"}${suffix}` }];
  }
  if (!chunk) return null;
  const events = [];
  for (const choice of chunk.choices || []) {
    const delta = choice.delta || {};
    if (delta.content) events.push({ type: "content", text: delta.content });
    if (delta.reasoning_content) events.push({ type: "reasoning", text: delta.reasoning_content });
    if (delta.tool_calls && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0)) {
      events.push({ type: "tool_calls", toolCalls: delta.tool_calls });
    }
  }
  if (chunk.usage) {
    events.push({
      type: "usage",
      usage: {
        promptTokens: chunk.usage.prompt_tokens || 0,
        completionTokens: chunk.usage.completion_tokens || 0,
        totalTokens: chunk.usage.total_tokens || 0,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens || 0,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
      },
    });
  }
  return events.length > 0 ? events : null;
}

async function* legacyStream(req) {
  const { account, edition } = req;
  const body = buildLegacyRequest(req);
  if (process.env.QODER_DEBUG_DUMP) {
    fs.writeFileSync(process.env.QODER_DEBUG_DUMP, JSON.stringify(body, null, 2), "utf8");
  }
  const encoded = legacyEncode(JSON.stringify(body));
  const headers = buildLegacyStreamHeaders({
    account,
    edition,
    requestPath: edition.legacy.streamPath,
    requestBody: encoded,
  });
  headers["content-type"] = "application/json";
  headers["user-agent"] = "Qoder-Switch2api/1.1";
  headers["x-model-key"] = normalizeModelKey(req.model);
  headers["x-model-source"] = "system";

  const sse = await openSse(edition.legacy.streamUrl, {
    method: "POST",
    headers,
    body: encoded,
    idleTimeoutMs: req.timeoutMs || 300000,
  });
  let sawDone = false;
  try {
    for (;;) {
      const line = await sse.nextLine();
      if (line == null) break;
      const data = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : null;
      if (!data) continue;
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      const events = parseLegacyLine(data);
      if (events) {
        for (const event of events) yield event;
      }
    }
    if (!sawDone) {
      yield { type: "error", error: "上游连接提前结束（未收到 [DONE]），响应可能不完整" };
      return;
    }
    yield { type: "done" };
  } catch (e) {
    yield { type: "error", error: String(e.message || e) };
  } finally {
    sse.close();
  }
}

/* ================================================================= */
/* cloud 后端（PAT / Cloud Agents）                                    */
/* ================================================================= */

class CloudSession {
  constructor(baseUrl, pat, defaultModel, workspaceRoot) {
    this.baseUrl = `${baseUrl.replace(/\/+$/, "")}/api/v1/cloud`;
    this.pat = pat;
    this.defaultModel = defaultModel || "auto";
    this.workspaceRoot = workspaceRoot || "";
    this.environmentId = "";
    this.agentId = "";
  }

  async get(path, out) {
    const result = await fetchJson(this.baseUrl + path, {
      headers: { Authorization: `Bearer ${this.pat}` },
      timeoutMs: 30000,
    });
    if (!result.ok) throw new Error(`GET ${path} HTTP ${result.status}: ${(result.text || "").slice(0, 300)}`);
    return out ? result.json : null;
  }

  async post(path, body, out) {
    const result = await fetchJson(this.baseUrl + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.pat}`, "Content-Type": "application/json" },
      body,
      timeoutMs: 60000,
    });
    if (!result.ok) throw new Error(`POST ${path} HTTP ${result.status}: ${(result.text || "").slice(0, 300)}`);
    return out ? result.json : null;
  }

  async ensureEnvironment() {
    if (this.environmentId) return;
    const list = await this.get("/environments", true);
    for (const env of list?.data || []) {
      if (!env.status || env.status === "ready") {
        this.environmentId = env.id;
        return;
      }
    }
    const created = await this.post(
      "/environments",
      {
        name: "qoder-switch2api-default",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      },
      true,
    );
    this.environmentId = created?.id || "";
    if (!this.environmentId) throw new Error("创建 Cloud 环境失败：响应缺少 id");
  }

  async ensureAgent(model) {
    if (this.agentId) return;
    const instructions = [
      "You are an efficient programming assistant.",
      "Reply concisely and correctly.",
      "When the user supplies chat history, treat the provided transcript as authoritative context.",
      "If the task is coding-related, prefer concrete patches, commands, and implementation details.",
    ].join("\n");
    const created = await this.post(
      "/agents",
      {
        name: "qoder-switch2api-bridge",
        model: model || this.defaultModel,
        system: instructions,
        tools: [{ type: "bash_20250124" }, { type: "text_editor_20250124" }],
      },
      true,
    );
    this.agentId = created?.id || "";
    if (!this.agentId) throw new Error("创建 Cloud Agent 失败：响应缺少 id");
  }

  async createSession() {
    const body = { agent: this.agentId, environment_id: this.environmentId };
    if (this.workspaceRoot) body.metadata = { workspace_root: this.workspaceRoot };
    const created = await this.post("/sessions", body, true);
    return created?.id || "";
  }

  async sendMessage(sessionId, req) {
    return this.post(`/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: renderPrompt(req) }],
    });
  }

  openStream(sessionId, timeoutMs) {
    return openSse(`${this.baseUrl}/sessions/${sessionId}/events/stream`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.pat}` },
      idleTimeoutMs: timeoutMs || 300000,
    });
  }
}

function renderPrompt(req) {
  const lines = [
    "You are handling an OpenAI-style chat completion request.",
    "Conversation transcript:",
  ];
  for (const msg of req.messages) {
    const role = (msg.role || "user").trim() || "user";
    lines.push("", `[${role}]`, normalizeContent(msg.content), "");
  }
  if (req.tools && Object.keys(req.tools).length > 0) {
    lines.push("Available tool schema from the caller:");
    lines.push(JSON.stringify(req.tools));
    lines.push("If tool use is necessary, emit structured tool-use actions when supported by the runtime.");
  }
  lines.push("Respond to the latest user request using the transcript above.");
  return lines.join("\n");
}

function normalizeCloudContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object" && item.type === "text") parts.push(item.text || "");
    }
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}

async function* cloudStream(req) {
  const { account, edition } = req;
  const session = new CloudSession(
    edition.cloud.baseUrl,
    account.pat,
    req.model || "auto",
    req.workspaceRoot || "",
  );
  await session.ensureEnvironment();
  await session.ensureAgent(req.model);
  const sessionId = await session.createSession();
  if (!sessionId) throw new Error("创建 Cloud Session 失败");
  await session.sendMessage(sessionId, req);

  const sse = await session.openStream(sessionId, req.timeoutMs);
  let eventType = "";
  let dataLine = "";
  let sawTerminal = false;
  try {
    for (;;) {
      const line = await sse.nextLine();
      if (line == null) break;
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLine = line.slice(5).trim();
        continue;
      }
      if (line.trim() === "" && (eventType || dataLine)) {
        let payload = {};
        if (dataLine && dataLine !== "{}") {
          try {
            payload = JSON.parse(dataLine);
          } catch {
            payload = {};
          }
        }
        if (eventType === "session.status_idle" || eventType === "terminated") {
          sawTerminal = true;
          yield { type: "done" };
          return;
        }
        if (eventType === "session.error") {
          yield { type: "error", error: `session error: ${dataLine}` };
          return;
        }
        if (eventType === "agent.message") {
          const text = normalizeCloudContent(payload.content);
          if (text) yield { type: "content", text };
        } else if (eventType === "agent.tool_use") {
          yield {
            type: "tool_calls",
            toolCalls: [
              {
                id: `call_${Math.random().toString(16).slice(2, 14)}`,
                type: "function",
                function: {
                  name: payload.name || "",
                  arguments: JSON.stringify(payload.input ?? {}),
                },
              },
            ],
          };
        }
        eventType = "";
        dataLine = "";
      }
    }
    if (!sawTerminal) {
      yield { type: "error", error: "上游会话提前结束，响应可能不完整" };
      return;
    }
    yield { type: "done" };
  } catch (e) {
    yield { type: "error", error: String(e.message || e) };
  } finally {
    sse.close();
  }
}

/* ================================================================= */
/* 统一入口                                                            */
/* ================================================================= */

/**
 * 根据账号类型选择后端，产出归一化事件流。
 * @param {object} req { account, edition, model, messages, tools, reasoningEffort,
 *                        thinkingType, thinkingBudget, imageUrls, workspaceRoot, timeoutMs }
 */
export async function* streamChat(req) {
  if (!req.account) throw new Error("缺少账号");
  if (req.account.pat) {
    yield* cloudStream(req);
  } else if (req.account.securityOauthToken) {
    yield* legacyStream(req);
  } else {
    throw new Error("账号既没有 PAT 也没有登录 token，请重新登录或导入");
  }
}

/** 非流式：聚合流式事件 */
export async function completeChat(req) {
  let content = "";
  let reasoning = "";
  let toolCalls = [];
  let usage = null;
  for await (const event of streamChat(req)) {
    if (event.type === "content") content += event.text;
    else if (event.type === "reasoning") reasoning += event.text;
    else if (event.type === "tool_calls") toolCalls = mergeToolCalls(toolCalls, event.toolCalls);
    else if (event.type === "usage") usage = event.usage;
    else if (event.type === "error") throw new Error(event.error);
  }
  return { content, reasoning, toolCalls, usage };
}

function mergeToolCalls(acc, incoming) {
  const list = Array.isArray(acc) ? [...acc] : [];
  const items = Array.isArray(incoming) ? incoming : [incoming];
  for (const call of items) {
    const index = call.index ?? list.length;
    while (list.length <= index) list.push({ index: list.length, id: "", type: "function", function: { name: "", arguments: "" } });
    const target = list[index];
    if (call.id) target.id = call.id;
    if (call.type) target.type = call.type;
    if (call.function?.name) target.function.name = call.function.name;
    if (call.function?.arguments) target.function.arguments += call.function.arguments;
  }
  return list;
}

export { normalizeModelKey };
