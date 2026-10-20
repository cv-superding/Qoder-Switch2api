/**
 * 账号池：CRUD、按档位隔离、轮转、失败冷却、token 续期。
 * 数据整体加密存放在 ~/.qoder-switch/accounts.json。
 */
import { loadEncrypted, saveEncrypted } from "../store.js";
import { randomId } from "../crypto.js";
import { refreshToken } from "./oauth.js";
import { EDITIONS } from "../editions.js";

const COOLDOWN_MS = 120 * 1000; // 失败冷却 120s（同 WorkBuddy-Switch2api）
const AUTH_ERROR_COOLDOWN_MS = 10 * 60 * 1000; // 鉴权错误冷却 10 分钟

/** 兼容旧版 Rust 写入的 snake_case 账号字段 */
function normalizeStoredAccount(account) {
  if (!account || typeof account !== "object") return account;
  for (const key of Object.keys(account)) {
    if (!key.includes("_")) continue;
    const camel = key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    if (!(camel in account)) account[camel] = account[key];
    delete account[key];
  }
  if (account.refreshTokenExpireAt != null && account.refreshTokenExpiresAt == null) {
    account.refreshTokenExpiresAt = account.refreshTokenExpireAt;
  }
  delete account.refreshTokenExpireAt;
  return account;
}

/** 统一把到期时间规范为毫秒时间戳（接受 ISO 字符串 / 秒级 / 毫秒级数字） */
function toMs(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? (raw < 1e12 ? raw * 1000 : raw) : null;
  const num = Number(raw);
  if (Number.isFinite(num)) return num < 1e12 ? num * 1000 : num;
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? null : t;
}

/** 兼容旧数据：账号库可能保存过字符串形式的套餐名 */
function normalizePlan(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { userType: "", planTierName: raw, endDate: null };
  return {
    userType: raw.userType ?? raw.user_type ?? "",
    planTierName: raw.planTierName ?? raw.plan_tier_name ?? "",
    endDate: toMs(raw.endDate ?? raw.end_date),
  };
}

class AccountManager {
  constructor() {
    this.accounts = (loadEncrypted("accounts.json", []) || []).map(normalizeStoredAccount);
    this.cooldowns = new Map(); // accountId -> until
    this.rr = { domestic: 0, international: 0 };
    this.clientCurrent = { domestic: null, international: null }; // 客户端当前登录账号快照 {uid, name, email, at}
  }

  save() {
    saveEncrypted("accounts.json", this.accounts);
    return this.accounts;
  }

  list(edition) {
    const all = this.accounts.map((a) => this.publicView(a));
    return edition ? all.filter((a) => a.edition === edition) : all;
  }

  /** 内部完整对象（含 token） */
  get(id) {
    return this.accounts.find((a) => a.id === id) || null;
  }

  getByUid(edition, uid) {
    if (!uid) return null;
    return this.accounts.find((a) => a.edition === edition && a.uid === uid) || null;
  }

  publicView(a) {
    const { securityOauthToken, refreshToken, pat, machineToken, ...rest } = a;
    return {
      ...rest,
      hasToken: Boolean(securityOauthToken),
      hasRefreshToken: Boolean(refreshToken),
      hasPat: Boolean(pat),
      tokenMask: securityOauthToken ? maskToken(securityOauthToken) : pat ? maskToken(pat) : "",
      cooling: this.isCooling(a.id),
    };
  }

  /**
   * 新增账号。data 需含 edition；登录态字段至少一种
   * （securityOauthToken 或 pat）。同档位同 uid 会覆盖更新。
   */
  add(data, { allowEmpty = false } = {}) {
    const edition = data.edition === "international" ? "international" : "domestic";
    if (!data.securityOauthToken && !data.pat && !allowEmpty) {
      throw new Error("缺少登录凭证：需要 securityOauthToken 或 PAT");
    }
    const normalized = {
      label: data.label || "",
      name: data.name || "",
      email: data.email || "",
      phone: data.phone || "",
      avatarUrl: data.avatarUrl || "",
      uid: data.uid || "",
      aid: data.aid || "",
      yxUid: data.yxUid || "",
      orgId: data.orgId || "",
      orgName: data.orgName || "",
      userType: data.userType || "personal_standard",
      securityOauthToken: data.securityOauthToken || "",
      refreshToken: data.refreshToken || "",
      tokenExpireAt: toMs(data.tokenExpireAt),
      refreshTokenExpiresAt: toMs(data.refreshTokenExpiresAt ?? data.refreshTokenExpireAt),
      pat: data.pat || "",
      machineId: data.machineId || "",
      machineToken: data.machineToken || "",
      machineType: data.machineType || "",
      group: typeof data.group === "string" ? data.group : undefined,
      authSource: data.authSource || "manual",
      quota: data.quota || null,
      plan: normalizePlan(data.plan),
    };

    if (normalized.uid) {
      const existing = this.accounts.find((a) => a.edition === edition && a.uid === normalized.uid);
      if (existing) {
        const preserved = {
          quota: existing.quota,
          plan: existing.plan,
          group: existing.group,
          securityOauthToken: existing.securityOauthToken,
          refreshToken: existing.refreshToken,
          pat: existing.pat,
          tokenExpireAt: existing.tokenExpireAt,
          refreshTokenExpiresAt: existing.refreshTokenExpiresAt,
        };
        const hasToken = Boolean(normalized.securityOauthToken || normalized.pat || preserved.securityOauthToken || preserved.pat);
        Object.assign(existing, normalized, {
          securityOauthToken: normalized.securityOauthToken || preserved.securityOauthToken,
          refreshToken: normalized.refreshToken || preserved.refreshToken,
          pat: normalized.pat || preserved.pat,
          tokenExpireAt: normalized.tokenExpireAt ?? preserved.tokenExpireAt,
          refreshTokenExpiresAt: normalized.refreshTokenExpiresAt ?? preserved.refreshTokenExpiresAt,
          label: normalized.label || existing.label,
          group: normalized.group ?? preserved.group,
          quota: normalized.quota ?? preserved.quota,
          plan: normalized.plan ?? preserved.plan,
          status: hasToken ? "active" : "needs_relogin",
          lastError: hasToken ? "" : "备份不含登录态，请重新登录",
          updatedAt: Date.now(),
        });
        this.save();
        return existing;
      }
    }

    const account = {
      id: randomId("acc"),
      edition,
      ...normalized,
      group: normalized.group ?? "",
      status: normalized.securityOauthToken || normalized.pat ? "active" : "needs_relogin",
      lastError: normalized.securityOauthToken || normalized.pat ? "" : "备份不含登录态，请重新登录",
      lastUsedAt: null,
      lastSwitchAt: data.lastSwitchAt != null ? toMs(data.lastSwitchAt) : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.accounts.push(account);
    this.save();
    return account;
  }

  update(id, patch) {
    const account = this.get(id);
    if (!account) throw new Error("账号不存在");
    const allowed = [
      "label", "group", "status", "name", "email", "phone", "avatarUrl",
      "securityOauthToken", "refreshToken", "tokenExpireAt", "refreshTokenExpiresAt",
      "pat", "machineId", "machineToken", "machineType", "quota", "plan",
      "lastUsedAt", "lastSwitchAt", "lastError", "userType", "orgId", "orgName", "yxUid", "aid",
    ];
    const timeKeys = new Set(["tokenExpireAt", "refreshTokenExpiresAt", "lastUsedAt", "lastSwitchAt"]);
    for (const key of allowed) {
      if (key in patch) {
        account[key] = timeKeys.has(key) ? toMs(patch[key]) : key === "plan" ? normalizePlan(patch[key]) : patch[key];
      }
    }
    account.updatedAt = Date.now();
    this.save();
    return account;
  }

  /** 导出账号（默认脱敏；includeTokens 时包含完整登录态，仅用于本机迁移） */
  exportList({ includeTokens = false, ids = null } = {}) {
    const set = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
    return this.accounts
      .filter((a) => !set || set.has(a.id))
      .map((a) => (includeTokens ? { ...a, cooling: this.isCooling(a.id) } : this.publicView(a)));
  }

  remove(id) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.cooldowns.delete(id);
    this.save();
    return before !== this.accounts.length;
  }

  setClientCurrent(edition, summary) {
    this.clientCurrent[edition] = summary ? { ...summary, at: Date.now() } : null;
  }

  getClientCurrent(edition) {
    return this.clientCurrent[edition];
  }

  /* ---------------- 轮转与冷却 ---------------- */

  isCooling(id) {
    const until = this.cooldowns.get(id);
    return Boolean(until && until > Date.now());
  }

  /** 反代可用账号：未禁用、未冷却；group !== 'desktop'（桌面端专用号不参与反代） */
  proxyCandidates(edition, { group = "proxy" } = {}) {
    return this.accounts.filter((a) => {
      if (a.edition !== edition) return false;
      if (a.status === "disabled") return false;
      if (this.isCooling(a.id)) return false;
      if (group === "proxy" && a.group === "desktop") return false;
      return Boolean(a.securityOauthToken || a.pat);
    });
  }

  /** 轮转选号：优先积分/额度剩余最多的健康账号，同级 round-robin */
  pick(edition, options = {}) {
    const candidates = this.proxyCandidates(edition, options);
    if (candidates.length === 0) return null;
    const now = Date.now();
    // 过滤 token 过期的（有刷新令牌的除外——由调用方尝试刷新）
    const usable = candidates.filter((a) => !a.tokenExpireAt || a.tokenExpireAt > now || a.refreshToken);
    const pool = usable.length > 0 ? usable : candidates;
    pool.sort((a, b) => quotaScore(b) - quotaScore(a) || (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    const top = pool[0];
    const idx = this.rr[edition] || 0;
    const chosen = pool.length > 1 ? pool[idx % pool.length] : top;
    this.rr[edition] = (idx + 1) % Math.max(pool.length, 1);
    chosen.lastUsedAt = Date.now();
    return chosen;
  }

  markSuccess(id) {
    const account = this.get(id);
    if (account) {
      const changed = Boolean(account.lastError) || account.status === "needs_relogin";
      account.lastError = "";
      account.status = "active";
      account.updatedAt = Date.now();
      if (changed) this.save();
    }
    this.cooldowns.delete(id);
  }

  /** 失败冷却；鉴权类错误（401/403）升级为 needs_relogin 候选 */
  markFailure(id, statusCode, message) {
    const account = this.get(id);
    const until = Date.now() + (statusCode === 401 || statusCode === 403 ? AUTH_ERROR_COOLDOWN_MS : COOLDOWN_MS);
    this.cooldowns.set(id, until);
    if (account) {
      account.lastError = `HTTP ${statusCode || "?"}: ${String(message || "").slice(0, 200)}`;
      account.updatedAt = Date.now();
      if (statusCode === 401 || statusCode === 403) {
        // 有刷新令牌的留一线机会（下次 pick 前尝试刷新），否则标记需重新登录
        if (!account.refreshToken) account.status = "needs_relogin";
      }
      this.save();
    }
  }

  /** 尝试用 refresh_token 续期；成功写回并返回 true */
  async tryRefresh(id) {
    const account = this.get(id);
    if (!account || !account.refreshToken) return false;
    const edition = EDITIONS[account.edition] || EDITIONS.domestic;
    try {
      const result = await refreshToken(edition, account);
      this.update(id, {
        securityOauthToken: result.securityOauthToken,
        refreshToken: result.refreshToken,
        tokenExpireAt: result.tokenExpireAt,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt ?? account.refreshTokenExpiresAt,
        status: "active",
        lastError: "",
      });
      this.cooldowns.delete(id);
      return true;
    } catch (e) {
      this.update(id, { status: "needs_relogin", lastError: `续期失败: ${e.message}` });
      return false;
    }
  }

  counts() {
    const out = { domestic: 0, international: 0, proxyDomestic: 0, proxyInternational: 0 };
    for (const a of this.accounts) {
      out[a.edition] += 1;
      if (a.group !== "desktop" && (a.securityOauthToken || a.pat) && a.status !== "disabled") {
        if (a.edition === "domestic") out.proxyDomestic += 1;
        else out.proxyInternational += 1;
      }
    }
    return out;
  }
}

function quotaScore(a) {
  const q = a.quota;
  if (!q) return 0;
  if (typeof q.remaining === "number" && typeof q.total === "number" && q.total > 0) {
    return q.remaining / q.total;
  }
  return 0;
}

function maskToken(token) {
  const t = String(token);
  if (t.length <= 12) return `${t.slice(0, 3)}***`;
  return `${t.slice(0, 6)}***${t.slice(-4)}`;
}

export const accountManager = new AccountManager();
