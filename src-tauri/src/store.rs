//! JSON 文件持久化（账号库整体加密，原子写）。

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

use crate::crypto::{decrypt_secret, encrypt_secret};
use crate::paths::{data_dir, data_file, ensure_data_dir};

pub fn load_json<T: DeserializeOwned + Default>(name: &str) -> T {
    let file = data_file(name);
    match fs::read_to_string(&file) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

pub fn save_json<T: Serialize>(name: &str, value: &T) {
    ensure_data_dir();
    let file = data_file(name);
    let tmp = file.with_extension("tmp");
    if let Ok(data) = serde_json::to_string_pretty(value) {
        if fs::write(&tmp, data).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
    }
}

/// 读取加密的敏感数据；解密失败时尝试明文兼容
pub fn load_encrypted<T: DeserializeOwned + Default>(name: &str) -> T {
    let file = data_file(name);
    match fs::read_to_string(&file) {
        Ok(raw) => {
            if let Some(decrypted) = decrypt_secret(raw.trim()) {
                serde_json::from_str(&decrypted).unwrap_or_default()
            } else {
                serde_json::from_str(&raw).unwrap_or_default()
            }
        }
        Err(_) => T::default(),
    }
}

pub fn save_encrypted<T: Serialize>(name: &str, value: &T) {
    ensure_data_dir();
    let file = data_file(name);
    let tmp = file.with_extension("tmp");
    if let Ok(data) = serde_json::to_string(value) {
        if fs::write(&tmp, encrypt_secret(&data)).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
    }
}

pub fn append_jsonl(name: &str, entry: &serde_json::Value) {
    ensure_data_dir();
    let file = data_file(name);
    let mut value = entry.clone();
    if let Some(obj) = value.as_object_mut() {
        obj.insert("ts".into(), serde_json::json!(crate::crypto::now_ms()));
    }
    if let Ok(line) = serde_json::to_string(&value) {
        use std::io::Write;
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&file) {
            let _ = writeln!(f, "{}", line);
        }
    }
}

pub fn read_jsonl(name: &str, limit: usize) -> Vec<serde_json::Value> {
    let file = data_file(name);
    let raw = match fs::read_to_string(&file) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .rev()
        .take(limit)
        .collect()
}

pub fn data_dir_path() -> PathBuf {
    data_dir()
}
