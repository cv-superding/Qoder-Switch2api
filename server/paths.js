import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** 本工具自己的数据目录：~/.qoder-switch */
export function dataDir() {
  const home = os.homedir();
  return path.join(home, ".qoder-switch");
}

export function dataFile(name) {
  return path.join(dataDir(), name);
}

export function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}

/**
 * Qoder 客户端数据目录（Electron userData）。
 * Windows: %APPDATA%/<dir>
 * macOS:   ~/Library/Application Support/<dir>
 * Linux:   ~/.config/<dir>
 */
export function clientDataDir(dirName) {
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), dirName);
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", dirName);
    default:
      return path.join(os.homedir(), ".config", dirName);
  }
}

/** 某个档位实际使用的客户端目录（取第一个存在的候选，可被设置覆盖） */
export function resolveClientDir(edition, override) {
  if (override) return override;
  for (const name of edition.clientDirs) {
    const dir = clientDataDir(name);
    if (fs.existsSync(dir)) return dir;
  }
  // 都不存在时返回默认候选，供 UI 展示
  return clientDataDir(edition.clientDirs[0]);
}

/** 旧版客户端共享缓存目录（machine id / machine token） */
export function sharedClientCacheDir(clientDir) {
  return path.join(clientDir, "SharedClientCache");
}

/** state.vscdb（旧版客户端会话/登录态） */
export function globalStorageDb(clientDir) {
  return path.join(clientDir, "User", "globalStorage", "state.vscdb");
}

/** 新版客户端登录态文件 */
export function authDatPath(clientDir) {
  return path.join(clientDir, "auth.v1.dat");
}

/** 新版客户端会话数据库 */
export function mainDbPath(clientDir) {
  return path.join(clientDir, "main.sqlite");
}

/** 新版客户端 machine id 文件 */
export function machineIdPath(clientDir) {
  return path.join(clientDir, "auth.machine-id");
}

/** Electron Local State（OSCrypt 密钥所在） */
export function localStatePath(clientDir) {
  return path.join(clientDir, "Local State");
}

export function workspaceStorageDir(clientDir) {
  return path.join(clientDir, "User", "workspaceStorage");
}
