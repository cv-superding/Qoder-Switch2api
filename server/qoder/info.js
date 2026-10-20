/**
 * Qoder 账号信息查询：订阅计划、额度用量、签到活动（campaigns）、模型列表。
 * 端点与 qoder2api / cpa-multi-plugins / dsh-qoder-connect 对齐。
 */
import { fetchJson } from "../http.js";
import { legacyDecode } from "./cosy.js";

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

/**
 * 找到今天可领取的签到活动。
 * 只认 actionType === "CLAIM_BENEFIT" 且 claimStatus === "CLAIMABLE"。
 */
export function findClaimableCheckin(campaigns) {
  for (const c of campaigns || []) {
    const actionType = c.actionType || c.action_type || "";
    const claimStatus = c.claimStatus || c.claim_status || "";
    if (actionType === "CLAIM_BENEFIT" && claimStatus === "CLAIMABLE") {
      return {
        id: c.id || c.campaignId,
        name: c.name || c.title || "每日奖励",
        rewardCredit: c.rewardCredit ?? c.reward_credit ?? c.credit ?? null,
      };
    }
  }
  return null;
}

/** 今日是否已签到 */
export function todayCheckedIn(campaigns) {
  for (const c of campaigns || []) {
    const actionType = c.actionType || c.action_type || "";
    if (actionType !== "CLAIM_BENEFIT") continue;
    const claimStatus = c.claimStatus || c.claim_status || "";
    if (claimStatus === "CLAIMED" || claimStatus === "REPLAYED") return true;
  }
  return false;
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
 * 网关响应可能是明文 JSON、{body:"..."} 信封或 legacy 编码，逐一兼容。
 */
export async function fetchModelList(edition, account) {
  const url = edition.legacy.modelListUrl;
  const result = await fetchJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${account.pat || account.securityOauthToken}`,
      "x-model-source": "system",
    },
    timeoutMs: 20000,
  }).catch(() => null);
  if (!result || !result.ok) return [];
  let payload = result.json;
  if (!payload) {
    try {
      payload = JSON.parse(legacyDecode(result.text || ""));
    } catch {
      return [];
    }
  }
  const models = extractModels(payload);
  return models;
}

function extractModels(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.map(normalizeModel).filter(Boolean);
  const candidates = [payload.models, payload.data, payload.body, payload.list];
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
