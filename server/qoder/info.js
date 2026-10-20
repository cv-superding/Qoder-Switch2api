/**
 * Qoder 账号信息查询：订阅计划、额度用量、签到活动（campaigns）、模型列表。
 * 端点与 qoder2api / cpa-multi-plugins / dsh-qoder-connect 对齐。
 */
import { fetchJson } from "../http.js";
import { buildModelListHeaders, legacyDecode } from "./cosy.js";

function openApi(edition, p) {
  return edition.oauth.openApiBaseUrl + p;
}

/** 上游时间可能是 ISO 字符串、秒级或毫秒级时间戳，统一成毫秒 */
function normalizeTime(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const num = Number(raw);
  if (Number.isFinite(num)) return num < 1e12 ? num * 1000 : num;
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

function authHeaders(account) {
  return { Authorization: `Bearer ${account.pat || account.securityOauthToken}` };
}

function quotaPart(raw) {
  if (!raw) return null;
  return {
    total: raw.total ?? null,
    used: raw.used ?? null,
    remaining: raw.remaining ?? null,
    percentage: raw.percentage ?? null,
    unit: raw.unit || "",
  };
}

/**
 * 合并套餐额度与加油包（addOnQuota）。
 * 上游 percentage 是「已用比例」，合并后的 percentage 保持同一语义。
 */
function combineQuota(plan, addOn) {
  // 上游可能返回 total=0 的空 addOnQuota，展示上没有意义
  if (addOn && !(Number(addOn.total) > 0) && !(Number(addOn.remaining) > 0)) addOn = null;
  if (!plan && !addOn) return null;
  if (!plan) return { ...addOn, plan: null, addOn };
  if (!addOn) return { ...plan, plan, addOn: null };
  const total = plan.total != null && addOn.total != null ? plan.total + addOn.total : null;
  const used = plan.used != null && addOn.used != null ? plan.used + addOn.used : null;
  const remaining =
    plan.remaining != null && addOn.remaining != null ? plan.remaining + addOn.remaining : null;
  return {
    total,
    used,
    remaining,
    percentage: total && used != null ? used / total : null,
    unit: plan.unit || addOn.unit || "",
    plan,
    addOn,
  };
}

/** 额度用量：/api/v2/quota/usage */
export async function getQuotaUsage(edition, account) {
  const result = await fetchJson(openApi(edition, edition.oauth.quotaUsagePath), {
    headers: authHeaders(account),
    timeoutMs: 20000,
  });
  if (!result.ok) throw new Error(`额度查询 HTTP ${result.status}: ${(result.text || "").slice(0, 200)}`);
  const data = result.json || {};
  return {
    usageType: data.usageType || "",
    totalUsagePercentage: data.totalUsagePercentage ?? null,
    isQuotaExceeded: Boolean(data.isQuotaExceeded),
    expiresAt: normalizeTime(data.expiresAt),
    quota: combineQuota(quotaPart(data.userQuota), quotaPart(data.addOnQuota)),
  };
}

/** 订阅计划：/api/v2/user/plan */
export async function getUserPlan(edition, account) {
  const result = await fetchJson(openApi(edition, edition.oauth.userPlanPath), {
    headers: authHeaders(account),
    timeoutMs: 20000,
  });
  if (!result.ok) throw new Error(`订阅查询 HTTP ${result.status}: ${(result.text || "").slice(0, 200)}`);
  const data = result.json || {};
  return {
    userType: data.user_type || data.userType || "",
    planTierName: data.plan_tier_name || data.planTierName || "",
    isPersonalVersion: Boolean(data.is_personal_version),
    startDate: normalizeTime(data.start_date ?? data.startDate),
    endDate: normalizeTime(data.end_date ?? data.endDate),
  };
}

/** 个人用量汇总：/sash/api/v2/me/usage */
export async function getMeUsage(edition, account) {
  const result = await fetchJson(openApi(edition, edition.oauth.meUsagePath), {
    headers: authHeaders(account),
    timeoutMs: 20000,
  }).catch(() => null);
  if (!result || !result.ok) return null;
  return result.json;
}

/** 活动列表（每日签到以 campaign 形式存在）：/sash/api/v1/me/campaigns */
export async function listCampaigns(edition, account) {
  const result = await fetchJson(openApi(edition, edition.oauth.campaignsPath), {
    headers: authHeaders(account),
    timeoutMs: 20000,
  });
  if (!result.ok) throw new Error(`活动查询 HTTP ${result.status}: ${(result.text || "").slice(0, 200)}`);
  const data = result.json;
  const list = Array.isArray(data) ? data : data?.campaigns || data?.data || [];
  return list;
}

function campaignField(c, snake, camel) {
  return c?.[snake] ?? c?.[camel] ?? "";
}

function campaignAction(c) {
  return String(campaignField(c, "action_type", "actionType")).trim().toUpperCase();
}

function campaignStatus(c) {
  return String(campaignField(c, "claim_status", "claimStatus")).trim().toUpperCase();
}

function campaignAmount(c) {
  const raw = c?.benefit?.amount ?? c?.rewardCredit ?? c?.reward_credit ?? c?.credit;
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

/** 积分类活动：新版带 benefit.kind=CREDITS，部分老活动 kind 为空 */
function isCreditCampaign(c) {
  const kind = String(c?.benefit?.kind ?? "").trim().toUpperCase();
  return kind === "" || kind === "CREDITS";
}

/**
 * 可领取的签到活动。
 * 领取后上游会把 actionType 降级为 VIEW_DETAILS，因此判据以 claimStatus 为主；
 * actionType 为空或 CLAIM_BENEFIT 都算可领。
 */
export function findClaimableCheckins(campaigns) {
  return (campaigns || [])
    .filter((c) => {
      const action = campaignAction(c);
      return (
        campaignStatus(c) === "CLAIMABLE" &&
        (action === "" || action === "CLAIM_BENEFIT") &&
        isCreditCampaign(c)
      );
    })
    .map((c) => ({
      id: c.id || c.campaignId,
      name: c.name || c.title || "每日奖励",
      rewardCredit: campaignAmount(c) || null,
    }))
    .filter((c) => c.id);
}

export function findClaimableCheckin(campaigns) {
  return findClaimableCheckins(campaigns)[0] ?? null;
}

/** 今日是否已签到：只认积分类活动的 CLAIMED / REPLAYED */
export function todayCheckedIn(campaigns) {
  return (campaigns || []).some(
    (c) =>
      ["CLAIMED", "REPLAYED"].includes(campaignStatus(c)) &&
      (isCreditCampaign(c) || campaignAmount(c) > 0),
  );
}

/** 领取奖励：POST /sash/api/v1/me/campaigns/{id}/claim（幂等） */
export async function claimCampaign(edition, account, campaignId) {
  const url = `${openApi(edition, edition.oauth.claimPath)}/${encodeURIComponent(campaignId)}/claim`;
  const result = await fetchJson(url, {
    method: "POST",
    headers: authHeaders(account),
    timeoutMs: 20000,
  });
  if (!result.ok) throw new Error(`领取 HTTP ${result.status}: ${(result.text || "").slice(0, 200)}`);
  const data = result.json || {};
  return {
    success: true,
    replayed: Boolean(data.replayed),
    rewardCredit: data.rewardCredit ?? data.credit ?? null,
  };
}

/**
 * 拉取上游可用模型列表。
 * 需要 Cosy 签名（签名路径剥 /algo、GET 无 body），国际版按 api1 → api2 → api3 兜底。
 */
export async function fetchModelList(edition, account) {
  const urls = [edition.legacy.modelListUrl, ...(edition.legacy.modelListFallbacks || [])].filter(Boolean);
  let lastError = "";
  for (const url of urls) {
    const headers = buildModelListHeaders({ account, edition, requestUrl: url });
    const result = await fetchJson(url, { method: "GET", headers, timeoutMs: 20000 }).catch((e) => ({
      error: e.message,
    }));
    if (result.error) {
      lastError = result.error;
      continue;
    }
    if (!result.ok) {
      lastError = `HTTP ${result.status}: ${(result.text || "").slice(0, 200)}`;
      continue;
    }
    let payload = result.json;
    if (!payload) {
      try {
        payload = JSON.parse(legacyDecode(result.text || ""));
      } catch {
        payload = null;
      }
    }
    const models = extractModels(payload);
    if (models.length > 0) return models;
    lastError = "上游未返回模型列表";
  }
  if (lastError && !lastError.includes("未返回模型列表")) throw new Error(lastError);
  return [];
}

function extractModels(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.map(normalizeModel).filter(Boolean);
  // 新版响应顶层按场景分组：chat / developer / inline / quest ...
  const candidates = [payload.chat, payload.models, payload.data, payload.body, payload.list];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.map(normalizeModel).filter(Boolean);
    if (typeof c === "string") {
      try {
        const parsed = JSON.parse(c);
        if (Array.isArray(parsed)) return parsed.map(normalizeModel).filter(Boolean);
      } catch {
        /* continue */
      }
    }
  }
  return [];
}

function normalizeModel(m) {
  if (typeof m === "string") return { id: m, ownedBy: "qoder" };
  if (m && typeof m === "object") {
    if (m.enable === false || m.enabled === false) return null;
    const id = m.key || m.id || m.model || m.name;
    if (!id) return null;
    return {
      id,
      displayName: m.display_name || m.displayName || m.name || id,
      ownedBy: m.source === "system" ? "qoder" : m.source || "qoder",
      isReasoning: Boolean(m.is_reasoning),
      isVl: Boolean(m.is_vl),
    };
  }
  return null;
}
