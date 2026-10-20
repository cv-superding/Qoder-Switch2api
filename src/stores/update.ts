/** 版本更新检查（全局共享，避免多个页面重复请求） */
import { create } from "zustand";
import * as api from "@/lib/api";
import type { UpdateInfo } from "@/lib/types";

interface UpdateState {
  info: UpdateInfo | null;
  checking: boolean;
  error: string;
  checkedAt: number;
  check: (force?: boolean) => Promise<UpdateInfo | null>;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  info: null,
  checking: false,
  error: "",
  checkedAt: 0,

  async check(force = false) {
    if (get().checking) return get().info;
    set({ checking: true, error: "" });
    try {
      const info = await api.api.checkUpdate(force);
      set({ info, checking: false, checkedAt: Date.now() });
      return info;
    } catch (e) {
      set({ checking: false, error: api.asError(e) });
      return null;
    }
  },
}));
