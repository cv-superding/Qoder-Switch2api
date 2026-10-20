/**
 * 检查 GitHub Releases 是否有新版本。
 * 结果在进程内缓存 30 分钟，避免频繁触发 GitHub API 限流。
 */
import { fetchJson } from "./http.js";
import { APP_VERSION } from "./version.js";

const REPO = "cv-superding/Qoder-Switch2api";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
// 5 分钟缓存：新版本发布后最多 5 分钟就能被下一次检查看到
const CACHE_MS = 5 * 60 * 1000;

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
  const resp = await fetch(LATEST_URL, {
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
    releaseName: tag,
    publishedAt: null,
    notes: "",
  };
}

export async function checkUpdate({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  let data = null;
  try {
    const result = await fetchJson(API_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Qoder-Switch2api-update-check",
      },
      timeoutMs: 15000,
    });
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
