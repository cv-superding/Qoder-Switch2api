/**
 * Qoder-Switch2api 服务入口。
 *  - WebUI API（/api/*）
 *  - 每档位一个 OpenAI/Anthropic 兼容反代（配置启用后启动）
 *  - 自动签到调度
 *  - 生产模式托管 dist/ 静态资源
 */
import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, appendJsonl } from "./store.js";
import { ensureDataDir } from "./paths.js";
import { EDITIONS } from "./editions.js";
import { createApiRouter } from "./routes/api.js";
import { createGateway } from "./proxy/gateway.js";
import { setSwitcherSettings, detectClient } from "./switcher.js";
import { accountManager } from "./qoder/account.js";
import * as info from "./qoder/info.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_PORT = Number(process.env.QODER_SWITCH_PORT || 8787);

/* ---------------- 设置 ---------------- */

function defaultSettings() {
  return {
    theme: "light",
    closeToTray: true,
    clientDirOverrides: { domestic: "", international: "" },
    clientExePaths: { domestic: "", international: "" },
    autoCheckin: { enabled: false, hour: 10 },
    endpointOverrides: { domestic: {}, international: {} },
    proxy: {
      domestic: {
        enabled: false,
        listen: "127.0.0.1:7891",
        apiKey: "",
        extraModels: [],
        accountGroup: "proxy",
      },
      international: {
        enabled: false,
        listen: "127.0.0.1:7892",
        apiKey: "",
        extraModels: [],
        accountGroup: "proxy",
      },
    },
  };
}

let settings = { ...defaultSettings(), ...(loadJson("settings.json", {}) || {}) };
// 深层合并 proxy
settings.proxy = {
  ...defaultSettings().proxy,
  ...(settings.proxy || {}),
  domestic: { ...defaultSettings().proxy.domestic, ...(settings.proxy?.domestic || {}) },
  international: { ...defaultSettings().proxy.international, ...(settings.proxy?.international || {}) },
};
const configuredHour = Number(settings.autoCheckin?.hour);
settings.autoCheckin = {
  enabled: Boolean(settings.autoCheckin?.enabled),
  hour: Number.isFinite(configuredHour) ? Math.max(0, Math.min(23, Math.round(configuredHour))) : 9,
};

setSwitcherSettings(settings);

/** 应用端点覆盖，返回生效的 edition 定义 */
function effectiveEdition(value) {
  const base = EDITIONS[value];
  const override = settings.endpointOverrides?.[value] || {};
  if (!override || Object.keys(override).length === 0) return base;
  const merged = structuredClone(base);
  if (override.clientId) merged.oauth.clientId = override.clientId;
  if (override.openApiBaseUrl) merged.oauth.openApiBaseUrl = override.openApiBaseUrl;
  if (override.streamUrl) merged.legacy.streamUrl = override.streamUrl;
  if (override.modelListUrl) {
    merged.legacy.modelListUrl = override.modelListUrl;
    merged.legacy.modelListFallbacks = [];
  }
  if (override.cloudBaseUrl) merged.cloud.baseUrl = override.cloudBaseUrl;
  return merged;
}

/* ---------------- 反代服务器管理 ---------------- */

const proxyServers = new Map(); // edition -> http.Server
const proxyRuntime = new Map(); // edition -> { signature, error }

function parseListen(listen) {
  const [host, port] = String(listen || "127.0.0.1:7891").split(":");
  return { host: host || "127.0.0.1", port: Number(port) || 7891 };
}

function proxySignature(editionValue) {
  const config = settings.proxy[editionValue] || {};
  return JSON.stringify({
    enabled: Boolean(config.enabled),
    listen: config.listen || "",
    // 网关对象会捕获端点配置，端点覆盖变化时必须重建
    endpoints: settings.endpointOverrides?.[editionValue] || {},
  });
}

function startProxy(editionValue) {
  stopProxy(editionValue);
  const config = settings.proxy[editionValue];
  if (!config?.enabled) return;
  const { host, port } = parseListen(config.listen);
  const runtime = { signature: proxySignature(editionValue), error: "" };
  proxyRuntime.set(editionValue, runtime);
  const app = createGateway(effectiveEdition(editionValue), (v) => settings.proxy[v]);
  const server = http.createServer(app);
  server.on("error", (err) => {
    runtime.error = `${host}:${port} 监听失败：${err.message}`;
    proxyServers.delete(editionValue);
    console.error(`[proxy:${editionValue}] ${runtime.error}`);
    appendJsonl("events.jsonl", { event: "proxy-listen-error", edition: editionValue, listen: config.listen, error: err.message });
  });
  server.listen(port, host, () => {
    runtime.error = "";
    proxyServers.set(editionValue, server);
    console.log(`[proxy:${editionValue}] ${EDITIONS[editionValue].label} 反代已启动 → http://${host}:${port}/v1`);
    appendJsonl("events.jsonl", { event: "proxy-start", edition: editionValue, listen: config.listen });
  });
}

function stopProxy(editionValue) {
  const server = proxyServers.get(editionValue);
  if (server) {
    server.close();
    proxyServers.delete(editionValue);
  }
  proxyRuntime.delete(editionValue);
}

function refreshProxyServers(nextSettings) {
  if (nextSettings) {
    settings = nextSettings;
    setSwitcherSettings(settings);
  }
  for (const value of ["domestic", "international"]) {
    const config = settings.proxy[value] || {};
    const server = proxyServers.get(value);
    const runtime = proxyRuntime.get(value);
    if (config.enabled) {
      // 配置未变化且正在监听时不做任何事，避免每次保存设置都重启反代
      if (server?.listening && runtime?.signature === proxySignature(value)) continue;
      startProxy(value);
    } else {
      stopProxy(value);
    }
  }
}

function proxyStatus(editionValue) {
  const config = settings.proxy[editionValue] || {};
  const server = proxyServers.get(editionValue);
  return {
    enabled: Boolean(config.enabled),
    listen: config.listen,
    running: Boolean(server?.listening),
    hasApiKey: Boolean(config.apiKey),
    extraModels: config.extraModels || [],
    accountGroup: config.accountGroup || "proxy",
    error: proxyRuntime.get(editionValue)?.error || "",
  };
}

/* ---------------- 自动签到 ---------------- */

let lastCheckinDay = "";

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function runAutoCheckin(force = false) {
  if (!settings.autoCheckin?.enabled && !force) return;
  const now = new Date();
  const hour = settings.autoCheckin?.hour ?? 10;
  if (!force && now.getHours() < hour) return;
  const today = localDayKey(now);
  if (!force && lastCheckinDay === today) return;
  const accounts = accountManager.list().filter((a) => a.status !== "disabled");
  let failed = false;
  let pending = 0;
  for (const account of accounts) {
    let full = accountManager.get(account.id);
    // 没有登录凭证或明确失效的账号跳过，避免整点后每 10 分钟重复报同一个错
    if (!full || (!full.securityOauthToken && !full.pat)) continue;
    if (full.status === "needs_relogin" && !full.refreshToken && !full.pat) continue;
    // 自动签到前先尝试续期，避免账号因为 token 过期而一直失败
    const expiresSoon = typeof full.tokenExpireAt === "number" && full.tokenExpireAt < Date.now() + 60000;
    if (full.refreshToken && (full.status === "needs_relogin" || expiresSoon)) {
      if (!(await accountManager.tryRefresh(full.id))) continue;
      full = accountManager.get(full.id);
      if (!full) continue;
    }
    const edition = effectiveEdition(account.edition);
    try {
      const campaigns = await info.listCampaigns(edition, full);
      const claimables = info.findClaimableCheckins(campaigns);
      if (claimables.length === 0) {
        // 10:00（UTC+8）前活动列表可能还没有当日轮次，先不盖章，过一会重试
        if (!info.todayCheckedIn(campaigns)) pending += 1;
        continue;
      }
      let reward = 0;
      let anyClaimed = false;
      let anyReplayed = false;
      for (const claimable of claimables) {
        try {
          const claim = await info.claimCampaign(edition, full, claimable.id);
          if (claim.replayed) anyReplayed = true;
          else anyClaimed = true;
          if (!claim.replayed) {
            const credit = Number(claim.rewardCredit ?? claimable.rewardCredit ?? 0);
            if (Number.isFinite(credit)) reward += credit;
          }
        } catch (e) {
          failed = true;
          appendJsonl("checkin.jsonl", {
            accountId: account.id,
            edition: account.edition,
            result: "error",
            auto: true,
            error: e.message,
          });
        }
      }
      if (anyClaimed || anyReplayed) {
        appendJsonl("checkin.jsonl", {
          accountId: account.id,
          edition: account.edition,
          result: anyClaimed ? "success" : "already",
          auto: true,
          rewardCredit: reward || null,
        });
        console.log(`[auto-checkin] ${account.name || account.email || account.id} ${anyClaimed ? "签到成功" : "今日已签到"}`);
      }
    } catch (e) {
      // 账号没有活动接口（部分版本 404）时按「暂时没有活动」处理，而不是永久失败
      if (/HTTP 404/.test(e.message || "")) {
        pending += 1;
        continue;
      }
      failed = true;
      appendJsonl("checkin.jsonl", {
        accountId: account.id,
        edition: account.edition,
        result: "error",
        auto: true,
        error: e.message,
      });
    }
  }
  // 失败不盖章，下一轮重试；没有活动时最多重试到配置时间后 2 小时再收工
  const graceHour = Math.min(hour + 2, 23);
  if (!failed && (pending === 0 || now.getHours() >= graceHour)) lastCheckinDay = today;
}

function scheduleAutoCheckin() {
  // 每 10 分钟检查一次；错过整点或程序稍晚启动也能在当天补签
  setInterval(() => void runAutoCheckin(), 10 * 60 * 1000);
}

/* ---------------- Web 服务 ---------------- */

ensureDataDir();

const app = express();
app.use(
  "/api",
  createApiRouter({
    getSettings: () => settings,
    getProxyStatus: proxyStatus,
    refreshProxyServers,
    getEdition: effectiveEdition,
    detectClient: (value, s) => detectClient(value, s),
  }),
);

// 生产模式托管前端产物
const distDir = path.resolve(__dirname, "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.type("text/plain").send("Qoder-Switch2api API 已启动。前端尚未构建（npm run build），开发模式请访问 Vite  dev server。");
  });
}

app.listen(WEB_PORT, "127.0.0.1", () => {
  console.log(`Qoder-Switch2api WebUI → http://127.0.0.1:${WEB_PORT}`);
  refreshProxyServers();
  scheduleAutoCheckin();
  void runAutoCheckin();
});

/* 生效 edition 暴露给 api 路由（OAuth / 信息查询用） */
export { effectiveEdition };
