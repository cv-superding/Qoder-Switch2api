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
import { loadJson, saveJson, appendJsonl } from "./store.js";
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
    clientDirOverrides: { domestic: "", international: "" },
    clientExePaths: { domestic: "", international: "" },
    autoCheckin: { enabled: false, hour: 9 },
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
  if (override.modelListUrl) merged.legacy.modelListUrl = override.modelListUrl;
  if (override.cloudBaseUrl) merged.cloud.baseUrl = override.cloudBaseUrl;
  return merged;
}

/* ---------------- 反代服务器管理 ---------------- */

const proxyServers = new Map(); // edition -> http.Server

function parseListen(listen) {
  const [host, port] = String(listen || "127.0.0.1:7891").split(":");
  return { host: host || "127.0.0.1", port: Number(port) || 7891 };
}

function startProxy(editionValue) {
  stopProxy(editionValue);
  const config = settings.proxy[editionValue];
  if (!config?.enabled) return;
  const { host, port } = parseListen(config.listen);
  const app = createGateway(effectiveEdition(editionValue), (v) => settings.proxy[v]);
  const server = http.createServer(app);
  server.on("error", (err) => {
    console.error(`[proxy:${editionValue}] 监听失败 ${host}:${port} — ${err.message}`);
    appendJsonl("events.jsonl", { event: "proxy-listen-error", edition: editionValue, listen: config.listen, error: err.message });
  });
  server.listen(port, host, () => {
    console.log(`[proxy:${editionValue}] ${EDITIONS[editionValue].label} 反代已启动 → http://${host}:${port}/v1`);
    appendJsonl("events.jsonl", { event: "proxy-start", edition: editionValue, listen: config.listen });
  });
  proxyServers.set(editionValue, server);
}

function stopProxy(editionValue) {
  const server = proxyServers.get(editionValue);
  if (server) {
    server.close();
    proxyServers.delete(editionValue);
  }
}

function refreshProxyServers(nextSettings) {
  if (nextSettings) {
    settings = nextSettings;
    setSwitcherSettings(settings);
  }
  for (const value of ["domestic", "international"]) {
    if (settings.proxy[value]?.enabled) startProxy(value);
    else stopProxy(value);
  }
}

function proxyStatus(editionValue) {
  const config = settings.proxy[editionValue] || {};
  return {
    enabled: Boolean(config.enabled),
    listen: config.listen,
    running: proxyServers.has(editionValue),
    hasApiKey: Boolean(config.apiKey),
    extraModels: config.extraModels || [],
  };
}

/* ---------------- 自动签到 ---------------- */

let lastCheckinDay = "";
async function runAutoCheckin(force = false) {
  if (!settings.autoCheckin?.enabled && !force) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!force && lastCheckinDay === today) return;
  lastCheckinDay = today;
  const accounts = accountManager.list().filter((a) => a.status !== "disabled");
  for (const account of accounts) {
    const edition = effectiveEdition(account.edition);
    const full = accountManager.get(account.id);
    try {
      const campaigns = await info.listCampaigns(edition, full);
      if (info.todayCheckedIn(campaigns)) continue;
      const claimable = info.findClaimableCheckin(campaigns);
      if (!claimable) continue;
      await info.claimCampaign(edition, full, claimable.id);
      appendJsonl("checkin.jsonl", {
        accountId: account.id,
        edition: account.edition,
        result: "success",
        auto: true,
        rewardCredit: claimable.rewardCredit ?? null,
      });
      console.log(`[auto-checkin] ${account.name || account.email || account.id} 签到成功`);
    } catch (e) {
      appendJsonl("checkin.jsonl", {
        accountId: account.id,
        edition: account.edition,
        result: "error",
        auto: true,
        error: e.message,
      });
    }
  }
}

function scheduleAutoCheckin() {
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === (settings.autoCheckin?.hour ?? 9)) void runAutoCheckin();
  }, 30 * 60 * 1000);
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
  // 启动时补一次签到（距上次超过 20 小时）
  const last = loadJson("checkin-state.json", {}) || {};
  if (!last.at || Date.now() - last.at > 20 * 3600 * 1000) {
    saveJson("checkin-state.json", { at: Date.now() });
    void runAutoCheckin();
  }
});

/* 生效 edition 暴露给 api 路由（OAuth / 信息查询用） */
export { effectiveEdition };
