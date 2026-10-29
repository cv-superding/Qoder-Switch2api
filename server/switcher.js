/**
 * Qoder 客户端账号切换。
 *
 * 新版客户端（当前主流）登录态在数据目录根下的 auth.v1.dat：
 *   Chromium OSCrypt v10 加密（AES-256-GCM），密钥在 Local State 的
 *   os_crypt.encrypted_key（Windows 走 DPAPI 解包）。
 *   明文 JSON：{ schemaVersion, token, refreshToken, expiresAt,
 *                refreshTokenExpiresAt, user:{ id, name, email, phone } }
 *
 * 旧版客户端登录态在 User/globalStorage/state.vscdb 的
 *   secret://aicoding.auth.userInfo（同一把 OSCrypt 密钥）。
 *
 * 切换流程：备份当前登录态 → 结束客户端进程 → 写入目标账号 → 重启客户端。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveClientDir,
  authDatPath,
  globalStorageDb,
  localStatePath,
  machineIdPath,
} from "./paths.js";
import { loadOscryptKey, oscryptDecrypt, oscryptEncrypt } from "./crypto.js";
import { accountManager } from "./qoder/account.js";
import { EDITIONS } from "./editions.js";

const execFileAsync = promisify(execFile);

let sqliteMod = null;
let sqliteChecked = false;

/** 惰性加载 node:sqlite（Node >= 22.5，需 --experimental-sqlite） */
async function getSqlite() {
  if (sqliteChecked) return sqliteMod;
  sqliteChecked = true;
  try {
    sqliteMod = await import("node:sqlite");
  } catch {
    sqliteMod = null;
  }
  return sqliteMod;
}

export function sqliteAvailable() {
  return Boolean(sqliteMod);
}

/* ------------------------------------------------------------------ */
/* 客户端探测                                                          */
/* ------------------------------------------------------------------ */

export async function detectClient(editionValue, settings = {}) {
  const edition = EDITIONS[editionValue] || EDITIONS.domestic;
  const dir = resolveClientDir(edition, settings.clientDirOverrides?.[editionValue]);
  const authDat = authDatPath(dir);
  const vscdb = globalStorageDb(dir);
  const exists = fs.existsSync(dir);
  const authKind = fs.existsSync(authDat) ? "auth.v1.dat" : fs.existsSync(vscdb) ? "state.vscdb" : null;
  return {
    edition: editionValue,
    dir,
    exists,
    authKind,
    hasAuthFile: Boolean(authKind),
    hasOscryptKey: Boolean(await loadOscryptKey(dir).catch(() => null)),
    machineId: readMachineIdFile(dir),
    clientExePath: settings.clientExePaths?.[editionValue] || (await findClientExe(edition)) || "",
    sqlite: Boolean(await getSqlite()),
  };
}

function readMachineIdFile(dir) {
  try {
    const p = machineIdPath(dir);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  } catch {
    /* ignore */
  }
  return "";
}

/** 在注册表 / 常见路径中查找客户端可执行文件 */
const exeCache = new Map(); // edition -> { at, path }
const EXE_CACHE_MS = 60 * 1000;

/** 从正在运行的进程读取真实安装路径（支持自定义安装目录 / 版本化目录） */
async function findRunningClientExe(edition) {
  if (process.platform !== "win32") return null;
  const script = `
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -eq 'Qoder' -or $_.ProcessName -eq 'QoderCN' } |
  ForEach-Object { try { $_.Path } catch {} } |
  Where-Object { $_ } |
  Select-Object -Unique
`.trim();
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const paths = String(stdout).split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    if (paths.length === 0) return null;
    const isCnPath = (p) => /qoder[\s._-]*cn|qodercn/i.test(p);
    const preferred = edition.value === "domestic" ? paths.filter(isCnPath) : paths.filter((p) => !isCnPath(p));
    // 无法确定进程属于当前版本时宁可不结束，避免误杀另一版本
    return preferred[0] || null;
  } catch {
    return null;
  }
}

/** 从 Windows 卸载注册表定位自定义安装目录（如 F:\AdobeAll\Qoder CN） */
async function findRegistryClientExe(edition) {
  try {
    const script = [
      "$keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')",
      "$items = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Qoder*' } | ForEach-Object { [pscustomobject]@{ Name = $_.DisplayName; Icon = $_.DisplayIcon; Uninstall = $_.UninstallString } }",
      "$items | ConvertTo-Json -Compress",
    ].join("\n");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    const parsed = JSON.parse(stdout.trim() || "[]");
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const targetExe = edition.value === "domestic" ? "Qoder CN.exe" : "Qoder.exe";
    for (const item of items) {
      const name = String(item.Name || "");
      const isCN = /Qoder\s*CN|QoderCN/i.test(name);
      if (edition.value === "domestic" ? !isCN : isCN) continue;
      const rawPaths = [item.Icon, item.Uninstall]
        .map((raw) => String(raw || "").trim())
        .filter(Boolean)
        .flatMap((raw) => {
          const quoted = [...raw.matchAll(/"([^"]+\.exe)"/gi)].map((m) => m[1]);
          const first = raw.split(/\s+/)[0].replace(/^"|"$/g, "");
          const icon = raw.split(",")[0].replace(/^"|"$/g, "");
          return [...quoted, first, icon];
        })
        .filter((p) => /\.(exe|ico)$/i.test(p));
      for (const file of rawPaths) {
        if (path.basename(file).toLowerCase() === targetExe.toLowerCase() && fs.existsSync(file)) return file;
        const root = path.dirname(file);
        const candidates = [path.join(root, targetExe)];
        const versionsDir = path.join(root, ".qoder-versions");
        try {
          const versions = fs.readdirSync(versionsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          for (const version of versions) candidates.push(path.join(versionsDir, version, targetExe));
        } catch {
          /* no versioned dir */
        }
        candidates.push(path.join(root, "resources", "launcher", edition.value === "domestic" ? "Qoder CN Launcher.exe" : "Qoder Launcher.exe"));
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  } catch {
    /* 注册表不可用时退回常规探测 */
  }
  return null;
}

export async function findClientExe(edition) {
  const cached = exeCache.get(edition.value);
  if (cached && Date.now() - cached.at < (cached.path ? EXE_CACHE_MS : 15_000)) return cached.path;

  let found = await findRunningClientExe(edition);
  if (!found && process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const names = edition.clientDirs.map((d) => d.replace(/[^\w\s-]/g, ""));
    const launcherNames = edition.value === "domestic" ? ["Qoder CN", "QoderCN"] : ["Qoder"];
    const genericNames = edition.value === "international" ? ["Qoder"] : [];
    const candidates = [];
    for (const base of [localAppData && path.join(localAppData, "Programs"), programFiles, path.join(programFiles, "x86")]) {
      if (!base) continue;
      for (const name of [...new Set([...names, ...genericNames])]) {
        candidates.push(path.join(base, name, "Qoder.exe"));
        candidates.push(path.join(base, name, `${name}.exe`));
      }
    }
    if (localAppData) {
      const launcherDirs = edition.value === "domestic"
        ? [["Qoder CN", "Qoder CN Launcher", "Qoder CN Launcher.exe"], ["Qoder CN", "Qoder Launcher", "Qoder Launcher.exe"]]
        : [["Qoder", "Qoder Launcher", "Qoder Launcher.exe"]];
      for (const parts of launcherDirs) {
        candidates.push(path.join(localAppData, ...parts));
      }
    }
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          found = candidate;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (!found && process.platform === "win32") {
    found = await findRegistryClientExe(edition);
  }
  found = resolveLauncherExecutable(found);
  exeCache.set(edition.value, { at: Date.now(), path: found });
  return found;
}

/** Qoder 启动器不是主进程；按 state.ini 找到实际运行的版本化 exe，保证按路径精确结束进程 */
function resolveLauncherExecutable(exePath) {
  if (!exePath || !/Launcher\.exe$/i.test(exePath)) return exePath;
  const dir = path.dirname(exePath);
  for (const name of ["state.ini", "install.ini"]) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const values = {};
      for (const line of raw.split(/\r?\n/)) {
        const idx = line.indexOf("=");
        if (idx > 0) values[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      if (values.installDir && values.appExecutable) {
        const actual = path.resolve(values.installDir, values.appExecutable);
        if (fs.existsSync(actual)) return actual;
      }
    } catch {
      /* try next ini */
    }
  }
  return exePath;
}

/* ------------------------------------------------------------------ */
/* 读取客户端当前登录态                                                */
/* ------------------------------------------------------------------ */

/**
 * 读取客户端当前登录态。
 * 返回 { source, token, refreshToken, expiresAt, refreshTokenExpiresAt, user, machineId } 或 null。
 */
export async function readClientAuth(editionValue, settings = {}) {
  const edition = EDITIONS[editionValue] || EDITIONS.domestic;
  const dir = resolveClientDir(edition, settings.clientDirOverrides?.[editionValue]);

  // 新版：auth.v1.dat
  const authDat = authDatPath(dir);
  if (fs.existsSync(authDat)) {
    const key = await loadOscryptKey(dir);
    if (!key) {
      throw new Error(
        "无法解出客户端 OSCrypt 密钥（需要 Windows DPAPI；请在本机运行，且 Local State 完好）。macOS/Linux 暂不支持自动读取。",
      );
    }
    const plain = oscryptDecrypt(key, fs.readFileSync(authDat));
    const json = JSON.parse(plain.toString("utf8"));
    return normalizeAuth(json, "auth.v1.dat", dir);
  }

  // 旧版：state.vscdb 的 secret://aicoding.auth.userInfo
  const vscdb = globalStorageDb(dir);
  if (fs.existsSync(vscdb)) {
    const sqlite = await getSqlite();
    if (!sqlite) throw new Error("当前 Node 不支持 node:sqlite，无法读取 state.vscdb（请用 Node >= 22.5 并加 --experimental-sqlite 启动）");
    const key = await loadOscryptKey(dir).catch(() => null);
    const db = new sqlite.DatabaseSync(vscdb, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("secret://aicoding.auth.userInfo");
      if (!row) return null;
      let json = null;
      const value = row.value;
      if (Buffer.isBuffer(value)) {
        const buf = value;
        if (buf.length > 3 && buf.subarray(0, 3).toString("utf8") === "v10" && key) {
          json = JSON.parse(oscryptDecrypt(key, buf).toString("utf8"));
        } else {
          json = JSON.parse(buf.toString("utf8"));
        }
      } else if (typeof value === "string") {
        json = JSON.parse(value);
      }
      if (!json) return null;
      return normalizeAuth(json, "state.vscdb", dir);
    } finally {
      db.close();
    }
  }
  return null;
}

function normalizeAuth(json, source, dir) {
  const user = json.user || {};
  return {
    source,
    token: json.token || json.securityOauthToken || "",
    refreshToken: json.refreshToken || "",
    expiresAt: json.expiresAt ?? null,
    refreshTokenExpiresAt: json.refreshTokenExpiresAt ?? null,
    user: {
      id: user.id || json.uid || "",
      name: user.name || json.name || "",
      email: user.email || json.email || "",
      phone: user.phone || json.phone || "",
    },
    machineId: readMachineIdFile(dir),
    raw: json,
  };
}

/* ------------------------------------------------------------------ */
/* 写入客户端登录态（切换）                                            */
/* ------------------------------------------------------------------ */

/**
 * 把账号写入客户端并（可选）重启。
 * onStep(step, status, detail) 用于进度反馈。
 */
export async function switchClientAccount(accountId, { restart = true, onStep } = {}) {
  const account = accountManager.get(accountId);
  if (!account) throw new Error("账号不存在");
  if (!account.securityOauthToken) {
    throw new Error("该账号没有 Qoder 客户端登录 Token（PAT / 备份占位账号不支持切换），请先重新登录");
  }
  const edition = EDITIONS[account.edition] || EDITIONS.domestic;
  const settings = globalSettings;
  const dir = resolveClientDir(edition, settings.clientDirOverrides?.[account.edition]);
  const authDat = authDatPath(dir);
  const vscdb = globalStorageDb(dir);
  const hasAuth = fs.existsSync(authDat) || fs.existsSync(vscdb);
  if (!hasAuth) {
    // 客户端已安装但从没登录过：沿用客户端的 OSCrypt 密钥新建 auth.v1.dat，
    // 不必要求用户先手动登录一次。
    if (!fs.existsSync(dir)) {
      throw new Error("未检测到客户端数据目录，请先安装并打开一次 Qoder 客户端");
    }
    const key = await loadOscryptKey(dir).catch(() => null);
    if (!key) {
      throw new Error("客户端尚未生成加密密钥，请先打开一次 Qoder 客户端再切换");
    }
  }

  const step = (name, status, detail) => onStep?.({ name, status, detail });
  const exe = await resolveClientExe(edition, settings, settings.clientDirOverrides?.[account.edition]);

  step("备份当前登录态", "running");
  const backup = await backupClientAuth(dir, authDat, vscdb);
  step("备份当前登录态", "done", backup ? `已备份到 ${path.basename(backup)}` : "无现有登录态，跳过备份");

  step("结束 Qoder 进程", "running");
  const killed = await killClientProcesses(exe);
  step(
    "结束 Qoder 进程",
    "done",
    killed > 0
      ? `已结束 ${killed} 个进程`
      : exe
        ? "未发现运行中的客户端进程"
        : "未定位客户端可执行文件，已跳过结束进程（请手动关闭 Qoder 后重试）",
  );

  step("写入目标账号", "running");
  if (fs.existsSync(authDat)) {
    await writeAuthDat(dir, authDat, account);
    step("写入目标账号", "done", "auth.v1.dat 已更新");
  } else if (fs.existsSync(vscdb)) {
    await writeVscdbAuth(vscdb, account);
    step("写入目标账号", "done", "state.vscdb 已更新");
  } else {
    await writeAuthDat(dir, authDat, account, edition);
    step("写入目标账号", "done", "已创建 auth.v1.dat");
  }

  accountManager.update(accountId, { lastSwitchAt: Date.now() });
  accountManager.setClientCurrent(account.edition, {
    uid: account.uid,
    name: account.name,
    email: account.email,
    id: account.id,
  });

  if (restart) {
    step("重启 Qoder", "running");
    if (exe) {
      await launchClient(exe);
      step("重启 Qoder", "done", `已启动 ${path.basename(exe)}`);
    } else {
      step("重启 Qoder", "error", "未找到客户端可执行文件，请手动启动（可在设置页配置路径）");
    }
  }
  return { account: accountManager.publicView(accountManager.get(accountId)), dir };
}

async function backupClientAuth(dir, authDat, vscdb) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (fs.existsSync(authDat)) {
    const dest = `${authDat}.bak-${stamp}`;
    fs.copyFileSync(authDat, dest);
    return dest;
  }
  if (fs.existsSync(vscdb)) {
    const dest = `${vscdb}.bak-${stamp}`;
    fs.copyFileSync(vscdb, dest);
    return dest;
  }
  return null;
}

/** 官方客户端的认证环境描述，新建 auth.v1.dat 时必须带上 */
function defaultAuthenticationContext(edition) {
  // Qoder 桌面端登录后写入的真实上下文（2026-10 实测）：
  //   国际版 ["https://qoder.com","https://openapi.qoder.sh","732aef47-...","prod"]
  //   国内版 ["https://qoder.cn","https://openapi.qoder.com.cn","732aef47-...","prod"]
  const desktopClientId = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa";
  return JSON.stringify([
    edition.value === "international" ? "https://qoder.com" : "https://qoder.cn",
    edition.oauth.openApiBaseUrl,
    desktopClientId,
    "prod",
  ]);
}

async function writeAuthDat(dir, authDat, account, edition) {
  const key = await loadOscryptKey(dir);
  if (!key) throw new Error("无法解出 OSCrypt 密钥，写入取消（避免损坏客户端登录态）");
  // 读取原文件结构，保留未知字段与 expiresAt 的格式
  let original = null;
  try {
    original = JSON.parse(oscryptDecrypt(key, fs.readFileSync(authDat)).toString("utf8"));
  } catch {
    original = null;
  }
  const base = original && typeof original === "object" ? original : { schemaVersion: 1 };
  const useIso = original ? typeof base.expiresAt === "string" : true;
  const auth = {
    ...base,
    schemaVersion: base.schemaVersion ?? 1,
    authenticationContext:
      base.authenticationContext ?? defaultAuthenticationContext(edition),
    token: account.securityOauthToken,
    // 切换账号时必须写入目标账号自己的值，不能沿用上一个账号的凭证/身份
    refreshToken: account.refreshToken || "",
    expiresAt: account.tokenExpireAt ? formatExpire(account.tokenExpireAt, useIso) : null,
    refreshTokenExpiresAt: account.refreshTokenExpiresAt
      ? formatExpire(account.refreshTokenExpiresAt, useIso)
      : null,
    user: {
      ...(base.user || {}),
      id: account.uid || "",
      name: account.name || "",
      email: account.email || "",
      phone: account.phone || "",
      avatarUrl: account.avatarUrl || base.user?.avatarUrl || null,
    },
  };
  const encrypted = oscryptEncrypt(key, JSON.stringify(auth));
  const tmp = `${authDat}.tmp`;
  fs.writeFileSync(tmp, encrypted);
  fs.renameSync(tmp, authDat);
}

function formatExpire(ms, useIso) {
  if (useIso) return new Date(ms).toISOString();
  return ms;
}

function mergeClientAuthJson(base, account) {
  const obj = base && typeof base === "object" ? base : {};
  return {
    ...obj,
    token: account.securityOauthToken,
    refreshToken: account.refreshToken || "",
    expiresAt: account.tokenExpireAt ?? null,
    refreshTokenExpiresAt: account.refreshTokenExpiresAt ?? null,
    uid: account.uid || "",
    user: {
      ...(obj.user || {}),
      id: account.uid || "",
      name: account.name || "",
      email: account.email || "",
      phone: account.phone || "",
    },
  };
}

async function writeVscdbAuth(vscdb, account) {
  const sqlite = await getSqlite();
  if (!sqlite) throw new Error("当前 Node 不支持 node:sqlite，无法写 state.vscdb");
  const db = new sqlite.DatabaseSync(vscdb, { readOnly: false });
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("secret://aicoding.auth.userInfo");
    const existing = row?.value
      ? Buffer.isBuffer(row.value)
        ? row.value
        : Buffer.from(String(row.value), "utf8")
      : null;
    const encrypted = Boolean(existing && existing.length > 3 && existing.subarray(0, 3).toString("utf8") === "v10");
    let base = {};
    let key = null;
    if (existing) {
      if (encrypted) {
        const dir = path.dirname(path.dirname(path.dirname(vscdb))); // .../User/globalStorage -> client dir
        key = await loadOscryptKey(dir);
        if (!key) throw new Error("无法解出 OSCrypt 密钥，写入取消");
        try {
          base = JSON.parse(oscryptDecrypt(key, existing).toString("utf8"));
        } catch {
          base = {};
        }
      } else {
        try {
          base = JSON.parse(existing.toString("utf8"));
        } catch {
          base = {};
        }
      }
    }
    const merged = mergeClientAuthJson(base, account);
    const value = encrypted && key
      ? oscryptEncrypt(key, JSON.stringify(merged))
      : Buffer.from(JSON.stringify(merged), "utf8");
    db.prepare("INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)").run(
      "secret://aicoding.auth.userInfo",
      value,
    );
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 进程管理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析客户端可执行文件。设置了数据目录覆盖时只在覆盖目录内查找，
 * 避免把机器上其它 Qoder 安装（例如自定义目录/测试目录）误判为目标客户端。
 */
export async function resolveClientExe(edition, settings = {}, overrideDir = "") {
  const configured = String(settings.clientExePaths?.[edition.value] || "").trim();
  if (configured) return configured;
  if (overrideDir) {
    const candidates = [
      path.join(overrideDir, "Qoder.exe"),
      path.join(path.dirname(overrideDir), "Qoder.exe"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return "";
  }
  return (await findClientExe(edition)) || "";
}

/**
 * 结束指定客户端进程。
 * 只按可执行文件的绝对路径精确匹配，绝不按进程名全局 taskkill / pkill，
 * 避免误杀其它 Qoder 安装或无关进程。
 */
export async function killClientProcesses(exePath) {
  const target = String(exePath || "").trim();
  if (!target) return 0;
  if (process.platform === "win32") {
    const script = `
$targets = @()
foreach ($p in ($env:QODER_TARGET_EXE -split ';;')) {
  if ($p) { try { $targets += [IO.Path]::GetFullPath($p).ToLower() } catch {} }
}
$pids = @()
foreach ($proc in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
  if (-not $proc.ExecutablePath) { continue }
  try { $full = [IO.Path]::GetFullPath($proc.ExecutablePath).ToLower() } catch { continue }
  if ($targets -contains $full) { $pids += $proc.ProcessId }
}
$pids -join ","
`.trim();
    let pids = [];
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, QODER_TARGET_EXE: target } },
      );
      pids = String(stdout).trim().split(",").map((s) => s.trim()).filter(Boolean);
    } catch {
      return 0;
    }
    let count = 0;
    for (const pid of pids) {
      try {
        await execFileAsync("taskkill", ["/F", "/PID", pid], { windowsHide: true });
        count += 1;
      } catch {
        /* 进程可能已退出 */
      }
    }
    return count;
  }
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", target], { encoding: "utf8" });
    const pids = String(stdout).split("\n").map((s) => s.trim()).filter(Boolean);
    let count = 0;
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
        count += 1;
      } catch {
        /* ignore */
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function launchClient(exePath) {
  const { spawn } = await import("node:child_process");
  const child = spawn(exePath, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

/* 设置引用（由 index.js 注入，避免循环依赖） */
export let globalSettings = {};
export function setSwitcherSettings(settings) {
  globalSettings = settings || {};
}
