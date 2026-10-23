/**
 * Qoder OAuth 设备流登录（复刻自 qoder2api/internal/auth/device_login.go）。
 *
 * 流程：
 *  1. start()  生成 PKCE(nonce/verifier/challenge) + login_id，构造验证 URL
 *  2. 用户在浏览器完成登录（URL 里带 nonce/challenge/client_id/machine_id）
 *  3. poll()   轮询 openapi /api/v1/deviceToken/poll，拿到 token 后拉取
 *              userinfo / user/status / user/plan，组装账号
 *  4. refresh() 用 refresh_token 续期（POST /api/v1/deviceToken/refresh）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchJson } from "../http.js";
import { sharedClientCacheDir, machineIdPath } from "../paths.js";
import { uuid, machineIdFallback } from "../crypto.js";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const pending = new Map(); // loginId -> state

function pkceVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

/** 读取本机 Qoder 客户端的 machine 信息（新版 auth.machine-id / 旧版 SharedClientCache） */
export function readMachineInfo(clientDir) {
  const info = { machineId: "", machineToken: "", machineType: "" };
  if (clientDir) {
    try {
      const p = machineIdPath(clientDir);
      if (fs.existsSync(p)) info.machineId = fs.readFileSync(p, "utf8").trim();
    } catch {
      /* ignore */
    }
    const cacheDir = sharedClientCacheDir(clientDir);
    try {
      const idFile = path.join(cacheDir, "cache", "id");
      if (!info.machineId && fs.existsSync(idFile)) {
        info.machineId = fs.readFileSync(idFile, "utf8").trim();
      }
      const tokenFile = path.join(cacheDir, "cache", "machine_token.json");
      if (fs.existsSync(tokenFile)) {
        const json = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
        info.machineToken = json.token || "";
        info.machineType = json.type || "";
      }
    } catch {
      /* ignore */
    }
  }
  if (!info.machineId) info.machineId = machineIdFallback();
  return info;
}

/** 发起登录，返回验证 URL（前端展示并打开系统浏览器） */
export function startLogin(edition, clientDir) {
  const nonce = uuid().replace(/-/g, "");
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const loginId = uuid().replace(/-/g, "");
  const machine = readMachineInfo(clientDir);

  const url = new URL(edition.oauth.loginBaseUrl);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("challenge_method", "S256");
  url.searchParams.set("client_id", edition.oauth.clientId);
  if (machine.machineId) url.searchParams.set("machine_id", machine.machineId);

  pending.set(loginId, {
    loginId,
    nonce,
    verifier,
    machine,
    edition,
    expiresAt: Date.now() + POLL_TIMEOUT_MS,
  });
  // 简单防堆积：保留最近 20 个
  if (pending.size > 20) {
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
  }
  return { loginId, verificationUri: url.toString(), expiresIn: POLL_TIMEOUT_MS };
}

export function getPending(loginId) {
  return pending.get(loginId) ?? null;
}

export function cancelLogin(loginId) {
  pending.delete(loginId);
}

/**
 * 轮询一次设备流。
 * 返回 { status: "pending" } 或 { status: "done", account } 或 { status: "error", error }。
 */
export async function pollLogin(loginId) {
  const state = pending.get(loginId);
  if (!state) return { status: "error", error: "登录会话不存在或已过期，请重新发起" };
  if (Date.now() > state.expiresAt) {
    pending.delete(loginId);
    return { status: "error", error: "登录已超时，请重试" };
  }
  const { edition, nonce, verifier, machine } = state;
  const pollUrl = new URL(edition.oauth.openApiBaseUrl + edition.oauth.pollPath);
  pollUrl.searchParams.set("nonce", nonce);
  pollUrl.searchParams.set("verifier", verifier);
  pollUrl.searchParams.set("challenge_method", "S256");

  let result;
  try {
    result = await fetchJson(pollUrl.toString(), { timeoutMs: 20000 });
  } catch (e) {
    return { status: "pending", error: String(e.message || e) };
  }
  if (result.status === 404) return { status: "pending" };
  if (!result.ok) {
    return { status: "error", error: `轮询失败 HTTP ${result.status}: ${(result.text || "").slice(0, 200)}` };
  }
  const token = result.json || {};
  if (!token.token) return { status: "pending" };

  pending.delete(loginId);

  // 拉取用户详情
  const headers = { Authorization: `Bearer ${token.token}` };
  const [userInfo, userPlan] = await Promise.all([
    fetchJson(edition.oauth.openApiBaseUrl + edition.oauth.userInfoPath, { headers }).catch(() => null),
    fetchJson(edition.oauth.openApiBaseUrl + edition.oauth.userPlanPath, { headers }).catch(() => null),
  ]);

  // user/status 需要 Cosy 系列头
  const statusHeaders = {
    ...headers,
    "Cosy-ClientType": "0",
    "Cosy-MachineOS": `${process.arch === "arm64" ? "aarch64" : process.arch}_${process.platform}`,
  };
  if (machine.machineToken) statusHeaders["Cosy-MachineToken"] = machine.machineToken;
  if (machine.machineType) statusHeaders["Cosy-MachineType"] = machine.machineType;
  const userStatus = await fetchJson(edition.oauth.openApiBaseUrl + edition.oauth.userStatusPath, {
    headers: statusHeaders,
  }).catch(() => null);

  const whitelist = userStatus?.json?.whitelistStatus;
  if (whitelist && ["NoIpPermission", "AppDisable", "LoginExpire", "NotAllow", "NOT_ALLOW"].includes(whitelist)) {
    const messages = {
      NoIpPermission: "企业设置了 IP 白名单，当前 IP 无法登录",
      AppDisable: "Qoder 应用已被停用",
      LoginExpire: "Qoder 登录已失效，请重试",
      NotAllow: "当前账号暂无 Qoder 使用权限",
      NOT_ALLOW: "当前账号暂无 Qoder 使用权限",
    };
    return { status: "error", error: messages[whitelist] || `登录被拒绝: ${whitelist}` };
  }

  const status = userStatus?.json || {};
  const info = userInfo?.json || {};
  const plan = userPlan?.json || {};
  const uid = status.id || token.user_id || info.id || "";
  const planTierName = plan.plan_tier_name || plan.planTierName || "";
  const account = {
    edition: edition.value,
    uid,
    name: info.name || status.name || "",
    email: info.email || status.email || "",
    phone: info.phone || status.phone || "",
    avatarUrl: info.avatarUrl || info.avatar_url || "",
    userType: status.userType || info.userType || plan.user_type || "personal_standard",
    orgId: status.orgId || info.orgId || "",
    orgName: status.orgName || info.orgName || "",
    yxUid: status.yxUid || info.yxUid || "",
    securityOauthToken: token.token,
    refreshToken: token.refresh_token || "",
    tokenExpireAt: normalizeExpire(token.expires_at),
    refreshTokenExpiresAt: normalizeExpire(token.refresh_token_expires_at),
    machineId: machine.machineId,
    machineToken: machine.machineToken,
    machineType: machine.machineType,
    plan: planTierName
      ? {
          userType: plan.user_type || plan.userType || "",
          planTierName,
          endDate: normalizeExpire(plan.end_date ?? plan.endDate),
        }
      : null,
    quota: typeof status.quota === "number" ? status.quota : null,
    isQuotaExceeded: Boolean(status.isQuotaExceeded),
    authSource: "oauth",
  };
  return { status: "done", account };
}

/**
 * 用 refresh_token / PAT 续期。
 * 设备流（drt-）走 deviceToken/refresh；旧版 PAT 账号（jrt-）走 jobToken/refresh，
 * 失败时用 pt- 重新兑换 job token。成功返回 token 与新的到期时间。
 */
export async function refreshToken(edition, account) {
  const base = edition.oauth.openApiBaseUrl;
  const refresh = account.refreshToken || "";
  const pat = account.pat || "";
  if (!refresh && !pat) {
    throw new Error("账号没有 refresh_token，无法续期，请重新登录");
  }
  const errors = [];
  const deviceRefresh = async () =>
    normalizeRefresh(await postRefresh(`${base}${edition.oauth.refreshPath}`, { refresh_token: refresh }), account);
  const jobRefresh = async () =>
    normalizeRefresh(await postRefresh(`${base}/api/v1/jobToken/refresh`, { refresh_token: refresh }), account);
  const patExchange = async () =>
    normalizeRefresh(await postRefresh(`${base}/api/v1/jobToken/exchange`, { personal_token: pat }), account);

  // 设备流（drt-）只走自己的端点，PAT 不能劫持
  if (refresh.startsWith("drt-")) {
    try {
      return await deviceRefresh();
    } catch (e) {
      errors.push(`设备令牌刷新失败: ${e.message}`);
    }
  }
  // 旧版 PAT 账号（jrt-）先刷新 job token，再用 pt- 重新兑换兜底
  if (refresh.startsWith("jrt-")) {
    try {
      return await jobRefresh();
    } catch (e) {
      errors.push(`Job Token 刷新失败: ${e.message}`);
    }
    if (pat) {
      try {
        return await patExchange();
      } catch (e) {
        errors.push(`PAT 兑换失败: ${e.message}`);
      }
    }
    throw new Error(errors.join("；"));
  }
  // 只有 PAT、没有 refresh token：直接兑换 job token
  if (!refresh && pat) {
    try {
      return await patExchange();
    } catch (e) {
      errors.push(`PAT 兑换失败: ${e.message}`);
    }
  }
  // 无前缀的旧数据按设备流处理
  if (refresh && !refresh.startsWith("drt-")) {
    try {
      return await deviceRefresh();
    } catch (e) {
      errors.push(`设备令牌刷新失败: ${e.message}`);
    }
  }
  throw new Error(errors.join("；") || "刷新失败");
}

async function postRefresh(url, body) {
  const result = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs: 20000,
  });
  if (!result.ok) {
    throw new Error(`HTTP ${result.status}: ${(result.text || "").slice(0, 200)}`);
  }
  return result.json || {};
}

function normalizeRefresh(raw, account) {
  const data = raw.data && typeof raw.data === "object" ? raw.data : raw;
  const token =
    data.device_token || data.token || data.securityOauthToken || data.access_token || data.accessToken;
  if (!token) throw new Error("刷新响应缺少 token");
  let tokenExpireAt = normalizeExpire(
    data.expires_at ?? data.expireTime ?? data.expiresAt ?? null,
  );
  // jobToken 的 expires_in 单位是毫秒
  const expiresIn = Number(data.expires_in ?? data.expiresIn);
  if (!tokenExpireAt && Number.isFinite(expiresIn) && expiresIn > 0) {
    tokenExpireAt = Date.now() + expiresIn;
  }
  return {
    securityOauthToken: token,
    refreshToken:
      data.refresh_token || data.refreshToken || data.refreshTokenValue || account.refreshToken,
    tokenExpireAt,
    refreshTokenExpiresAt: normalizeExpire(
      data.refresh_token_expires_at ??
        data.refreshTokenExpiresAt ??
        data.refreshTokenExpireAt ??
        data.refresh_expires_at ??
        null,
    ),
  };
}

function normalizeExpire(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const num = Number(raw);
  if (Number.isFinite(num)) {
    return num < 1e12 ? num * 1000 : num;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}
