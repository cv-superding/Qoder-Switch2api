//! Qoder 客户端账号切换：
//! 备份当前登录态 → 结束客户端进程 → 写入目标账号 → 重启客户端。
//!
//! 新版客户端登录态在数据目录根下的 auth.v1.dat（OSCrypt v10）；
//! 旧版在 User/globalStorage/state.vscdb 的 secret://aicoding.auth.userInfo。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

    Err("未找到客户端登录态文件（auth.v1.dat / state.vscdb），请先在本机打开 Qoder 并登录一次".into())
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
pub fn find_client_exe(edition: &Edition) -> Option<String> {
    if cfg!(target_os = "windows") {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
        let mut names: Vec<String> = edition.client_dirs.clone();
        names.push("Qoder".into());
        for base in [
            if local_app_data.is_empty() { None } else { Some(format!("{}\\Programs", local_app_data)) },
            Some(program_files),
            Some(program_files_x86),
        ]
        .into_iter()
        .flatten()
        {
            for name in &names {
                for candidate in [
                    PathBuf::from(&base).join(name).join("Qoder.exe"),
                    PathBuf::from(&base).join(name).join(format!("{}.exe", name)),
                ] {
                    if candidate.exists() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
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
        return Err("未找到客户端登录态文件，请先打开 Qoder 并登录一次，再执行切换".into());
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
    let killed = kill_client_processes(exe.as_deref().unwrap_or(""));
    on_step(SwitchStep {
        name: "结束 Qoder 进程".into(),
        status: "done".into(),
        detail: if killed > 0 {
            format!("已结束 {} 个进程", killed)
        } else if exe.is_some() {
            "未发现运行中的客户端进程".into()
        } else {
            "未定位客户端可执行文件，已跳过结束进程（请手动关闭 Qoder 后重试）".into()
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
