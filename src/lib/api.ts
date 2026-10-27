/** API 客户端：与后端 /api/* 对应 */

import type {
  Account, AppStatus, AutoCheckinStatus, BackupResult, KeepaliveStatus, ChatItem, CheckinResult, CheckinState, ClientInfo, PlanInfo, ProxyConfig, QuotaInfo,
  Settings, UpdateDownloadStatus, UpdateInfo, UsageStats, Workspace,
} from "@/lib/types";

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应（例如 404 HTML） */
  }
  if (!resp.ok) {
    const fallback = text && !text.trimStart().startsWith("<") ? text.slice(0, 200) : "";
    const message = (json as { error?: string } | null)?.error || fallback || `HTTP ${resp.status}`;
    throw new Error(message);
  }
  return json as T;
}

export function asError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const api = {
  /* 状态 */
  getStatus: () => request<AppStatus>("/status"),

  /* 账号 */
  listAccounts: (edition?: string) =>
    request<{ accounts: Account[] }>(`/accounts${edition ? `?edition=${edition}` : ""}`),
  addAccount: (body: Record<string, unknown>) =>
    request<{ account: Account }>("/accounts", { method: "POST", body: JSON.stringify(body) }),
  updateAccount: (id: string, body: Record<string, unknown>) =>
    request<{ account: Account }>(`/api-account/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteAccount: (id: string) => request<{ ok: boolean }>(`/accounts/${id}`, { method: "DELETE" }),
  exportAccounts: (body: { includeTokens: boolean; ids?: string[] }) =>
    request<{
      app: string; version: string; exportedAt: string; includesTokens: boolean; accounts: Record<string, unknown>[];
    }>("/accounts/export", { method: "POST", body: JSON.stringify(body) }),
  importAccounts: (accounts: Record<string, unknown>[]) =>
    request<BackupResult>("/accounts/import", { method: "POST", body: JSON.stringify({ accounts }) }),
  importClientAccount: (edition: string) =>
    request<{ account: Account; source: string }>("/accounts/import-client", {
      method: "POST",
      body: JSON.stringify({ edition }),
    }),
  refreshToken: (id: string) =>
    request<{ ok: boolean; account: Account }>(`/accounts/${id}/refresh`, { method: "POST", body: "{}" }),
  getCredit: (id: string) =>
    request<{ usage: QuotaInfo; plan: PlanInfo | null }>(`/accounts/${id}/credit`),
  checkinAll: (ids?: string[]) =>
    request<{ accounts: CheckinResult[] }>("/accounts/checkin", {
      method: "POST",
      body: JSON.stringify(ids ? { ids } : {}),
    }),
  checkinStatus: () =>
    request<{ accounts: { id: string; state: CheckinState; error?: string }[] }>("/checkin/status"),
  getCheckinLogs: () => request<{ logs: Record<string, unknown>[] }>("/checkin/logs"),
  getAutoCheckinStatus: () => request<AutoCheckinStatus>("/checkin/auto/status"),
  getKeepaliveStatus: () => request<KeepaliveStatus>("/keepalive/status"),

  /* OAuth */
  openExternal: (url: string) =>
    request<{ ok: boolean }>("/oauth/open-url", { method: "POST", body: JSON.stringify({ url }) }),
  oauthStart: (edition: string) =>
    request<{ loginId: string; verificationUri: string; expiresIn: number }>("/oauth/start", {
      method: "POST",
      body: JSON.stringify({ edition }),
    }),
  oauthPoll: (loginId: string) =>
    request<{ status: string; account?: Account; error?: string }>(`/oauth/poll/${loginId}`),
  oauthCancel: (loginId: string) => request<{ ok: boolean }>(`/oauth/cancel/${loginId}`, { method: "POST", body: "{}" }),

  /* 客户端切换 */
  switchAccount: (id: string, restart = true) =>
    request<{ jobId: string }>(`/accounts/${id}/switch`, {
      method: "POST",
      body: JSON.stringify({ restart }),
    }),
  switchJob: (jobId: string) =>
    request<{
      steps: { name: string; status: string; detail?: string; at: number }[];
      done: boolean;
      error: string;
      result: { account: Account; dir: string } | null;
    }>(`/switch-job/${jobId}`),
  detectClient: (edition: string) => request<{ client: ClientInfo }>(`/client/detect?edition=${edition}`),

  /* 反代 */
  getProxyConfig: () => request<{ proxy: { domestic: ProxyConfig; international: ProxyConfig } }>("/proxy/config"),
  saveProxyConfig: (proxy: Record<string, Partial<ProxyConfig>>) =>
    request<{ proxy: { domestic: ProxyConfig; international: ProxyConfig } }>("/proxy/config", {
      method: "POST",
      body: JSON.stringify({ proxy }),
    }),
  fetchProxyModels: (edition: string) =>
    request<{ models: { id: string; displayName: string; ownedBy: string; isReasoning: boolean; isVl: boolean }[] }>(
      `/proxy/models?edition=${edition}`,
    ),
  getUsage: (edition?: string) => request<UsageStats>(`/usage${edition ? `?edition=${edition}` : ""}`),

  /* 会话 */
  listWorkspaces: (edition: string) =>
    request<{ workspaces: Workspace[] }>(`/sessions/workspaces?edition=${edition}`),
  getChats: (edition: string, workspaceId: string) =>
    request<{ chats: ChatItem[] }>(`/sessions/chats?edition=${edition}&workspaceId=${encodeURIComponent(workspaceId)}`),
  exportChats: (edition: string, workspaceId: string) =>
    request<{ jsonPath: string; mdPath: string; count: number }>("/sessions/export", {
      method: "POST",
      body: JSON.stringify({ edition, workspaceId }),
    }),

  /* 设置 */
  getSettings: () => request<{ settings: Settings }>("/settings"),
  saveSettings: (settings: Partial<Settings>) =>
    request<{ settings: Settings }>("/settings", { method: "POST", body: JSON.stringify({ settings }) }),
  getAbout: () =>
    request<{ name: string; version: string; description: string; references: string[] }>("/about"),
  checkUpdate: (force = false) => request<UpdateInfo>(`/update/check${force ? "?force=1" : ""}`),
  startUpdateDownload: () => request<UpdateDownloadStatus>("/update/download", { method: "POST", body: "{}" }),
  getUpdateDownloadStatus: () => request<UpdateDownloadStatus>("/update/download/status"),
  installUpdate: () => request<{ ok: boolean }>("/update/install", { method: "POST", body: "{}" }),
};
