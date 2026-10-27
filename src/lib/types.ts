/** 与后端一致的类型定义 */

export type Edition = "domestic" | "international";

export const EDITIONS: { value: Edition; label: string; product: string }[] = [
  { value: "domestic", label: "国内版", product: "Qoder CN" },
  { value: "international", label: "国际版", product: "Qoder" },
];

export function editionLabel(value: string): string {
  return EDITIONS.find((e) => e.value === value)?.label ?? "国内版";
}

export function isInternational(account: Account): boolean {
  return account.edition === "international";
}

export interface Account {
  id: string;
  edition: Edition;
  label: string;
  name: string;
  email: string;
  phone: string;
  avatarUrl: string;
  uid: string;
  userType: string;
  orgId: string;
  orgName: string;
  group: string;
  authSource: string;
  status: "active" | "needs_relogin" | "disabled";
  lastError: string;
  lastUsedAt: number | null;
  lastSwitchAt: number | null;
  tokenExpireAt: number | null;
  refreshTokenExpiresAt: number | null;
  machineId: string;
  quota: {
    total: number | null;
    used: number | null;
    remaining: number | null;
    percentage: number | null;
    unit: string;
    expiresAt: number | null;
    updatedAt: number;
    isQuotaExceeded?: boolean;
    totalUsagePercentage?: number | null;
    plan?: QuotaPart | null;
    addOn?: QuotaPart | null;
    packages?: QuotaPackage[];
    shared?: QuotaPackage | null;
  } | null;
  plan: PlanInfo | null;
  createdAt: number;
  updatedAt: number;
  hasToken: boolean;
  hasRefreshToken: boolean;
  hasPat: boolean;
  tokenMask: string;
  cooling: boolean;
}

export interface ClientInfo {
  edition: Edition;
  dir: string;
  exists: boolean;
  authKind: string | null;
  hasAuthFile: boolean;
  hasOscryptKey: boolean;
  machineId: string;
  clientExePath: string;
  sqlite: boolean;
}

export interface ProxyConfig {
  enabled: boolean;
  listen: string;
  apiKey: string;
  extraModels: string[];
  accountGroup: string;
}

export interface ProxyStatus extends ProxyConfig {
  running: boolean;
  hasApiKey: boolean;
  error: string;
}

export interface EditionStatus {
  client: ClientInfo;
  currentAccount: { uid: string; name: string; email: string; id: string; at: number } | null;
  proxy: ProxyStatus;
  accounts: number;
  proxyAccounts: number;
}

export interface AppStatus {
  version: string;
  editions: { domestic: EditionStatus; international: EditionStatus };
  counts: { domestic: number; international: number; proxyDomestic: number; proxyInternational: number };
  sqlite: boolean;
}

export type CheckinState = "checked" | "claimable" | "none" | "unavailable" | "error";

export interface QuotaPart {
  total: number | null;
  used: number | null;
  remaining: number | null;
  percentage: number | null;
  unit: string;
}

export interface QuotaPackage {
  id?: string;
  name: string;
  total: number | null;
  used: number | null;
  remaining: number | null;
  percentage?: number | null;
  unit: string;
  expiresAt?: number | null;
  available?: boolean;
  unlimited?: boolean;
}

export interface QuotaInfo {
  usageType: string;
  totalUsagePercentage: number | null;
  isQuotaExceeded: boolean;
  expiresAt: number | null;
  quota: {
    total: number | null;
    used: number | null;
    remaining: number | null;
    percentage: number | null;
    unit: string;
    plan?: QuotaPart | null;
    addOn?: QuotaPart | null;
    packages?: QuotaPackage[];
    shared?: QuotaPackage | null;
  } | null;
}

export interface PlanInfo {
  userType: string;
  planTierName: string;
  isPersonalVersion?: boolean;
  startDate?: number | null;
  endDate: number | null;
}

export interface AutoCheckinLast {
  at: number;
  day: string;
  result: "success" | "partial" | "failed" | "already" | "idle";
  claimed: number;
  replayed: number;
  failed: number;
  pending: number;
  hour: number;
}

export interface KeepaliveStatus {
  enabled: boolean;
  last: { at: number; refreshed: number; failed: number } | null;
}

export interface AutoCheckinStatus {
  autoCheckin: { enabled: boolean; hour: number };
  last: AutoCheckinLast | null;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  downloadUrl: string;
  releaseName: string;
  publishedAt: string | null;
  notes: string;
}

export interface UpdateDownloadStatus {
  state: "idle" | "downloading" | "done" | "error" | string;
  downloaded: number;
  total: number;
  percent: number;
  path: string;
  error: string;
  version: string;
}

export interface UsageStats {
  totals: { requests: number; promptTokens: number; completionTokens: number; totalTokens: number; errors: number };
  byAccount: { name: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number; errors: number }[];
  byModel: { name: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number; errors: number }[];
  byApi: { name: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number; errors: number }[];
  daily: { day: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number; errors: number }[];
  recent: {
    ts: number; edition: string; accountName: string; model: string;
    promptTokens: number; completionTokens: number; totalTokens: number;
    success: boolean; error: string; api: string;
  }[];
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  chatCount: number;
}

export interface ChatItem {
  id: string;
  title: string;
  timestamp: number | null;
  sessionId: string;
  contexts: { id: string; name: string; type: string }[];
}

export interface Settings {
  theme: "light" | "dark" | "system";
  closeToTray: boolean;
  tokenKeepalive: boolean;
  clientDirOverrides: { domestic: string; international: string };
  clientExePaths: { domestic: string; international: string };
  autoCheckin: { enabled: boolean; hour: number };
  endpointOverrides: Record<string, Record<string, string>>;
  proxy: { domestic: ProxyConfig; international: ProxyConfig };
}

export interface CheckinResult {
  id: string;
  name: string;
  result: "success" | "already" | "none" | "error";
  rewardCredit?: number | null;
  error?: string;
}

export interface BackupResult {
  imported: number;
  skipped: { index: number; name: string; error: string }[];
}

export const ACCOUNT_GROUPS = [
  { value: "", label: "未分组" },
  { value: "desktop", label: "桌面端" },
  { value: "proxy", label: "反代API" },
];

export function accountGroupLabel(group: string | undefined): string {
  return ACCOUNT_GROUPS.find((g) => g.value === (group ?? ""))?.label ?? "未分组";
}
