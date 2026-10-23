/** 全局账号状态（zustand） */
import { create } from "zustand";
import * as api from "@/lib/api";
import type { Account, AppStatus, QuotaInfo } from "@/lib/types";

interface AccountsState {
  accounts: Account[];
  status: AppStatus | null;
  loading: boolean;
  error: string;
  creditMap: Record<string, QuotaInfo>;
  creditLoadingMap: Record<string, boolean>;
  creditErrorMap: Record<string, string>;
  refreshingCredits: boolean;
  fetchAll: () => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  importLocal: (edition: string) => Promise<Account>;
  refreshCredits: (ids: string[]) => Promise<void>;
  ensureCredits: (ids: string[]) => Promise<void>;
  setAccountGroupLocal: (id: string, group: string) => void;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  status: null,
  loading: false,
  error: "",
  creditMap: {},
  creditLoadingMap: {},
  creditErrorMap: {},
  refreshingCredits: false,

  async fetchAll() {
    set({ loading: true, error: "" });
    try {
      const [accountsRes, statusRes] = await Promise.all([api.api.listAccounts(), api.api.getStatus()]);
      set({ accounts: accountsRes.accounts, status: statusRes, loading: false });
    } catch (e) {
      set({ error: api.asError(e), loading: false });
    }
  },

  async deleteAccount(id) {
    await api.api.deleteAccount(id);
    set((s) => {
      const creditMap = { ...s.creditMap };
      const creditLoadingMap = { ...s.creditLoadingMap };
      const creditErrorMap = { ...s.creditErrorMap };
      delete creditMap[id];
      delete creditLoadingMap[id];
      delete creditErrorMap[id];
      return { accounts: s.accounts.filter((a) => a.id !== id), creditMap, creditLoadingMap, creditErrorMap };
    });
  },

  async importLocal(edition) {
    const res = await api.api.importClientAccount(edition);
    set((s) => ({ accounts: [...s.accounts.filter((a) => a.id !== res.account.id), res.account] }));
    return res.account;
  },

  async ensureCredits(ids) {
    const pending = ids.filter(
      (id) => !get().creditMap[id] && !get().creditLoadingMap[id] && !get().creditErrorMap[id],
    );
    if (pending.length === 0) return;
    set((s) => {
      const next = { ...s.creditLoadingMap };
      for (const id of pending) next[id] = true;
      return { creditLoadingMap: next };
    });
    const entries = await Promise.all(
      pending.map(async (id) => {
        try {
          const res = await api.api.getCredit(id);
          return { id, usage: res.usage, plan: res.plan, error: "" };
        } catch (e) {
          return { id, usage: null, plan: null, error: api.asError(e) };
        }
      }),
    );
    set((s) => {
      const creditMap = { ...s.creditMap };
      const creditLoadingMap = { ...s.creditLoadingMap };
      const creditErrorMap = { ...s.creditErrorMap };
      let accounts = s.accounts;
      for (const entry of entries) {
        if (entry.usage) {
          creditMap[entry.id] = entry.usage;
          delete creditErrorMap[entry.id];
          accounts = accounts.map((a) =>
            a.id === entry.id
              ? {
                  ...a,
                  plan: entry.plan ?? a.plan,
                  quota: entry.usage.quota
                    ? {
                        ...entry.usage.quota,
                        expiresAt: entry.usage.expiresAt,
                        isQuotaExceeded: entry.usage.isQuotaExceeded,
                        totalUsagePercentage: entry.usage.totalUsagePercentage,
                        updatedAt: Date.now(),
                      }
                    : a.quota,
                }
              : a,
          );
        } else {
          creditErrorMap[entry.id] = entry.error;
        }
        creditLoadingMap[entry.id] = false;
      }
      return { creditMap, creditLoadingMap, creditErrorMap, accounts };
    });
  },

  async refreshCredits(ids) {
    if (ids.length === 0) return;
    set({ refreshingCredits: true });
    try {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const res = await api.api.getCredit(id);
            return { id, usage: res.usage, plan: res.plan, error: "" };
          } catch (e) {
            return { id, usage: null, plan: null, error: api.asError(e) };
          }
        }),
      );
      set((s) => {
        const creditMap = { ...s.creditMap };
        const creditErrorMap = { ...s.creditErrorMap };
        let accounts = s.accounts;
        for (const entry of entries) {
          if (entry.usage) {
            creditMap[entry.id] = entry.usage;
            delete creditErrorMap[entry.id];
            accounts = accounts.map((a) =>
              a.id === entry.id
                ? {
                    ...a,
                    plan: entry.plan ?? a.plan,
                    quota: entry.usage.quota
                      ? {
                          ...entry.usage.quota,
                          expiresAt: entry.usage.expiresAt,
                          isQuotaExceeded: entry.usage.isQuotaExceeded,
                          totalUsagePercentage: entry.usage.totalUsagePercentage,
                          updatedAt: Date.now(),
                        }
                      : a.quota,
                  }
                : a,
            );
          } else {
            creditErrorMap[entry.id] = entry.error;
          }
        }
        return { creditMap, creditErrorMap, accounts };
      });
    } finally {
      set({ refreshingCredits: false });
    }
  },

  setAccountGroupLocal(id, group) {
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, group } : a)) }));
  },
}));
