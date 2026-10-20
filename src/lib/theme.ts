/** 主题：light / dark / system，持久化到 localStorage */
import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

const KEY = "qoder-switch2api.theme";
const listeners = new Set<(mode: ThemeMode) => void>();
let currentMode: ThemeMode | null = null;

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getSavedTheme(): ThemeMode | null {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : null;
}

export function applyTheme(mode: ThemeMode, { persist = true } = {}) {
  const root = document.documentElement;
  const dark = mode === "dark" || (mode === "system" && systemPrefersDark());
  root.classList.toggle("dark", dark);
  root.dataset.theme = mode;
  if (persist) localStorage.setItem(KEY, mode);
  if (currentMode !== mode) {
    currentMode = mode;
    for (const listener of listeners) listener(mode);
  }
}

export function initTheme() {
  const saved = getSavedTheme() || "light";
  applyTheme(saved, { persist: false });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (currentMode === "system") applyTheme("system", { persist: false });
  };
  media.addEventListener("change", onChange);
}

export function getTheme(): ThemeMode {
  return currentMode || getSavedTheme() || "light";
}

export function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(getTheme);
  useEffect(() => {
    const listener = (next: ThemeMode) => setMode(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return [mode, (next) => applyTheme(next)];
}
