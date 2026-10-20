/**
 * 冒烟测试：在 Node 中以 SSR 方式渲染整个 App，捕获组件树运行时错误。
 * 不替代浏览器验证，但能抓住导入缺失、渲染崩溃、路由错误等问题。
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = path.join(ROOT, ".smoke");

// ---- 浏览器全局桩 ----
const store = new Map();
(globalThis).localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
(globalThis).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis).window = globalThis;
try {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "smoke" }, configurable: true });
} catch {
  /* navigator 已有定义时忽略 */
}
const fakeEl = () => ({
  style: {},
  setAttribute() {},
  appendChild() {},
  remove() {},
  classList: { add() {}, remove() {}, toggle() {} },
});
(globalThis).document = {
  title: "",
  head: fakeEl(),
  body: fakeEl(),
  createElement: fakeEl,
  createTextNode: () => fakeEl(),
  getElementsByTagName: () => [fakeEl()],
  documentElement: { classList: { add() {}, remove() {}, toggle() {} }, style: {} },
  addEventListener() {},
  removeEventListener() {},
};
(globalThis).location = { hash: "", pathname: "/", search: "", href: "http://127.0.0.1:8787/", origin: "http://127.0.0.1:8787" };
(globalThis).history = {
  state: null, length: 1,
  pushState() {}, replaceState() {}, go() {}, back() {}, forward() {},
  listen() { return () => {}; },
};

await rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// 入口：SSR 渲染各页面（用 MemoryRouter 绕开 HashRouter 的 window.history 依赖）
const entry = path.join(TMP, "entry.tsx");
writeFileSync(
  entry,
  `
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import AccountsPage from ${JSON.stringify(path.join(ROOT, "src", "pages", "AccountsPage"))};
import ApiProxyPage from ${JSON.stringify(path.join(ROOT, "src", "pages", "ApiProxyPage"))};
import TokenStatsPage from ${JSON.stringify(path.join(ROOT, "src", "pages", "TokenStatsPage"))};
import CreditStatsPage from ${JSON.stringify(path.join(ROOT, "src", "pages", "CreditStatsPage"))};
import SessionsPage from ${JSON.stringify(path.join(ROOT, "src", "pages", "SessionsPage"))};
import SettingsPage from ${JSON.stringify(path.join(ROOT, "src", "pages", "SettingsPage"))};

const pages = [
  ["AccountsPage", AccountsPage, {}],
  ["ApiProxyPage-domestic", ApiProxyPage, { edition: "domestic" }],
  ["ApiProxyPage-international", ApiProxyPage, { edition: "international" }],
  ["TokenStatsPage", TokenStatsPage, {}],
  ["CreditStatsPage", CreditStatsPage, {}],
  ["SessionsPage", SessionsPage, {}],
  ["SettingsPage", SettingsPage, {}],
];

let failures = 0;
for (const [name, Comp, props] of pages) {
  try {
    const html = renderToString(
      createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(Comp, props)),
    );
    const checks = ["Qoder-Switch2api", "账号管理", "OAuth 登录", "国内版", "国际版"];
    const found = checks.filter((c) => html.includes(c));
    console.log("SMOKE_OK:" + name + " html=" + html.length + " found=" + found.join("/"));
    if (html.length < 500) { console.log("SMOKE_SUSPICIOUS:" + name + " html too short"); failures += 1; }
  } catch (e) {
    console.log("SMOKE_RENDER_ERROR:" + name + ": " + (e && e.stack ? e.stack : String(e)));
    failures += 1;
  }
}
if (failures > 0) process.exitCode = 1;
`,
  "utf8",
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "cjs",
  jsx: "automatic",
  outfile: path.join(TMP, "bundle.cjs"),
  platform: "node",
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".png": "dataurl", ".svg": "text" },
  logLevel: "error",
  external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
});

console.log("BUNDLE_OK");
await import(pathToFileURL(path.join(TMP, "bundle.cjs")).href);
console.log("IMPORT_DONE");

await rmSync(TMP, { recursive: true, force: true });
