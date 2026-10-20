/**
 * WebUI 后端 API（/api/*）。
 */
import express from "express";
import { execFile } from "node:child_process";
import { accountManager } from "../qoder/account.js";
import { EDITIONS, accountGroupLabel } from "../editions.js";
import * as oauth from "../qoder/oauth.js";
import * as info from "../qoder/info.js";
import * as switcher from "../switcher.js";
import * as sessions from "../sessions.js";
import { resolveClientDir } from "../paths.js";
import { usageStats } from "../proxy/usage.js";
import { loadJson, saveJson, appendJsonl, readJsonl } from "../store.js";
import { randomId } from "../crypto.js";
import { APP_NAME, APP_VERSION } from "../version.js";
import { checkUpdate, getDownloadStatus, installDownloadedUpdate, startDownload } from "../update.js";

export function createApiRouter({ getSettings, getProxyStatus, refreshProxyServers, getEdition, detectClient }) {
  const router = express.Router();
  router.use(express.json({ limit: "8mb" }));

  /* ---------------- 状态 ---------------- */
  router.get("/status", async (req, res) => {
    const settings = getSettings();
    const counts = accountManager.counts();
    const editions = {};
    for (const value of ["domestic", "international"]) {
      const client = await detectClient(value, settings).catch(() => null);
      const current = accountManager.getClientCurrent(value);
      editions[value] = {
        client,
        currentAccount: current,
        proxy: getProxyStatus(value),
        accounts: counts[value],
        proxyAccounts: value === "domestic" ? counts.proxyDomestic : counts.proxyInternational,
      };
    }
    res.json({
      version: APP_VERSION,
      editions,
      counts,
      sqlite: switcher.sqliteAvailable(),
    });
  });

  /* ---------------- 账号 ---------------- */
  router.get("/accounts", (req, res) => {
    const edition = req.query.edition;
    res.json({ accounts: accountManager.list(edition) });
  });

  router.post("/accounts", (req, res) => {
    try {
      const account = accountManager.add(req.body || {});
      res.json({ account: accountManager.publicView(account) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /** 导出账号备份；includeTokens 时包含完整登录态（敏感，仅本机使用） */
  router.post("/accounts/export", (req, res) => {
    const includeTokens = Boolean(req.body?.includeTokens);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    const accounts = accountManager.exportList({ includeTokens, ids });
    res.json({
      app: "qoder-switch2api",
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      includesTokens: includeTokens,
      accounts,
    });
  });

  /** 从备份导入账号；包含登录态的条目可直接使用，否则需重新登录 */
  router.post("/accounts/import", (req, res) => {
    const list = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
    if (list.length === 0) return res.status(400).json({ error: "备份中没有可导入的账号" });
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i] || {};
      try {
        accountManager.add(
          {
            ...item,
            authSource: item.authSource || "backup",
          },
          { allowEmpty: true },
        );
        imported += 1;
      } catch (e) {
        skipped.push({ index: i, name: item.name || item.email || item.uid || "", error: e.message });
      }
    }
    res.json({ imported, skipped });
  });

  router.patch("/api-account/:id", (req, res) => {
    try {
      const account = accountManager.update(req.params.id, req.body || {});
      res.json({ account: accountManager.publicView(account) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/accounts/:id", (req, res) => {
    const ok = accountManager.remove(req.params.id);
    res.json({ ok });
  });

  router.post("/accounts/:id/refresh", async (req, res) => {
    const account = accountManager.get(req.params.id);
    if (!account) return res.status(404).json({ error: "账号不存在" });
    const ok = await accountManager.tryRefresh(account.id);
    if (ok) {
      res.json({ ok: true, account: accountManager.publicView(accountManager.get(account.id)) });
    } else {
      res.status(400).json({ error: account.lastError || "刷新失败，可能需要重新登录" });
    }
  });

  /** 从本机客户端导入当前登录账号 */
  router.post("/accounts/import-client", async (req, res) => {
    const editionValue = req.body?.edition === "international" ? "international" : "domestic";
    const settings = getSettings();
    try {
      const auth = await switcher.readClientAuth(editionValue, settings);
      if (!auth || !auth.token) {
        return res.status(404).json({ error: "未检测到本机 Qoder 客户端登录态（请先打开客户端登录）" });
      }
      const account = accountManager.add({
        edition: editionValue,
        uid: auth.user?.id || "",
        name: auth.user?.name || "",
        email: auth.user?.email || "",
        phone: auth.user?.phone || "",
        securityOauthToken: auth.token,
        refreshToken: auth.refreshToken,
        tokenExpireAt: auth.expiresAt,
        refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
        machineId: auth.machineId,
        authSource: "client-import",
      });
      accountManager.setClientCurrent(editionValue, {
        uid: account.uid,
        name: account.name,
        email: account.email,
        id: account.id,
      });
      res.json({ account: accountManager.publicView(account), source: auth.source });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------------- OAuth 登录 ---------------- */
  /** 用系统默认浏览器打开授权链接（桌面窗口内 window.open 不可用） */
  router.post("/oauth/open-url", (req, res) => {
    const url = String(req.body?.url || "");
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "仅支持 http(s) 链接" });
    const command =
      process.platform === "win32"
        ? { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
        : process.platform === "darwin"
          ? { file: "open", args: [url] }
          : { file: "xdg-open", args: [url] };
    execFile(command.file, command.args, { windowsHide: true }, (error) => {
      if (error) return res.status(500).json({ error: `打开浏览器失败: ${error.message}` });
      res.json({ ok: true });
    });
  });

  router.post("/oauth/start", (req, res) => {
    const editionValue = req.body?.edition === "international" ? "international" : "domestic";
    const edition = getEdition(editionValue);
    const settings = getSettings();
    // 未配置覆盖时也使用自动探测到的客户端目录，复用其 machine_id / machine_token
    const clientDir =
      settings.clientDirOverrides?.[editionValue] || resolveClientDir(edition);
    const result = oauth.startLogin(edition, clientDir);
    res.json(result);
  });

  router.get("/oauth/poll/:loginId", async (req, res) => {
    const result = await oauth.pollLogin(req.params.loginId);
    if (result.status === "done") {
      try {
        const account = accountManager.add({ ...result.account, edition: result.account.edition || "domestic" });
        res.json({ status: "done", account: accountManager.publicView(account) });
      } catch (e) {
        res.json({ status: "error", error: e.message });
      }
    } else {
      res.json(result);
    }
  });

  router.post("/oauth/cancel/:loginId", (req, res) => {
    oauth.cancelLogin(req.params.loginId);
    res.json({ ok: true });
  });

  /* ---------------- 积分 / 签到 ---------------- */
  router.get("/accounts/:id/credit", async (req, res) => {
    const account = accountManager.get(req.params.id);
    if (!account) return res.status(404).json({ error: "账号不存在" });
    const edition = getEdition(account.edition);
    try {
      const [usage, plan] = await Promise.all([
        info.getQuotaUsage(edition, account).catch((e) => ({ error: e.message })),
        info.getUserPlan(edition, account).catch(() => null),
      ]);
      if (usage.error) return res.status(502).json({ error: usage.error });
      accountManager.update(account.id, {
        quota: usage.quota ? { ...usage.quota, expiresAt: usage.expiresAt, updatedAt: Date.now() } : null,
        plan: plan || account.plan,
        lastError: "",
      });
      res.json({ usage, plan });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/checkin/status", async (_req, res) => {
    const results = [];
    for (const summary of accountManager.list()) {
      const account = accountManager.get(summary.id);
      if (!account || (!account.securityOauthToken && !account.pat)) {
        results.push({ id: summary.id, state: "unavailable" });
        continue;
      }
      const edition = getEdition(account.edition);
      try {
        const campaigns = await info.listCampaigns(edition, account);
        const state = info.findClaimableCheckins(campaigns).length > 0
          ? "claimable"
          : info.todayCheckedIn(campaigns)
            ? "checked"
            : "none";
        results.push({ id: summary.id, state });
      } catch (e) {
        results.push({ id: summary.id, state: "error", error: e.message });
      }
    }
    res.json({ accounts: results });
  });

  router.post("/accounts/checkin", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : accountManager.list().map((a) => a.id);
    const results = [];
    for (const id of ids) {
      const account = accountManager.get(id);
      if (!account) continue;
      const edition = getEdition(account.edition);
      try {
        const campaigns = await info.listCampaigns(edition, account);
        const claimables = info.findClaimableCheckins(campaigns);
        if (claimables.length === 0) {
          const checked = info.todayCheckedIn(campaigns);
          results.push({
            id,
            name: account.name || account.email,
            result: checked ? "already" : "none",
            error: checked ? undefined : "暂无可领取的签到活动",
          });
          continue;
        }
        let reward = 0;
        let anyClaimed = false;
        let anyReplayed = false;
        for (const claimable of claimables) {
          const claim = await info.claimCampaign(edition, account, claimable.id);
          const credit = Number(claim.rewardCredit ?? claimable.rewardCredit ?? 0);
          if (Number.isFinite(credit)) reward += credit;
          if (claim.replayed) anyReplayed = true;
          else anyClaimed = true;
        }
        const result = anyClaimed ? "success" : anyReplayed ? "already" : "none";
        appendJsonl("checkin.jsonl", {
          accountId: id,
          edition: account.edition,
          result,
          rewardCredit: reward || null,
        });
        results.push({
          id,
          name: account.name || account.email,
          result,
          rewardCredit: reward || null,
        });
      } catch (e) {
        appendJsonl("checkin.jsonl", { accountId: id, edition: account.edition, result: "error", error: e.message });
        results.push({ id, name: account.name || account.email, result: "error", error: e.message });
      }
    }
    res.json({ accounts: results });
  });

  router.get("/checkin/logs", (req, res) => {
    res.json({ logs: readJsonl("checkin.jsonl", 200).reverse() });
  });

  /* ---------------- 客户端切换 ---------------- */
  const switchJobs = new Map(); // jobId -> { steps: [], done, error }

  router.post("/accounts/:id/switch", async (req, res) => {
    const jobId = randomId("job");
    const job = { steps: [], done: false, error: "", result: null };
    switchJobs.set(jobId, job);
    res.json({ jobId });
    // 后台执行，前端轮询进度
    switcher
      .switchClientAccount(req.params.id, {
        restart: req.body?.restart !== false,
        onStep: (step) => {
          job.steps.push({ ...step, at: Date.now() });
        },
      })
      .then((result) => {
        job.done = true;
        job.result = { account: result.account, dir: result.dir };
      })
      .catch((e) => {
        job.done = true;
        job.error = e.message;
      })
      .finally(() => {
        setTimeout(() => switchJobs.delete(jobId), 5 * 60 * 1000);
      });
  });

  router.get("/switch-job/:jobId", (req, res) => {
    const job = switchJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "任务不存在或已结束" });
    res.json(job);
  });

  router.get("/client/detect", async (req, res) => {
    const editionValue = req.query.edition === "international" ? "international" : "domestic";
    const settings = getSettings();
    try {
      const client = await detectClient(editionValue, settings);
      res.json({ client });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------------- 反代配置 ---------------- */
  router.get("/proxy/config", (req, res) => {
    const settings = getSettings();
    res.json({ proxy: settings.proxy });
  });

  router.post("/proxy/config", (req, res) => {
    const settings = getSettings();
    const incoming = req.body?.proxy || {};
    for (const value of ["domestic", "international"]) {
      const next = incoming[value];
      if (!next) continue;
      const current = settings.proxy[value];
      settings.proxy[value] = {
        ...current,
        ...next,
        enabled: next.enabled === undefined ? Boolean(current.enabled) : Boolean(next.enabled),
        listen: String(next.listen || current.listen),
        apiKey: String(next.apiKey ?? current.apiKey ?? ""),
        extraModels: Array.isArray(next.extraModels) ? next.extraModels.map((m) => String(m).trim()).filter(Boolean) : current.extraModels,
        accountGroup: next.accountGroup || current.accountGroup || "proxy",
      };
    }
    saveJson("settings.json", settings);
    refreshProxyServers(settings);
    res.json({ proxy: settings.proxy });
  });

  router.get("/proxy/models", async (req, res) => {
    const editionValue = req.query.edition === "international" ? "international" : "domestic";
    const edition = getEdition(editionValue);
    const account = accountManager.pick(editionValue);
    if (!account) return res.status(503).json({ error: "没有可用账号，无法拉取模型列表" });
    try {
      const models = await info.fetchModelList(edition, account);
      res.json({ models });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.get("/usage", (req, res) => {
    const edition = req.query.edition;
    res.json(usageStats(edition));
  });

  /* ---------------- 会话管理 ---------------- */
  router.get("/sessions/workspaces", async (req, res) => {
    const editionValue = req.query.edition === "international" ? "international" : "domestic";
    try {
      const list = await sessions.listWorkspaces(editionValue, getSettings());
      res.json({ workspaces: list });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/sessions/chats", async (req, res) => {
    const editionValue = req.query.edition === "international" ? "international" : "domestic";
    const workspaceId = String(req.query.workspaceId || "");
    if (!workspaceId) return res.status(400).json({ error: "缺少 workspaceId" });
    try {
      const chats = await sessions.getChatHistory(editionValue, workspaceId, getSettings());
      res.json({ chats });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/sessions/export", async (req, res) => {
    const editionValue = req.body?.edition === "international" ? "international" : "domestic";
    const workspaceId = String(req.body?.workspaceId || "");
    if (!workspaceId) return res.status(400).json({ error: "缺少 workspaceId" });
    try {
      const result = await sessions.exportChatHistory(editionValue, workspaceId, getSettings());
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------------- 设置 ---------------- */
  router.get("/settings", (req, res) => {
    res.json({ settings: getSettings() });
  });

  router.post("/settings", (req, res) => {
    const settings = getSettings();
    const incoming = req.body?.settings || {};
    if (incoming.theme) settings.theme = ["light", "dark", "system"].includes(incoming.theme) ? incoming.theme : settings.theme;
    if (typeof incoming.closeToTray === "boolean") settings.closeToTray = incoming.closeToTray;
    if (incoming.clientDirOverrides) {
      settings.clientDirOverrides = {
        domestic: String(incoming.clientDirOverrides.domestic || ""),
        international: String(incoming.clientDirOverrides.international || ""),
      };
    }
    if (incoming.clientExePaths) {
      settings.clientExePaths = {
        domestic: String(incoming.clientExePaths.domestic || ""),
        international: String(incoming.clientExePaths.international || ""),
      };
    }
    if (incoming.autoCheckin) {
      const hour = Number(incoming.autoCheckin.hour);
      settings.autoCheckin = {
        enabled: Boolean(incoming.autoCheckin.enabled),
        hour: Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.round(hour))) : 9,
      };
    }
    if (incoming.endpointOverrides) {
      settings.endpointOverrides = sanitizeEndpoints(incoming.endpointOverrides);
    }
    saveJson("settings.json", settings);
    refreshProxyServers(settings);
    res.json({ settings });
  });

  router.get("/about", (req, res) => {
    res.json({
      name: APP_NAME,
      version: APP_VERSION,
      description: "Qoder（国内版 Qoder CN / 国际版）多账号切换 + OpenAI/Anthropic 兼容反代",
      references: [
        "https://github.com/cv-superding/WorkBuddy-Switch2api（界面与架构参考）",
        "https://github.com/jyao0708/qoder2api（Qoder 协议参考）",
        "https://github.com/70548887/Qoder-Switch（MITM 切换参考）",
      ],
    });
  });

  router.get("/update/check", async (req, res) => {
    try {
      const data = await checkUpdate({ force: req.query.force === "1" });
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.post("/update/download", async (req, res) => {
    try {
      res.json(await startDownload());
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.get("/update/download/status", (req, res) => {
    res.json(getDownloadStatus());
  });

  router.post("/update/install", (req, res) => {
    try {
      res.json(installDownloadedUpdate());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

function sanitizeEndpoints(input) {
  const out = {};
  for (const value of ["domestic", "international"]) {
    const src = input?.[value];
    if (!src) continue;
    const clean = {};
    for (const key of ["clientId", "openApiBaseUrl", "streamUrl", "modelListUrl", "cloudBaseUrl"]) {
      if (src[key]) clean[key] = String(src[key]).trim();
    }
    out[value] = clean;
  }
  return out;
}
