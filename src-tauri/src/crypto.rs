//! 加密工具：
//!  - 账号库：AES-256-GCM，密钥由机器标识派生
//!  - Qoder 客户端 auth.v1.dat：Chromium OSCrypt v10（AES-256-GCM），
//!    密钥来自 Local State 的 os_crypt.encrypted_key，Windows 经 DPAPI 解包

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;

/* ---------------- 账号库加密 ---------------- */

fn machine_key() -> [u8; 32] {
    let machine_name = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let user_name = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    let material = format!("{}_{}_qoder-switch2api", machine_name, user_name);
    let digest = Sha256::digest(material.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// 加密为 base64（[12B nonce][ciphertext+tag]）
pub fn encrypt_secret(plaintext: &str) -> String {
    let cipher = Aes256Gcm::new_from_slice(&machine_key()).expect("key");
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes()).expect("encrypt");
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&ciphertext);
    base64::engine::general_purpose::STANDARD.encode(&out)
}

/// 解密 base64；非本机数据返回 None
pub fn decrypt_secret(payload: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()?;
    if raw.len() < 28 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(&machine_key()).ok()?;
    let nonce = Nonce::from_slice(&raw[..12]);
    let plaintext = cipher.decrypt(nonce, &raw[12..]).ok()?;
    String::from_utf8(plaintext).ok()
}

/* ---------------- OSCrypt ---------------- */

/// Windows DPAPI 解密（CurrentUser 作用域），经 PowerShell 调用。
pub fn dpapi_unprotect(base64_cipher_text: &str) -> Result<Vec<u8>, String> {
    if !cfg!(target_os = "windows") {
        return Err("DPAPI 仅支持 Windows".into());
    }
    let script = format!(
        "Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String('{}'); $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'); [Convert]::ToBase64String($plain)",
        base64_cipher_text
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("执行 PowerShell 失败: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "DPAPI 解密失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let b64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("DPAPI 输出解码失败: {}", e))
}

/// 读取客户端 Local State 并解出 OSCrypt AES 密钥（32 字节）。
pub fn load_oscrypt_key(client_dir: &Path) -> Option<[u8; 32]> {
    let local_state = local_state_path_buf(client_dir);
    if !local_state.exists() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&local_state).ok()?).ok()?;
    let encrypted_key_b64 = json.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let raw = base64::engine::general_purpose::STANDARD.decode(encrypted_key_b64).ok()?;
    let prefix = String::from_utf8_lossy(&raw[..raw.len().min(5)]).to_string();
    let cipher_text = if prefix == "DPAPI" { &raw[5..] } else { &raw[..] };
    let key = dpapi_unprotect(&base64::engine::general_purpose::STANDARD.encode(cipher_text)).ok()?;
    if key.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&key);
    Some(out)
}

fn local_state_path_buf(client_dir: &Path) -> std::path::PathBuf {
    client_dir.join("Local State")
}

/// OSCrypt v10 解密：[3B "v10"][12B nonce][ciphertext+tag]
pub fn oscrypt_decrypt(key: &[u8; 32], file_bytes: &[u8]) -> Result<Vec<u8>, String> {
    if file_bytes.len() < 3 + 12 + 16 {
        return Err("auth.v1.dat 文件过小".into());
    }
    if &file_bytes[..3] != b"v10" {
        return Err(format!(
            "不支持的 OSCrypt 版本: {}",
            String::from_utf8_lossy(&file_bytes[..3])
        ));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&file_bytes[3..15]);
    cipher
        .decrypt(nonce, &file_bytes[15..])
        .map_err(|e| format!("OSCrypt 解密失败: {}", e))
}

/// OSCrypt v10 加密
pub fn oscrypt_encrypt(key: &[u8; 32], plaintext: &str) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("key");
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes()).expect("encrypt");
    let mut out = b"v10".to_vec();
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    out
}

/* ---------------- 杂项 ---------------- */

pub fn random_id(prefix: &str) -> String {
    format!("{}_{:x}{}", prefix, now_ms(), rand::random::<u32>())
}

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn md5_hex(input: &str) -> String {
    let mut hasher = md5::Md5::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn machine_id_fallback() -> String {
    let hostname = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    let material = format!("{}{}", hostname, user);
    let digest = Sha256::digest(material.as_bytes());
    let mut out = String::with_capacity(32);
    for b in &digest[..16] {
        out.push_str(&format!("{:02x}", b));
    }
    out
}
