//! Qoder 客户端账号切换：
//! 备份当前登录态 → 结束客户端进程 → 写入目标账号 → 重启客户端。
//!
//! 新版客户端登录态在数据目录根下的 auth.v1.dat（OSCrypt v10）；
//! 旧版在 User/globalStorage/state.vscdb 的 secret://aicoding.auth.userInfo。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::account::Account;
use crate::crypto::{load_oscrypt_key, oscrypt_decrypt, oscrypt_encrypt};
use crate::editions::Edition;
use crate::paths::{
    auth_dat_path, global_storage_db, machine_id_path, resolve_client_dir,
};

#[derive(Debug, Clone, serde::Serialize)]
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

#[derive(Debug, Clone, serde::Serialize)]
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
    pub expires_at: Option<String>,
    pub refresh_token_expires_at: Option<String>,
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

pub fn detect_client(edition: &Edition, override_dir: &str) -> ClientInfo {
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
        client_exe_path: find_client_exe(edition).unwrap_or_default(),
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
        return Ok(Some(normalize_auth(json, "auth.v1.dat", read_machine_id_file(&dir))));
    }

    let vscdb = global_storage_db(&dir);
    if vscdb.exists() {
        let key = load_oscrypt_key(&dir).ok();
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
        return Ok(Some(normalize_auth(json, "state.vscdb", read_machine_id_file(&dir))));
    }
    Ok(None)
}

fn normalize_auth(json: Value, source: &str, machine_id: String) -> Option<ClientAuth> {
    let user = json.get("user").cloned().unwrap_or(Value::Null);
    Some(ClientAuth {
        token: json
            .get("token")
            .or_else(|| json.get("securityOauthToken"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        refresh_token: json.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        expires_at: json.get("expiresAt").map(|v| v.to_string()),
        refresh_token_expires_at: json.get("refreshTokenExpiresAt").map(|v| v.to_string()),
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
            obj.insert(
                "refreshToken".into(),
                json!(if account.refresh_token.is_empty() {
                    obj.get("refreshToken").cloned().unwrap_or(json!(""))
                } else {
                    json!(account.refresh_token)
                }),
            );
            if let Some(expire) = account.token_expire_at {
                obj.insert(
                    "expiresAt".into(),
                    if use_iso {
                        json!(iso_from_ms(expire))
                    } else {
                        json!(expire)
                    },
                );
            }
            if let Some(expire) = account.refresh_token_expires_at {
                obj.insert(
                    "refreshTokenExpiresAt".into(),
                    if use_iso {
                        json!(iso_from_ms(expire))
                    } else {
                        json!(expire)
                    },
                );
            }
            let mut user = obj.get("user").cloned().unwrap_or(json!({}));
            if let Some(u) = user.as_object_mut() {
                u.insert("id".into(), json!(if account.uid.is_empty() { u.get("id").cloned().unwrap_or(json!("")) } else { json!(account.uid) }));
                u.insert("name".into(), json!(if account.name.is_empty() { u.get("name").cloned().unwrap_or(json!("")) } else { json!(account.name) }));
                u.insert("email".into(), json!(if account.email.is_empty() { u.get("email").cloned().unwrap_or(json!("")) } else { json!(account.email) }));
                u.insert("phone".into(), json!(if account.phone.is_empty() { u.get("phone").cloned().unwrap_or(json!("")) } else { json!(account.phone) }));
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
        let value_bytes: Vec<u8> = match existing {
            Some(rusqlite::types::Value::Blob(b)) => {
                if b.len() > 3 && &b[..3] == b"v10" {
                    let key = load_oscrypt_key(&dir)
                        .ok_or_else(|| "无法解出 OSCrypt 密钥，写入取消".to_string())?;
                    let plain = oscrypt_decrypt(&key, &b)?;
                    let mut json: Value = serde_json::from_slice(&plain).unwrap_or(json!({}));
                    if let Some(obj) = json.as_object_mut() {
                        obj.insert("token".into(), json!(account.security_oauth_token));
                        if !account.refresh_token.is_empty() {
                            obj.insert("refreshToken".into(), json!(account.refresh_token));
                        }
                        if let Some(expire) = account.token_expire_at {
                            obj.insert("expiresAt".into(), json!(expire));
                        }
                        obj.insert("uid".into(), json!(account.uid));
                        obj.insert(
                            "user".into(),
                            json!({
                                "id": account.uid,
                                "name": account.name,
                                "email": account.email
                            }),
                        );
                    }
                    oscrypt_encrypt(&key, &json.to_string())
                } else {
                    b
                }
            }
            Some(rusqlite::types::Value::Text(t)) => t.into_bytes(),
            _ => serde_json::to_vec(&json!({
                "token": account.security_oauth_token,
                "refreshToken": account.refresh_token,
                "uid": account.uid,
                "user": { "id": account.uid, "name": account.name, "email": account.email }
            }))
            .unwrap_or_default(),
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
pub fn kill_client_processes(edition: &Edition) -> usize {
    let mut count = 0;
    if cfg!(target_os = "windows") {
        let mut names = edition.client_process_names.clone();
        names.push("Qoder".into());
        for name in names {
            let filter = format!("IMAGENAME eq {}.exe", name);
            if let Ok(output) = Command::new("tasklist")
                .args(["/FI", &filter, "/NH"])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.contains(&name) {
                    let _ = Command::new("taskkill").args(["/F", "/IM", &format!("{}.exe", name)]).output();
                    count += 1;
                }
            }
        }
    } else {
        let mut names = edition.client_process_names.clone();
        names.push("Qoder".into());
        for name in names {
            let _ = Command::new("pkill").args(["-f", &name]).output();
            count += 1;
        }
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
    let dir = resolve_client_dir(edition, override_dir);
    let auth_dat = auth_dat_path(&dir);
    let vscdb = global_storage_db(&dir);

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
    let killed = kill_client_processes(edition);
    on_step(SwitchStep {
        name: "结束 Qoder 进程".into(),
        status: "done".into(),
        detail: if killed > 0 {
            format!("已结束 {} 个进程", killed)
        } else {
            "未发现运行中的客户端".into()
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
        let exe = if exe_override.trim().is_empty() {
            find_client_exe(edition)
        } else {
            Some(exe_override.to_string())
        };
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
