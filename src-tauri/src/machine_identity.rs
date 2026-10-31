//! 官方桌面端原生风控身份（活动平台 /sash/... 必需真实机器身份）。
//!
//! 服务端按 Cosy-Machine* 头过滤设备定向活动：只带 Cosy-ClientType/Version 时
//! 「每日领取 100 Credits」会被静默过滤，列表只剩营销活动（国际版实测）。
//! 派生出来的假机器身份同样会被整条过滤，所以只有拿到**真实**身份（官方
//! 客户端同款 resources/umid/runtime-info 原生桥）时才发送机器头。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::editions::Edition;

const IDENTITY_TTL: Duration = Duration::from_secs(30 * 60);
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MachineIdentity {
    #[serde(rename = "machineToken")]
    pub machine_token: String,
    #[serde(rename = "machineType")]
    pub machine_type: String,
    #[serde(rename = "machineCode")]
    pub machine_code: String,
}

fn cache() -> &'static Mutex<HashMap<String, (Instant, MachineIdentity)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, MachineIdentity)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 原生桥位置：<install>/resources/umid/runtime-info[.exe]
pub fn runtime_info_exe(exe_path: &str) -> Option<PathBuf> {
    if exe_path.is_empty() {
        return None;
    }
    let root = Path::new(exe_path).parent()?;
    let name = if cfg!(windows) { "runtime-info.exe" } else { "runtime-info" };
    for sub in ["resources", "Resources"] {
        let p = root.join(sub).join("umid").join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 桌面端版本号（Cosy-Version）：从版本化安装路径推导
pub fn client_version_from_exe(exe_path: &str, fallback: &str) -> String {
    let Some(root) = Path::new(exe_path).parent() else {
        return fallback.to_string();
    };
    if let Some(name) = root.file_name().and_then(|n| n.to_str()) {
        let parts: Vec<&str> = name.split('.').collect();
        if parts.len() == 3 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
            return name.to_string();
        }
    }
    fallback.to_string()
}

/// 与官方同形的机器 ID：uid + 固定盐派生 UUIDv4 形态
pub fn derive_machine_id(uid: &str) -> String {
    let h = crate::crypto::md5_hex(&format!("machine:{}", if uid.is_empty() { "anonymous" } else { uid }));
    let bytes = h.as_bytes();
    if bytes.len() < 32 {
        return h;
    }
    format!(
        "{}-{}-4{}-a{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}

pub fn machine_os() -> &'static str {
    if cfg!(windows) {
        "x86_64_win32"
    } else if cfg!(target_os = "macos") {
        "aarch64_darwin"
    } else {
        "x86_64_linux"
    }
}

fn env_code(edition: &Edition) -> &'static str {
    if edition.value == "domestic" {
        "0"
    } else {
        "3"
    }
}

async fn run_bridge(exe: &Path, env_code: &str, uid: &str) -> Option<MachineIdentity> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg(env_code);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    // 原生桥是控制台程序：不隐藏会闪黑窗
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let use_stdin = (cfg!(windows) || cfg!(target_os = "macos")) && !uid.is_empty();
    if use_stdin {
        cmd.arg("--account-stdin");
    }
    cmd.stdin(if use_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn().ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let payload = format!("{{\"account\":\"{}\"}}\n", uid);
        let _ = stdin.write_all(payload.as_bytes()).await;
    }
    let output = tokio::time::timeout(BRIDGE_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or("").trim();
    let data: serde_json::Value = serde_json::from_str(line).ok()?;
    let token = data.get("machineToken").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let mtype = data.get("machineType").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let code = data.get("machineCode").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if token.is_empty() || mtype.is_empty() || code.is_empty() {
        return None;
    }
    Some(MachineIdentity { machine_token: token, machine_type: mtype, machine_code: code })
}

/// 取真实机器身份（机器级，同机多账号共用）。仅国际版活动链路需要；
/// 无原生桥或调用失败返回 None（调用方应**不带**任何 machine 头）。
pub async fn get_machine_identity(edition: &Edition, uid: &str) -> Option<MachineIdentity> {
    if edition.value != "international" {
        return None;
    }
    if let Ok(map) = cache().lock() {
        if let Some((at, ident)) = map.get(&edition.value) {
            if at.elapsed() < IDENTITY_TTL {
                return Some(ident.clone());
            }
        }
    }
    let exe_path = crate::switcher::find_client_exe(edition)?;
    let bridge = runtime_info_exe(&exe_path)?;
    let ident = run_bridge(&bridge, env_code(edition), uid).await?;
    if let Ok(mut map) = cache().lock() {
        map.insert(edition.value.clone(), (Instant::now(), ident.clone()));
    }
    Some(ident)
}
