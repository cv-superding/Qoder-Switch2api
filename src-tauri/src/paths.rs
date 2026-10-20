//! 数据目录与 Qoder 客户端路径解析。

use std::fs;
use std::path::PathBuf;

use crate::editions::Edition;

/// 本工具自己的数据目录：~/.qoder-switch */
pub fn data_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".qoder-switch")
}

pub fn data_file(name: &str) -> PathBuf {
    data_dir().join(name)
}

pub fn ensure_data_dir() {
    let _ = fs::create_dir_all(data_dir());
}

/// Qoder 客户端数据目录（Electron userData）。 */
pub fn client_data_dir(dir_name: &str) -> PathBuf {
    if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA")
            .unwrap_or_else(|_| format!("{}\\AppData\\Roaming", data_dir_str()));
        PathBuf::from(appdata).join(dir_name)
    } else if cfg!(target_os = "macos") {
        PathBuf::from(home_dir()).join("Library/Application Support").join(dir_name)
    } else {
        PathBuf::from(home_dir()).join(".config").join(dir_name)
    }
}

fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into())
}

fn data_dir_str() -> String {
    home_dir()
}

/** 某个档位实际使用的客户端目录（取第一个存在的候选，可被设置覆盖） */
pub fn resolve_client_dir(edition: &Edition, override_dir: &str) -> PathBuf {
    if !override_dir.trim().is_empty() {
        return PathBuf::from(override_dir);
    }
    for name in &edition.client_dirs {
        let dir = client_data_dir(name);
        if dir.exists() {
            return dir;
        }
    }
    client_data_dir(&edition.client_dirs[0])
}

pub fn shared_client_cache_dir(client_dir: &std::path::Path) -> PathBuf {
    client_dir.join("SharedClientCache")
}

pub fn global_storage_db(client_dir: &std::path::Path) -> PathBuf {
    client_dir.join("User").join("globalStorage").join("state.vscdb")
}

pub fn auth_dat_path(client_dir: &std::path::Path) -> PathBuf {
    client_dir.join("auth.v1.dat")
}

pub fn main_db_path(client_dir: &std::path::Path) -> PathBuf {
    client_dir.join("main.sqlite")
}

pub fn machine_id_path(client_dir: &std::path::Path) -> PathBuf {
    client_dir.join("auth.machine-id")
}

pub fn local_state_path(client_dir: &std::path::Path) -> PathBuf {
    client_dir.join("Local State")
}

pub fn workspace_storage_dir(client_dir: &std::path::Path) -> PathBuf {
    client_dir.join("User").join("workspaceStorage")
}
