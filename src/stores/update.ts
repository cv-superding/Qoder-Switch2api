/** 版本更新检查与内置下载（全局共享，避免多个页面重复请求） */
import { create } from "zustand";
import * as api from "@/lib/api";
import type { UpdateDownloadStatus, UpdateInfo } from "@/lib/types";

interface UpdateState {
  info: UpdateInfo | null;
  checking: boolean;
  error: string;
  checkedAt: number;
  lastAttemptAt: number;
  download: UpdateDownloadStatus | null;
  downloading: boolean;
  readyToInstall: boolean;
  installing: boolean;
  downloadError: string;
  check: (force?: boolean) => Promise<UpdateInfo | null>;
  refreshDownload: () => Promise<void>;
  startDownload: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

let pollTimer: number | null = null;

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const useUpdateStore = create<UpdateState>((set, get) => {
  const applyDownload = (status: UpdateDownloadStatus) => {
    set({
      download: status,
      downloading: status.state === "downloading",
      readyToInstall: status.state === "done",
      downloadError: status.state === "error" ? status.error : "",
    });
    if (status.state !== "downloading") stopPolling();
  };

  const beginPolling = () => {
    stopPolling();
    pollTimer = window.setInterval(async () => {
      try {
        const status = await api.api.getUpdateDownloadStatus();
        applyDownload(status);
      } catch (e) {
        set({ downloadError: api.asError(e), downloading: false });
        stopPolling();
      }
    }, 500);
  };

  return {
    info: null,
    checking: false,
    error: "",
    checkedAt: 0,
    lastAttemptAt: 0,
    download: null,
    downloading: false,
    readyToInstall: false,
    installing: false,
    downloadError: "",

    async check(force = false) {
      if (get().checking) return get().info;
      set({ checking: true, error: "", lastAttemptAt: Date.now() });
      try {
        const info = await api.api.checkUpdate(force);
        set({ info, checking: false, checkedAt: Date.now() });
        return info;
      } catch (e) {
        set({ checking: false, error: api.asError(e) });
        return null;
      }
    },

    async refreshDownload() {
      try {
        const status = await api.api.getUpdateDownloadStatus();
        applyDownload(status);
        if (status.state === "downloading") beginPolling();
      } catch {
        /* 状态查询失败不影响页面 */
      }
    },

    async startDownload() {
      if (get().downloading) return;
      stopPolling();
      set({ downloading: true, readyToInstall: false, downloadError: "", installing: false });
      try {
        const status = await api.api.startUpdateDownload();
        applyDownload(status);
        if (status.state === "downloading") beginPolling();
      } catch (e) {
        set({ downloading: false, downloadError: api.asError(e) });
      }
    },

    async installUpdate() {
      set({ installing: true, downloadError: "" });
      try {
        await api.api.installUpdate();
      } catch (e) {
        set({ installing: false, downloadError: api.asError(e) });
        throw e;
      }
    },
  };
});
