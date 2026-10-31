/**
 * 官方桌面端原生风控身份（活动平台 /sash/... 必需真实机器身份）。
 *
 * 服务端按 Cosy-Machine* 头过滤设备定向活动：只带 Cosy-ClientType/Version 时
 * 「每日领取 100 Credits」会被静默过滤，列表里只剩营销活动（实测国际版）。
 * 派生出来的假机器身份同样会被整条过滤，因此只有拿到**真实**身份（官方
 * 客户端同款 resources/umid/runtime-info 原生桥）时才发送机器头。
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EDITIONS } from "../editions.js";
import { loadJson, saveJson } from "../store.js";

const IDENTITY_TTL_MS = 30 * 60 * 1000;
const BRIDGE_TIMEOUT_MS = 25000;
const IDENTITY_FILE = "machine-identity.json";

/** runtime-info 环境码：国内版 ONLINE=0，国际版 US_ONLINE=3（对齐桌面端区域映射） */
const ENV_CODE = { domestic: "0", international: "3" };

const memory = new Map(); // edition -> { at, data }
const exeCache = new Map(); // edition -> path（找到后缓存一段时间）

function bridgeExeName() {
  return process.platform === "win32" ? "runtime-info.exe" : "runtime-info";
}

/** 从客户端安装目录定位原生桥：<install>/resources/umid/runtime-info[.exe] */
export function runtimeInfoExe(exePath) {
  if (!exePath) return "";
  const root = path.dirname(exePath);
  const name = bridgeExeName();
  for (const sub of ["resources", "Resources"]) {
    const p = path.join(root, sub, "umid", name);
    if (fs.existsSync(p)) return p;
  }
  return "";
}

/** 桌面端版本号（Cosy-Version）：从版本化安装路径推导，失败回退 */
export function clientVersionFromExe(exePath, fallback = "0.4.8") {
  if (exePath) {
    const m = /[\\/](\d+\.\d+\.\d+)[\\/][^\\/]+$/.exec(exePath);
    if (m) return m[1];
  }
  return fallback;
}

/** 与官方同形的机器 ID：uid + 固定盐派生 UUIDv4 形态，同账号稳定 */
export function deriveMachineId(uid) {
  const h = crypto.createHash("md5").update(`machine:${uid || "anonymous"}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function machineOs() {
  switch (process.platform) {
    case "win32":
      return "x86_64_win32";
    case "darwin":
      return "aarch64_darwin";
    default:
      return "x86_64_linux";
  }
}

function cachedIdentity(editionValue) {
  const hit = memory.get(editionValue);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.data;
  const disk = loadJson(IDENTITY_FILE, {}) || {};
  const rec = disk[editionValue];
  if (rec?.data?.machineToken && Date.now() - Number(rec.at || 0) < IDENTITY_TTL_MS) {
    memory.set(editionValue, { at: Number(rec.at), data: rec.data });
    return rec.data;
  }
  return null;
}

function storeIdentity(editionValue, data) {
  const rec = { at: Date.now(), data };
  memory.set(editionValue, rec);
  const disk = loadJson(IDENTITY_FILE, {}) || {};
  disk[editionValue] = rec;
  try {
    saveJson(IDENTITY_FILE, disk);
  } catch {
    /* 缓存写失败不影响请求 */
  }
}

/** 调原生桥；失败/超时返回 null */
function runBridge(exe, envCode, uid) {
  return new Promise((resolve) => {
    const args = [envCode];
    const useStdin = (process.platform === "win32" || process.platform === "darwin") && Boolean(uid);
    if (useStdin) args.push("--account-stdin");
    let proc;
    try {
      proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const finish = (value) => {
      clearTimeout(timer);
      try {
        proc.stdin?.destroy();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      finish(null);
    }, BRIDGE_TIMEOUT_MS);
    proc.on("error", () => finish(null));
    proc.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    proc.on("close", () => {
      const line = out.trim().split("\n")[0];
      let data = null;
      try {
        data = line ? JSON.parse(line) : null;
      } catch {
        data = null;
      }
      finish(data);
    });
    if (proc.stdin) {
      proc.stdin.on("error", () => {});
      if (useStdin) proc.stdin.write(`${JSON.stringify({ account: uid })}\n`);
      proc.stdin.end();
    }
  });
}

/**
 * 取真实机器身份（机器级，同机多账号共用）。仅国际版活动链路需要；
 * 无原生桥或调用失败返回 null（调用方应**不带**任何 machine 头）。
 */
export async function getMachineIdentity(editionValue, { exePath = "", uid = "" } = {}) {
  if (editionValue !== "international") return null;
  const hit = cachedIdentity(editionValue);
  if (hit) return hit;

  let resolved = exePath || exeCache.get(editionValue) || "";
  if (typeof resolved !== "string") resolved = "";
  if (!resolved) {
    try {
      const switcher = await import("../switcher.js");
      resolved = (await switcher.findClientExe(EDITIONS[editionValue] ?? EDITIONS.domestic)) || "";
    } catch {
      resolved = "";
    }
    if (resolved) exeCache.set(editionValue, resolved);
  }
  const bridge = runtimeInfoExe(resolved);
  if (!bridge) return null;

  const data = await runBridge(bridge, ENV_CODE[editionValue] || "3", uid);
  const machineToken = String(data?.machineToken || "").trim();
  const machineType = String(data?.machineType || "").trim();
  const machineCode = String(data?.machineCode || "").trim();
  if (!machineToken || !machineType || !machineCode) return null;
  const ident = { machineToken, machineType, machineCode };
  storeIdentity(editionValue, ident);
  return ident;
}

export function hostName() {
  return os.hostname();
}
