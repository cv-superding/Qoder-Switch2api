/**
 * 检查 GitHub Releases 是否有新版本。
 * 结果在进程内缓存 5 分钟，避免频繁触发 GitHub API 限流。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { fetch as proxyFetch, ProxyAgent } from "undici";
import { dataDir } from "./paths.js";
import { APP_VERSION } from "./version.js";

const REPO = "cv-superding/Qoder-Switch2api";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
// 5 分钟缓存：新版本发布后最多 5 分钟就能被下一次检查看到
const CACHE_MS = 5 * 60 * 1000;

let proxyDispatcher;

function normalizeProxy(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

/** 环境变量优先，其次 Windows 系统代理（很多代理工具只改注册表） */
function detectProxy() {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = process.env[key];
    if (value) return normalizeProxy(value);
  }
  if (process.platform !== "win32") return "";
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enabled = execFileSync("reg", ["query", key, "/v", "ProxyEnable"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!/0x1/i.test(enabled)) return "";
    const output = execFileSync("reg", ["query", key, "/v", "ProxyServer"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const match = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(output);
    if (!match) return "";
    let server = match[1].trim();
    if (server.includes("=")) {
      const parts = Object.fromEntries(
        server
          .split(";")
          .map((item) => item.split("="))
          .filter((pair) => pair.length === 2),
      );
      server = parts.https || parts.http || "";
    }
    return normalizeProxy(server);
  } catch {
    return "";
  }
}

/** 更新相关请求统一走系统代理（直连失败时才能下载 GitHub Release 资产） */
function updateFetch(url, options = {}) {
  const proxy = detectProxy();
  if (proxy) {
    proxyDispatcher ??= new ProxyAgent(proxy);
    return proxyFetch(url, { ...options, dispatcher: proxyDispatcher });
  }
  return proxyFetch(url, options);
}

async function requestJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await updateFetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 保留 text */
    }
    return { status: resp.status, ok: resp.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

let cache = { at: 0, data: null };

function parseVersion(raw) {
  const parts = String(raw || "")
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function normalize(release) {
  const tag = String(release?.tag_name || "");
  const latestVersion = tag.replace(/^v/i, "");
  const assets = Array.isArray(release?.assets)
    ? release.assets.map((asset) => ({
        name: String(asset.name || ""),
        url: String(asset.browser_download_url || ""),
        size: Number(asset.size) || 0,
        digest: String(asset.digest || ""),
      }))
    : [];
  const exe =
    assets.find((asset) => asset.name === "qoder-switch2api.exe") ||
    assets.find((asset) => asset.name.toLowerCase().endsWith(".exe"));
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    hasUpdate: Boolean(latestVersion) && compareVersions(latestVersion, APP_VERSION) > 0,
    releaseUrl: String(release?.html_url || `https://github.com/${REPO}/releases/latest`),
    downloadUrl: exe?.url || "",
    digest: exe?.digest || "",
    releaseName: String(release?.name || tag),
    publishedAt: release?.published_at || null,
    notes: String(release?.body || "").slice(0, 2000),
  };
}

/**
 * GitHub API 限流 / 不可用时的兜底：访问 releases/latest，跟随重定向后从最终 URL 取 tag。
 * 不依赖 API 配额，适合频繁检查。
 */
async function checkViaHtml() {
  const resp = await updateFetch(LATEST_URL, {
    redirect: "follow",
    headers: { "user-agent": "Qoder-Switch2api-update-check" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Releases 页面 HTTP ${resp.status}`);
  const finalUrl = resp.url || "";
  const match = /\/releases\/tag\/([^/?#]+)/.exec(finalUrl);
  if (!match) throw new Error("无法从 Releases 页面解析最新版本");
  const tag = decodeURIComponent(match[1]);
  const latestVersion = tag.replace(/^v/i, "");
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    hasUpdate: Boolean(latestVersion) && compareVersions(latestVersion, APP_VERSION) > 0,
    releaseUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    downloadUrl: `https://github.com/${REPO}/releases/download/${tag}/qoder-switch2api.exe`,
    digest: "",
    releaseName: tag,
    publishedAt: null,
    notes: "",
  };
}

export async function checkUpdate({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  let data = null;
  try {
    const result = await requestJson(API_URL, {
      accept: "application/vnd.github+json",
      "user-agent": "Qoder-Switch2api-update-check",
    }, 15000);
    if (!result.ok) {
      throw new Error(`更新检查 HTTP ${result.status}: ${(result.text || "").slice(0, 200)}`);
    }
    data = normalize(result.json || {});
    if (!data.latestVersion) throw new Error("GitHub Releases 响应缺少版本号");
  } catch (apiError) {
    try {
      data = await checkViaHtml();
    } catch (htmlError) {
      throw new Error(`${apiError.message}；Releases 页面兜底也失败：${htmlError.message}`);
    }
  }
  cache = { at: Date.now(), data };
  return data;
}

/* ------------------------------------------------------------------ */
/* 内置下载                                                            */
/* ------------------------------------------------------------------ */

const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

let downloadState = {
  state: "idle",
  downloaded: 0,
  total: 0,
  percent: 0,
  path: "",
  error: "",
  version: "",
};

export function getDownloadStatus() {
  return { ...downloadState };
}

export async function startDownload() {
  if (downloadState.state === "downloading") return getDownloadStatus();
  const info = await checkUpdate();
  if (!info.hasUpdate) throw new Error("当前已是最新版本");
  if (!info.downloadUrl || !info.downloadUrl.startsWith(DOWNLOAD_PREFIX)) {
    throw new Error("没有可用的更新下载地址");
  }
  const dir = path.join(dataDir(), "updates");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".exe")) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* 旧文件可能仍被占用 */
      }
    }
  }
  const file = path.join(dir, `qoder-switch2api-${info.latestVersion}-${Date.now()}.exe`);
  downloadState = {
    state: "downloading",
    downloaded: 0,
    total: 0,
    percent: 0,
    path: file,
    error: "",
    version: info.latestVersion,
  };

  void (async () => {
    const mirrors = info.digest ? ["https://gh-proxy.com/", "https://ghfast.top/"] : [];
    const candidates = [info.downloadUrl, ...mirrors.map((mirror) => `${mirror}${info.downloadUrl}`)];
    const expected = String(info.digest || "").replace(/^sha256:/i, "").toLowerCase();
    let lastError = "";
    for (const url of candidates) {
      let stream = null;
      try {
        downloadState.downloaded = 0;
        downloadState.total = 0;
        downloadState.percent = 0;
        const resp = await updateFetch(url, {
          redirect: "follow",
          headers: { "user-agent": "Qoder-Switch2api-updater" },
          signal: AbortSignal.timeout(10 * 60 * 1000),
        });
        if (!resp.ok || !resp.body) throw new Error(`下载失败：HTTP ${resp.status}`);
        const total = Number(resp.headers.get("content-length")) || 0;
        downloadState.total = total;
        stream = fs.createWriteStream(file);
        const hash = crypto.createHash("sha256");
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          hash.update(chunk);
          downloadState.downloaded += chunk.length;
          downloadState.percent = total > 0 ? Math.min(99.9, (downloadState.downloaded / total) * 100) : 0;
          if (!stream.write(chunk)) await once(stream, "drain");
        }
        await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())));
        stream = null;
        const size = fs.statSync(file).size;
        if (size < 1024 * 1024) throw new Error(`下载文件不完整（${size} 字节）`);
        if (expected && hash.digest("hex") !== expected) throw new Error("更新包 SHA-256 校验失败");
        downloadState.state = "done";
        downloadState.downloaded = size;
        downloadState.total = size;
        downloadState.percent = 100;
        return;
      } catch (e) {
        lastError = e.message;
        try {
          stream?.destroy();
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    }
    downloadState.state = "error";
    downloadState.error = lastError || "下载失败";
  })();

  return getDownloadStatus();
}

export function installDownloadedUpdate() {
  if (downloadState.state !== "done" || !downloadState.path || !fs.existsSync(downloadState.path)) {
    throw new Error("更新尚未下载完成");
  }
  throw new Error(`独立服务模式不支持自动替换程序，请手动运行已下载的更新：${downloadState.path}`);
}
