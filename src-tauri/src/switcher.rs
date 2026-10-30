//! Qoder 客户端账号切换：
//! 备份当前登录态 → 结束客户端进程 → 写入目标账号 → 重启客户端。
//!
//! 新版客户端登录态在数据目录根下的 auth.v1.dat（OSCrypt v10）；
//! 旧版在 User/globalStorage/state.vscdb 的 secret://aicoding.auth.userInfo。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::account::Account;
use crate::crypto::{load_oscrypt_key, oscrypt_decrypt, oscrypt_encrypt};
use crate::editions::Edition;
use crate::paths::{
    auth_dat_path, global_storage_db, machine_id_path, resolve_client_dir,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub edition: String,
    pub dir: String,
    pub exists: bool,
    pub auth_kind: Option<String>,
    pub has_auth_file: bool,
    pub has_oscrypt_key: bool,
    pub machine_id: String,
    pub client_exe_path: String,
    pub sqlite: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SwitchStep {
    pub name: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct ClientAuth {
    pub source: String,
    pub token: String,
    pub refresh_token: String,
    pub expires_at: Option<Value>,
    pub refresh_token_expires_at: Option<Value>,
    pub user_id: String,
    pub user_name: String,
    pub user_email: String,
    pub user_phone: String,
    pub machine_id: String,
    pub raw: Value,
}

fn read_machine_id_file(dir: &Path) -> String {
    fs::read_to_string(machine_id_path(dir))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

pub fn detect_client(edition: &Edition, override_dir: &str, exe_override: &str) -> ClientInfo {
    let dir = resolve_client_dir(edition, override_dir);
    let auth_dat = auth_dat_path(&dir);
    let vscdb = global_storage_db(&dir);
    let auth_kind = if auth_dat.exists() {
        Some("auth.v1.dat".to_string())
    } else if vscdb.exists() {
        Some("state.vscdb".to_string())
    } else {
        None
    };
    ClientInfo {
        edition: edition.value.clone(),
        dir: dir.to_string_lossy().to_string(),
        exists: dir.exists(),
        has_auth_file: auth_kind.is_some(),
        auth_kind,
        has_oscrypt_key: load_oscrypt_key(&dir).is_some(),
        machine_id: read_machine_id_file(&dir),
        client_exe_path: if exe_override.trim().is_empty() {
            find_client_exe(edition).unwrap_or_default()
        } else {
            exe_override.to_string()
        },
        sqlite: true,
    }
}

/// 读取客户端当前登录态
pub fn read_client_auth(edition: &Edition, override_dir: &str) -> Result<Option<ClientAuth>, String> {
    let dir = resolve_client_dir(edition, override_dir);
    let auth_dat = auth_dat_path(&dir);
    if auth_dat.exists() {
        let key = load_oscrypt_key(&dir).ok_or_else(|| {
            "无法解出客户端 OSCrypt 密钥（需要 Windows DPAPI；请在本机运行，且 Local State 完好）。macOS/Linux 暂不支持自动读写。".to_string()
        })?;
        let plain = oscrypt_decrypt(&key, &fs::read(&auth_dat).map_err(|e| e.to_string())?)
            .map_err(|e| e)?;
        let json: Value = serde_json::from_slice(&plain).map_err(|e| format!("auth.v1.dat 解析失败: {}", e))?;
        return Ok(normalize_auth(json, "auth.v1.dat", read_machine_id_file(&dir)));
    }

    let vscdb = global_storage_db(&dir);
    if vscdb.exists() {
        let key = load_oscrypt_key(&dir);
        let conn = Connection::open_with_flags(&vscdb, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("打开 state.vscdb 失败: {}", e))?;
        let row = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = ?",
                ["secret://aicoding.auth.userInfo"],
                |r| r.get::<_, rusqlite::types::Value>(0),
            )
            .ok();
        let Some(value) = row else {
            return Ok(None);
        };
        let bytes = match value {
            rusqlite::types::Value::Blob(b) => b,
            rusqlite::types::Value::Text(t) => t.into_bytes(),
            _ => return Ok(None),
        };
        let json: Value = if bytes.len() > 3 && &bytes[..3] == b"v10" {
            let key = key.ok_or_else(|| "无法解出 OSCrypt 密钥，写入取消".to_string())?;
            let plain = oscrypt_decrypt(&key, &bytes)?;
            serde_json::from_slice(&plain).map_err(|e| e.to_string())?
        } else {
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
        };
        return Ok(normalize_auth(json, "state.vscdb", read_machine_id_file(&dir)));
    }
    Ok(None)
}

fn normalize_auth(json: Value, source: &str, machine_id: String) -> Option<ClientAuth> {
    let user = json.get("user").cloned().unwrap_or(Value::Null);
    Some(ClientAuth {
        source: source.to_string(),
        token: json
            .get("token")
            .or_else(|| json.get("securityOauthToken"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        refresh_token: json.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        expires_at: json.get("expiresAt").cloned(),
        refresh_token_expires_at: json
            .get("refreshTokenExpiresAt")
            .or_else(|| json.get("refreshTokenExpireAt"))
            .cloned(),
        user_id: user
            .get("id")
            .or_else(|| json.get("uid"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        user_name: user.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        user_email: user.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        user_phone: user.get("phone").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        machine_id,
        raw: json,
    })
}

/// 把账号写入客户端（写入前需已结束进程）
pub fn write_client_auth(edition: &Edition, account: &Account, override_dir: &str) -> Result<(), String> {
    let dir = resolve_client_dir(edition, override_dir);
    let auth_dat = auth_dat_path(&dir);
    let vscdb = global_storage_db(&dir);

    if auth_dat.exists() {
        let key = load_oscrypt_key(&dir)
            .ok_or_else(|| "无法解出 OSCrypt 密钥，写入取消（避免损坏客户端登录态）".to_string())?;
        let original: Option<Value> = fs::read(&auth_dat)
            .ok()
            .and_then(|bytes| oscrypt_decrypt(&key, &bytes).ok())
            .and_then(|plain| serde_json::from_slice(&plain).ok());
        let use_iso = original
            .as_ref()
            .and_then(|o| o.get("expiresAt"))
            .map(|v| v.is_string())
            .unwrap_or(true);
        let mut base = original.unwrap_or_else(|| json!({ "schemaVersion": 1 }));
        if let Some(obj) = base.as_object_mut() {
            obj.insert("schemaVersion".into(), obj.get("schemaVersion").cloned().unwrap_or(json!(1)));
            obj.entry("authenticationContext")
                .or_insert_with(|| json!(default_auth_context(edition)));
            obj.insert("token".into(), json!(account.security_oauth_token));
            // 切换账号必须写入目标账号自己的凭证与身份，不能沿用上一个账号的值
            obj.insert("refreshToken".into(), json!(account.refresh_token));
            obj.insert(
                "expiresAt".into(),
                match account.token_expire_at {
                    Some(expire) if use_iso => json!(iso_from_ms(expire)),
                    Some(expire) => json!(expire),
                    None => Value::Null,
                },
            );
            obj.insert(
                "refreshTokenExpiresAt".into(),
                match account.refresh_token_expires_at {
                    Some(expire) if use_iso => json!(iso_from_ms(expire)),
                    Some(expire) => json!(expire),
                    None => Value::Null,
                },
            );
            let mut user = obj.get("user").cloned().unwrap_or(json!({}));
            if let Some(u) = user.as_object_mut() {
                u.insert("id".into(), json!(account.uid));
                u.insert("name".into(), json!(account.name));
                u.insert("email".into(), json!(account.email));
                u.insert("phone".into(), json!(account.phone));
                u.insert(
                    "avatarUrl".into(),
                    if account.avatar_url.is_empty() { Value::Null } else { json!(account.avatar_url) },
                );
            }
            obj.insert("user".into(), user);
        }
        let encrypted = oscrypt_encrypt(&key, &base.to_string());
        let tmp = auth_dat.with_extension("tmp");
        fs::write(&tmp, &encrypted).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &auth_dat).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if vscdb.exists() {
        let conn = Connection::open(&vscdb).map_err(|e| format!("打开 state.vscdb 失败（写模式）: {}", e))?;
        let existing = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = ?",
                ["secret://aicoding.auth.userInfo"],
                |r| r.get::<_, rusqlite::types::Value>(0),
            )
            .ok();
        let mut encryption_key = None;
        let base: Value = match existing {
            Some(rusqlite::types::Value::Blob(b)) if b.len() > 3 && &b[..3] == b"v10" => {
                let key = load_oscrypt_key(&dir)
                    .ok_or_else(|| "无法解出 OSCrypt 密钥，写入取消".to_string())?;
                let plain = oscrypt_decrypt(&key, &b)?;
                let json = serde_json::from_slice(&plain).unwrap_or(json!({}));
                encryption_key = Some(key);
                json
            }
            Some(rusqlite::types::Value::Blob(b)) => serde_json::from_slice(&b).unwrap_or(json!({})),
            Some(rusqlite::types::Value::Text(t)) => serde_json::from_str(&t).unwrap_or(json!({})),
            _ => json!({}),
        };
        let merged = merge_client_auth_json(base, account);
        let value_bytes: Vec<u8> = match encryption_key {
            Some(key) => oscrypt_encrypt(&key, &merged.to_string()),
            None => serde_json::to_vec(&merged).unwrap_or_default(),
        };
        conn.execute(
            "INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)",
            rusqlite::params!["secret://aicoding.auth.userInfo", value_bytes],
        )
        .map_err(|e| format!("回写数据库失败: {}", e))?;
        return Ok(());
    }

    // 从没登录过的客户端：直接用 OSCrypt 密钥生成一份完整登录态
    let key = load_oscrypt_key(&dir)
        .ok_or_else(|| "无法解出 OSCrypt 密钥，写入取消（避免损坏客户端登录态）".to_string())?;
    let user = json!({
        "id": account.uid,
        "name": account.name,
        "email": account.email,
        "phone": account.phone,
        "avatarUrl": if account.avatar_url.is_empty() { Value::Null } else { json!(account.avatar_url) },
    });
    let auth = json!({
        "schemaVersion": 1,
        "authenticationContext": default_auth_context(edition),
        "token": account.security_oauth_token,
        "refreshToken": account.refresh_token,
        "expiresAt": account.token_expire_at.map(iso_from_ms).map(Value::String).unwrap_or(Value::Null),
        "refreshTokenExpiresAt": account.refresh_token_expires_at.map(iso_from_ms).map(Value::String).unwrap_or(Value::Null),
        "user": user,
    });
    let encrypted = oscrypt_encrypt(&key, &auth.to_string());
    let tmp = auth_dat.with_extension("tmp");
    fs::write(&tmp, &encrypted).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &auth_dat).map_err(|e| e.to_string())?;
    return Ok(());
}

/// 官方客户端的认证环境描述，新建 auth.v1.dat 时必须带上
fn default_auth_context(edition: &Edition) -> String {
    // Qoder 桌面端登录后写入的真实上下文（2026-10 实测）
    let site = if edition.value == "international" {
        "https://qoder.com"
    } else {
        "https://qoder.cn"
    };
    serde_json::to_string(&serde_json::json!([
        site,
        edition.oauth.open_api_base_url,
        "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
        "prod"
    ]))
    .unwrap_or_else(|_| "[]".into())
}

fn merge_client_auth_json(base: Value, account: &Account) -> Value {
    let mut obj = if base.is_object() { base } else { json!({}) };
    if let Some(map) = obj.as_object_mut() {
        map.insert("token".into(), json!(account.security_oauth_token));
        map.insert("refreshToken".into(), json!(account.refresh_token));
        map.insert("expiresAt".into(), account.token_expire_at.map(|v| json!(v)).unwrap_or(Value::Null));
        map.insert(
            "refreshTokenExpiresAt".into(),
            account.refresh_token_expires_at.map(|v| json!(v)).unwrap_or(Value::Null),
        );
        map.insert("uid".into(), json!(account.uid));
        let mut user = map
            .get("user")
            .cloned()
            .filter(|v| v.is_object())
            .unwrap_or_else(|| json!({}));
        if let Some(u) = user.as_object_mut() {
            u.insert("id".into(), json!(account.uid));
            u.insert("name".into(), json!(account.name));
            u.insert("email".into(), json!(account.email));
            u.insert("phone".into(), json!(account.phone));
        }
        map.insert("user".into(), user);
    }
    obj
}

fn iso_from_ms(ms: i64) -> String {
    let secs = ms / 1000;
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    let rem = secs % 86400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 结束客户端进程，返回结束的进程数
/// 解析目标客户端可执行文件。
/// 设置数据目录覆盖时只在覆盖目录内查找，避免误判机器上的其它 Qoder 安装。
fn resolve_client_exe(edition: &Edition, override_dir: &str, exe_override: &str) -> Option<String> {
    if !exe_override.trim().is_empty() {
        return Some(exe_override.to_string());
    }
    if !override_dir.trim().is_empty() {
        let dir = PathBuf::from(override_dir);
        let candidates = [
            dir.join("Qoder.exe"),
            dir.parent().map(|p| p.join("Qoder.exe")).unwrap_or_default(),
        ];
        for candidate in candidates {
            if !candidate.as_os_str().is_empty() && candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        return None;
    }
    find_client_exe(edition)
}

/// 结束指定客户端进程：只按可执行文件绝对路径精确匹配，绝不按进程名全局结束。
pub fn kill_client_processes(exe_path: &str) -> usize {
    let target = exe_path.trim();
    if target.is_empty() {
        return 0;
    }
    if cfg!(target_os = "windows") {
        #[cfg(windows)]
        {
            let script = r#"
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
"#;
            let output = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("QODER_TARGET_EXE", target)
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .output();
            let Ok(output) = output else { return 0 };
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut count = 0;
            for pid in stdout.trim().split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let _ = Command::new("taskkill")
                    .args(["/F", "/PID", pid])
                    .creation_flags(0x0800_0000)
                    .output();
                count += 1;
            }
            return count;
        }
        #[cfg(not(windows))]
        return 0;
    }
    let output = Command::new("pgrep").args(["-f", target]).output();
    let Ok(output) = output else { return 0 };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut count = 0;
    for pid in stdout.lines().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let _ = Command::new("kill").args(["-9", pid]).output();
        count += 1;
    }
    count
}

/// 在注册表 / 常见路径中查找客户端可执行文件
static EXE_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Option<String>)>>> = OnceLock::new();

/// 从正在运行的进程读取真实安装路径（支持自定义安装目录 / 版本化目录）
fn running_client_exe(edition: &Edition) -> Option<String> {
    #[cfg(windows)]
    {
        let script = r#"
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -in @('Qoder','QoderCN','Qoder CN') } |
  ForEach-Object { try { $_.Path } catch {} } |
  Where-Object { $_ } |
  Select-Object -Unique
"#;
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let is_cn = |p: &str| {
            let lower = p.to_lowercase();
            lower.contains("qoder cn") || lower.contains("qodercn")
        };
        let paths: Vec<String> = stdout
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        // 无法确定进程属于当前版本时宁可不结束，避免误杀另一版本
        let preferred = if edition.value == "domestic" {
            paths.into_iter().find(|p| is_cn(p))
        } else {
            paths.into_iter().find(|p| !is_cn(p))
        };
        return preferred;
    }
    #[cfg(not(windows))]
    None
}

/// 从 Windows 卸载注册表定位自定义安装目录（例如 F:\AdobeAll\Qoder CN）
#[cfg(windows)]
fn registry_client_exe(edition: &Edition) -> Option<String> {
    let script = r#"
$keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$items = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Qoder*' } | ForEach-Object { [pscustomobject]@{ Name = $_.DisplayName; Icon = $_.DisplayIcon; Uninstall = $_.UninstallString } }
$items | ConvertTo-Json -Compress
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(text.trim()).ok()?;
    let items = match parsed {
        Value::Array(list) => list,
        Value::Object(_) => vec![parsed],
        _ => return None,
    };
    let target = if edition.value == "domestic" { "Qoder CN.exe" } else { "Qoder.exe" };
    for item in items {
        let name = item.get("Name").and_then(|v| v.as_str()).unwrap_or("");
        let lower = name.to_lowercase();
        let is_cn = lower.contains("qoder cn") || lower.contains("qodercn");
        if (edition.value == "domestic") != is_cn {
            continue;
        }
        for key in ["Icon", "Uninstall"] {
            let raw = item.get(key).and_then(|v| v.as_str()).unwrap_or("").trim();
            if raw.is_empty() {
                continue;
            }
            let mut paths: Vec<String> = Vec::new();
            for part in raw.split('"') {
                if part.to_lowercase().ends_with(".exe") || part.to_lowercase().ends_with(".ico") {
                    paths.push(part.to_string());
                }
            }
            if let Some(first) = raw.split_whitespace().next() {
                paths.push(first.trim_matches('"').to_string());
            }
            if let Some(icon) = raw.split(',').next() {
                paths.push(icon.trim_matches('"').to_string());
            }
            for file in paths {
                if !(file.to_lowercase().ends_with(".exe") || file.to_lowercase().ends_with(".ico")) {
                    continue;
                }
                if Path::new(&file).file_name().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case(target)).unwrap_or(false)
                    && Path::new(&file).exists()
                {
                    return Some(file);
                }
                let Some(root) = Path::new(&file).parent() else { continue };
                let direct = root.join(target);
                if direct.exists() {
                    return Some(direct.to_string_lossy().to_string());
                }
                let versions = root.join(".qoder-versions");
                if let Ok(entries) = fs::read_dir(&versions) {
                    let mut dirs: Vec<PathBuf> = entries
                        .filter_map(|e| e.ok().map(|e| e.path()).filter(|p| p.is_dir()))
                        .collect();
                    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                    for dir in dirs {
                        let candidate = dir.join(target);
                        if candidate.exists() {
                            return Some(candidate.to_string_lossy().to_string());
                        }
                    }
                }
                let launcher = root.join("resources").join("launcher").join(
                    if edition.value == "domestic" { "Qoder CN Launcher.exe" } else { "Qoder Launcher.exe" },
                );
                if launcher.exists() {
                    return Some(launcher.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// 启动器不是主进程；读 state.ini / install.ini 找到实际运行的版本化 exe
fn resolve_launcher_executable(exe_path: &str) -> String {
    if !exe_path.to_lowercase().ends_with("launcher.exe") {
        return exe_path.to_string();
    }
    let Some(dir) = Path::new(exe_path).parent() else { return exe_path.to_string() };
    for name in ["state.ini", "install.ini"] {
        let Ok(raw) = fs::read_to_string(dir.join(name)) else { continue };
        let mut install_dir = String::new();
        let mut app_exe = String::new();
        for line in raw.lines() {
            if let Some((key, value)) = line.split_once('=') {
                match key.trim() {
                    "installDir" => install_dir = value.trim().to_string(),
                    "appExecutable" => app_exe = value.trim().to_string(),
                    _ => {}
                }
            }
        }
        if !install_dir.is_empty() && !app_exe.is_empty() {
            let actual = Path::new(&install_dir).join(app_exe);
            if actual.exists() {
                return actual.to_string_lossy().to_string();
            }
        }
    }
    exe_path.to_string()
}

pub fn find_client_exe(edition: &Edition) -> Option<String> {
    let cache = EXE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, value)) = cache
        .lock()
        .ok()
        .and_then(|map| map.get(&edition.value).cloned())
    {
        let ttl = if value.is_some() {
            Duration::from_secs(60)
        } else {
            Duration::from_secs(15)
        };
        if at.elapsed() < ttl {
            return value;
        }
    }

    let mut found = running_client_exe(edition);
    if found.is_none() {
        #[cfg(windows)]
        {
            let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
            let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
            let program_files_x86 =
                std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
            let mut names: Vec<String> = edition.client_dirs.clone();
            if edition.value == "international" {
                names.push("Qoder".into());
            }
            let launcher_names: Vec<&str> = if edition.value == "domestic" {
                vec!["Qoder CN", "QoderCN"]
            } else {
                vec!["Qoder"]
            };
            let mut candidates: Vec<PathBuf> = Vec::new();
            for base in [
                if local_app_data.is_empty() { None } else { Some(format!("{}\\Programs", local_app_data)) },
                Some(program_files),
                Some(program_files_x86),
            ]
            .into_iter()
            .flatten()
            {
                for name in &names {
                    candidates.push(PathBuf::from(&base).join(name).join("Qoder.exe"));
                    candidates.push(PathBuf::from(&base).join(name).join(format!("{}.exe", name)));
                }
            }
            if !local_app_data.is_empty() {
                for name in launcher_names {
                    candidates.push(
                        PathBuf::from(&local_app_data)
                            .join(name)
                            .join("Qoder Launcher")
                            .join("Qoder Launcher.exe"),
                    );
                }
                candidates.push(
                    PathBuf::from(&local_app_data)
                        .join("Qoder CN")
                        .join("Qoder CN Launcher")
                        .join("Qoder CN Launcher.exe"),
                );
            }
            found = candidates
                .into_iter()
                .find(|path| path.exists())
                .map(|path| path.to_string_lossy().to_string());
        }
    }
    if found.is_none() {
        #[cfg(windows)]
        {
            found = registry_client_exe(edition);
        }
    }
    if let Some(path) = found.clone() {
        found = Some(resolve_launcher_executable(&path));
    }
    if let Ok(mut map) = cache.lock() {
        map.insert(edition.value.clone(), (Instant::now(), found.clone()));
    }
    found
}

pub fn launch_client(exe_path: &str) -> Result<(), String> {
    Command::new(exe_path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动客户端失败: {}", e))
}

/// 完整切换流程（带步骤回调）
pub async fn switch_client_account<F>(
    account: &Account,
    edition: &Edition,
    override_dir: &str,
    restart: bool,
    exe_override: &str,
    mut on_step: F,
) -> Result<String, String>
where
    F: FnMut(SwitchStep),
{
    if account.security_oauth_token.is_empty() {
        return Err("该账号没有 Qoder 客户端登录 Token（PAT / 备份占位账号不支持切换），请先重新登录".into());
    }
    let dir = resolve_client_dir(edition, override_dir);
    let auth_dat = auth_dat_path(&dir);
    let vscdb = global_storage_db(&dir);
    if !auth_dat.exists() && !vscdb.exists() {
        // 客户端装过但从未登录：只要有数据目录和 OSCrypt 密钥，就直接新建 auth.v1.dat
        if !dir.exists() {
            return Err("未检测到客户端数据目录，请先安装并打开一次 Qoder 客户端".into());
        }
        if load_oscrypt_key(&dir).is_none() {
            return Err("客户端尚未生成加密密钥，请先打开一次 Qoder 客户端再切换".into());
        }
    }
    let exe = resolve_client_exe(edition, override_dir, exe_override);

    on_step(SwitchStep {
        name: "备份当前登录态".into(),
        status: "running".into(),
        detail: String::new(),
    });
    let backup = backup_client_auth(&auth_dat, &vscdb);
    on_step(SwitchStep {
        name: "备份当前登录态".into(),
        status: "done".into(),
        detail: match &backup {
            Some(p) => format!("已备份到 {}", Path::new(p).file_name().unwrap_or_default().to_string_lossy()),
            None => "无现有登录态，跳过备份".into(),
        },
    });

    on_step(SwitchStep {
        name: "结束 Qoder 进程".into(),
        status: "running".into(),
        detail: String::new(),
    });
    let mut killed = kill_client_processes(exe.as_deref().unwrap_or(""));
    // 自定义数据目录时不能按全局进程名推断，避免误杀另一个安装
    if killed == 0 && override_dir.trim().is_empty() {
        // 启动器/版本目录变化时按实际运行路径再结束一次
        if let Some(running) = running_client_exe(edition) {
            if Some(running.as_str()) != exe.as_deref() {
                killed = kill_client_processes(&running);
            }
        }
    }
    if override_dir.trim().is_empty() && running_client_exe(edition).is_some() {
        on_step(SwitchStep {
            name: "结束 Qoder 进程".into(),
            status: "error".into(),
            detail: "客户端仍在运行，无法结束进程".into(),
        });
        return Err("Qoder 客户端仍在运行，无法安全写入登录态。请手动关闭 Qoder 后重试".into());
    }
    on_step(SwitchStep {
        name: "结束 Qoder 进程".into(),
        status: "done".into(),
        detail: if killed > 0 {
            format!("已结束 {} 个进程", killed)
        } else if exe.is_some() {
            "未发现运行中的客户端进程".into()
        } else {
            "未定位客户端可执行文件（客户端未运行）".into()
        },
    });

    on_step(SwitchStep {
        name: "写入目标账号".into(),
        status: "running".into(),
        detail: String::new(),
    });
    write_client_auth(edition, account, override_dir).map_err(|e| {
        on_step(SwitchStep {
            name: "写入目标账号".into(),
            status: "error".into(),
            detail: e.clone(),
        });
        e
    })?;
    on_step(SwitchStep {
        name: "写入目标账号".into(),
        status: "done".into(),
        detail: if auth_dat.exists() { "auth.v1.dat 已更新".into() } else { "state.vscdb 已更新".into() },
    });

    if restart {
        on_step(SwitchStep {
            name: "重启 Qoder".into(),
            status: "running".into(),
            detail: String::new(),
        });
        match exe {
            Some(path) => match launch_client(&path) {
                Ok(()) => on_step(SwitchStep {
                    name: "重启 Qoder".into(),
                    status: "done".into(),
                    detail: format!("已启动 {}", Path::new(&path).file_name().unwrap_or_default().to_string_lossy()),
                }),
                Err(e) => on_step(SwitchStep {
                    name: "重启 Qoder".into(),
                    status: "error".into(),
                    detail: e,
                }),
            },
            None => on_step(SwitchStep {
                name: "重启 Qoder".into(),
                status: "error".into(),
                detail: "未找到客户端可执行文件，请手动启动（可在设置页配置路径）".into(),
            }),
        }
    }

    Ok(dir.to_string_lossy().to_string())
}

fn backup_client_auth(auth_dat: &Path, vscdb: &Path) -> Option<String> {
    let stamp = iso_from_ms(crate::crypto::now_ms()).replace([':', '.'], "-");
    if auth_dat.exists() {
        let dest = format!("{}.bak-{}", auth_dat.to_string_lossy(), stamp);
        fs::copy(auth_dat, &dest).ok()?;
        return Some(dest);
    }
    if vscdb.exists() {
        let dest = format!("{}.bak-{}", vscdb.to_string_lossy(), stamp);
        fs::copy(vscdb, &dest).ok()?;
        return Some(dest);
    }
    None
}
