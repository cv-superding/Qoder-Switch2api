/**
 * 共享 HTTP 工具：JSON 请求、SSE 行读取。
 */
import fs from "node:fs";

export async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...headers },
      body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 保留 text 供错误展示 */
    }
    return { status: resp.status, ok: resp.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 打开 SSE 流，返回 { response, nextLine }。
 * nextLine() 返回一行（不含 \n）或 null（流结束）。
 */
export async function openSse(url, { method = "POST", headers = {}, body, timeoutMs = 0 } = {}) {
  const controller = new AbortController();
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        "cache-control": "no-cache",
        accept: "text/event-stream",
        "accept-encoding": "identity",
        ...headers,
      },
      body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    throw e;
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    if (timer) clearTimeout(timer);
    throw new Error(`上游 HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    response: resp,
    async nextLine() {
      for (;;) {
        const idx = buffer.indexOf("\n");
        if (idx >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          return line;
        }
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.length > 0) {
            const last = buffer;
            buffer = "";
            return last;
          }
          return null;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    close() {
      if (timer) clearTimeout(timer);
      reader.cancel().catch(() => {});
    },
  };
}

/** 把 SSE data 行解析为 Delta 事件（OpenAI chunk 风格） */
export function parseSseData(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  return trimmed.slice(5).trim();
}

export function readTextFile(file) {
  return fs.readFileSync(file, "utf8");
}
