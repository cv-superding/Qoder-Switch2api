/** 主题：light / dark / system，持久化到 localStorage */
export type ThemeMode = "light" | "dark" | "system";

const KEY = "qoder-switch2api.theme";

export function initTheme() {
  const saved = (localStorage.getItem(KEY) as ThemeMode | null) || "light";
  applyTheme(saved);
}

export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  localStorage.setItem(KEY, mode);
}

export function getTheme(): ThemeMode {
  return (localStorage.getItem(KEY) as ThemeMode | null) || "light";
}
