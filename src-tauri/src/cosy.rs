//! Qoder Cosy 认证协议（复刻自 qoder2api legacy.go 与 Qoder-Switch cosy.rs）。
//!
//!  1. 随机 AES key（uuid 无横线前 16 位）
//!  2. AES-128-CBC（IV = key 本身，服务端约定）加密用户信息 JSON
//!  3. RSA PKCS1v15 加密 AES key → cosy-key
//!  4. payload = { version, requestId, info, cosyVersion, ideVersion } → base64
//!  5. sig = md5(payload_b64 + "\n" + cosy_key + "\n" + cosy_date + "\n" + body + "\n" + path)
//!  6. authorization: Bearer COSY.<payload_b64>.<sig>
//!
//! 请求体再经 legacyEncode（自定义 base64 字母表 + 分段重排）编码。

use aes::cipher::{BlockEncrypt, KeyInit};
use base64::Engine;
use rsa::pkcs1v15::Pkcs1v15Encrypt;
use rsa::RsaPublicKey;
use std::collections::HashMap;

use crate::crypto::{md5_hex, uuid};

const STD_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_ALPHABET: &[u8] = b"_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const CUSTOM_PAD: u8 = b'$';

fn aes_key_material() -> String {
    uuid().replace('-', "").chars().take(16).collect()
}

/// AES-128-CBC 加密（IV 复用 key 本身，Qoder 服务端约定）+ PKCS7 padding
fn cosy_aes_encrypt(plaintext: &str, key: &str) -> String {
    use aes::Aes128;
    let key_bytes = key.as_bytes();
    let cipher = Aes128::new_from_slice(key_bytes).expect("aes128 key");
    let mut buf = plaintext.as_bytes().to_vec();
    let pad_len = 16 - (buf.len() % 16);
    buf.extend(std::iter::repeat(pad_len as u8).take(pad_len));
    let iv: [u8; 16] = key_bytes.try_into().expect("16 byte key");
    let mut prev = iv;
    for chunk in buf.chunks_mut(16) {
        for i in 0..16 {
            chunk[i] ^= prev[i];
        }
        let block = aes::cipher::generic_array::GenericArray::from_mut_slice(chunk);
        cipher.encrypt_block(block);
        prev.copy_from_slice(chunk);
    }
    base64::engine::general_purpose::STANDARD.encode(&buf)
}

fn cosy_rsa_encrypt(pub_key_pem: &str, plain: &[u8]) -> String {
    let key = RsaPublicKey::from_public_key_pem(pub_key_pem).expect("rsa key");
    let mut rng = rand::thread_rng();
    let encrypted = key
        .encrypt(&mut rng, Pkcs1v15Encrypt, plain)
        .expect("rsa encrypt");
    base64::engine::general_purpose::STANDARD.encode(&encrypted)
}

#[derive(Debug, Clone)]
pub struct CosyHeaders {
    pub authorization: String,
    pub cosy_user: String,
    pub cosy_key: String,
    pub cosy_date: String,
    pub request_id: String,
}

pub struct Identity<'a> {
    pub aid: &'a str,
    pub uid: &'a str,
    pub yx_uid: &'a str,
    pub org_id: &'a str,
    pub org_name: &'a str,
    pub user_type: &'a str,
    pub refresh_token: &'a str,
}

impl Default for Identity<'_> {
    fn default() -> Self {
        Identity {
            aid: "",
            uid: "",
            yx_uid: "",
            org_id: "",
            org_name: "",
            user_type: "personal_standard",
            refresh_token: "",
        }
    }
}

pub fn build_cosy_headers(
    token: &str,
    user_id: &str,
    name: &str,
    email: &str,
    request_path: &str,
    request_body: &str,
    edition: &crate::editions::Edition,
    identity: &Identity,
) -> CosyHeaders {
    let aes_key = aes_key_material();
    let user_info = serde_json::json!({
        "name": name,
        "aid": identity.aid,
        "uid": if user_id.is_empty() { identity.uid } else { user_id },
        "yx_uid": identity.yx_uid,
        "organization_id": identity.org_id,
        "organization_name": identity.org_name,
        "user_type": identity.user_type,
        "security_oauth_token": token,
        "refresh_token": identity.refresh_token,
    });
    let encrypted_info = cosy_aes_encrypt(&user_info.to_string(), &aes_key);
    let rsa_encrypted_key = cosy_rsa_encrypt(&edition.legacy.server_pub_key, aes_key.as_bytes());
    let request_id = uuid().replace('-', "");
    let cosy_date = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string();
    let payload = serde_json::json!({
        "version": "v1",
        "requestId": request_id,
        "info": encrypted_info,
        "cosyVersion": edition.legacy.cosy_version,
        "ideVersion": "",
    });
    let payload_b64 = base64::engine::general_purpose::STANDARD.encode(payload.to_string().as_bytes());
    let sig_input = format!(
        "{}\n{}\n{}\n{}\n{}",
        payload_b64, rsa_encrypted_key, cosy_date, request_body, request_path
    );
    let signature = md5_hex(&sig_input);
    CosyHeaders {
        authorization: format!("Bearer COSY.{}.{}", payload_b64, signature),
        cosy_user: if user_id.is_empty() {
            identity.uid.to_string()
        } else {
            user_id.to_string()
        },
        cosy_key: rsa_encrypted_key,
        cosy_date,
        request_id,
    }
}

fn legacy_encode_with(plaintext: &str) -> String {
    let std_b64 = base64::engine::general_purpose::STANDARD.encode(plaintext.as_bytes());
    let bytes = std_b64.as_bytes();
    let n = bytes.len();
    let a = n / 3;
    // 末段前置重排：std[n-a:] + std[a:n-a] + std[:a]
    let mut rearranged = Vec::with_capacity(n);
    rearranged.extend_from_slice(&bytes[n - a..]);
    rearranged.extend_from_slice(&bytes[a..n - a]);
    rearranged.extend_from_slice(&bytes[..a]);
    let mut lookup: HashMap<u8, u8> = HashMap::new();
    for (i, &c) in STD_ALPHABET.iter().enumerate() {
        lookup.insert(c, CUSTOM_ALPHABET[i]);
    }
    lookup.insert(b'=', CUSTOM_PAD);
    rearranged
        .iter()
        .map(|&c| *lookup.get(&c).unwrap_or(&c))
        .map(|c| c as char)
        .collect()
}

pub fn legacy_encode(plaintext: &str) -> String {
    legacy_encode_with(plaintext)
}

pub fn legacy_decode(encoded: &str) -> String {
    let mut lookup: HashMap<u8, u8> = HashMap::new();
    for (i, &c) in CUSTOM_ALPHABET.iter().enumerate() {
        lookup.insert(c, STD_ALPHABET[i]);
    }
    lookup.insert(CUSTOM_PAD, b'=');
    let std_b64: String = encoded
        .bytes()
        .map(|c| *lookup.get(&c).unwrap_or(&c) as char)
        .collect();
    let bytes = std_b64.as_bytes();
    let n = bytes.len();
    let a = n / 3;
    // encoded = std[n-a:] + std[a:n-a] + std[:a]，还原
    let mut restored = Vec::with_capacity(n);
    restored.extend_from_slice(&bytes[n - a..]);
    restored.extend_from_slice(&bytes[a..n - a]);
    restored.extend_from_slice(&bytes[..a]);
    String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(&restored)
            .unwrap_or_default(),
    )
    .unwrap_or_default()
}

fn random_machine_token() -> String {
    let raw = format!("{}{}", uuid().replace('-', ""), uuid().replace('-', ""));
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    let mut out = String::with_capacity(bytes * 2);
    for b in buf {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// legacy 流式请求的完整 Cosy 头（含 machine 系列头）
pub fn build_legacy_stream_headers(
    account: &crate::account::Account,
    edition: &crate::editions::Edition,
    request_path: &str,
    request_body: &str,
) -> HashMap<String, String> {
    let machine_token = if account.machine_token.is_empty() {
        random_machine_token()
    } else {
        account.machine_token.clone()
    };
    let machine_type = if account.machine_type.is_empty() {
        random_hex(18)
    } else {
        account.machine_type.clone()
    };
    let machine_id = if account.machine_id.is_empty() {
        uuid()
    } else {
        account.machine_id.clone()
    };
    let identity = Identity {
        aid: &account.aid,
        uid: &account.uid,
        yx_uid: &account.yx_uid,
        org_id: &account.org_id,
        org_name: &account.org_name,
        user_type: &account.user_type,
        refresh_token: &account.refresh_token,
    };
    let cosy = build_cosy_headers(
        &account.security_oauth_token,
        &account.uid,
        &account.name,
        &account.email,
        request_path,
        request_body,
        edition,
        &identity,
    );
    let mut headers = HashMap::new();
    headers.insert("cache-control".into(), "no-cache".into());
    headers.insert("cosy-data-policy".into(), "AGREE".into());
    headers.insert("authorization".into(), cosy.authorization);
    headers.insert("content-type".into(), "application/json".into());
    headers.insert("cosy-clienttype".into(), "5".into());
    headers.insert("cosy-clientip".into(), "169.254.198.161".into());
    headers.insert("cosy-date".into(), cosy.cosy_date);
    headers.insert("cosy-key".into(), cosy.cosy_key);
    headers.insert("cosy-machineid".into(), machine_id);
    headers.insert("cosy-machinetoken".into(), machine_token);
    headers.insert("cosy-machinetype".into(), machine_type);
    headers.insert("cosy-user".into(), cosy.cosy_user);
    headers.insert("cosy-version".into(), edition.legacy.cosy_version.clone());
    headers.insert("login-version".into(), "v2".into());
    headers.insert("x-request-id".into(), cosy.request_id);
    headers
}
