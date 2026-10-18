/**
 * 反代用量统计：请求数、Token 消耗，按账号 / 模型 / 日期聚合。
 * 落盘 ~/.qoder-switch/usage.json（保留最近 5000 条明细 + 聚合视图）。
 */
import { loadJson, saveJson } from "../store.js";

const MAX_RECORDS = 5000;

function emptyState() {
  return { records: [], totals: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, errors: 0 } };
}

export function recordUsage(entry) {
  const state = loadJson("usage.json", null) || emptyState();
  const record = {
    ts: Date.now(),
    edition: entry.edition,
    accountId: entry.accountId || "",
    accountName: entry.accountName || "",
    model: entry.model || "auto",
    promptTokens: entry.promptTokens || 0,
    completionTokens: entry.completionTokens || 0,
    totalTokens: entry.totalTokens || 0,
    durationMs: entry.durationMs || 0,
    success: entry.success !== false,
    error: entry.error || "",
    api: entry.api || "chat",
  };
  state.records.push(record);
  if (state.records.length > MAX_RECORDS) {
    state.records = state.records.slice(-MAX_RECORDS);
  }
  saveJson("usage.json", state);
  return record;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function usageStats(edition) {
  const state = loadJson("usage.json", null) || emptyState();
  const records = edition ? state.records.filter((r) => r.edition === edition) : state.records;
  const totals = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, errors: 0 };
  const byAccount = new Map();
  const byModel = new Map();
  const byDay = new Map();
  const byApi = new Map();

  for (const r of records) {
    totals.requests += 1;
    totals.promptTokens += r.promptTokens || 0;
    totals.completionTokens += r.completionTokens || 0;
    totals.totalTokens += r.totalTokens || 0;
    if (!r.success) totals.errors += 1;

    const accKey = r.accountName || r.accountId || "未知账号";
    byAccount.set(accKey, mergeBucket(byAccount.get(accKey), r));
    byModel.set(r.model || "auto", mergeBucket(byModel.get(r.model || "auto"), r));
    byApi.set(r.api || "chat", mergeBucket(byApi.get(r.api || "chat"), r));
    const day = dayKey(r.ts);
    byDay.set(day, mergeBucket(byDay.get(day), r));
  }

  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30);
  return {
    totals,
    byAccount: [...byAccount.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.requests - a.requests),
    byModel: [...byModel.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.requests - a.requests),
    byApi: [...byApi.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.requests - a.requests),
    daily: days.map(([day, v]) => ({ day, ...v })),
    recent: records.slice(-50).reverse(),
  };
}

function mergeBucket(prev, r) {
  const base = prev || { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, errors: 0 };
  base.requests += 1;
  base.promptTokens += r.promptTokens || 0;
  base.completionTokens += r.completionTokens || 0;
  base.totalTokens += r.totalTokens || 0;
  if (!r.success) base.errors += 1;
  return base;
}
