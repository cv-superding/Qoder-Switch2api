//! 共享应用状态。

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::account::AccountManager;
use crate::editions::Edition;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub listen: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub extra_models: Vec<String>,
    #[serde(default = "default_group")]
    pub account_group: String,
}

fn default_group() -> String {
    "proxy".into()
}

impl Default for ProxyConfig {
    fn default() -> Self {
        ProxyConfig {
            enabled: false,
            listen: "127.0.0.1:7891".into(),
            api_key: String::new(),
            extra_models: Vec::new(),
            account_group: "proxy".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_close_to_tray")]
    pub close_to_tray: bool,
    #[serde(default = "default_keepalive")]
    pub token_keepalive: bool,
    #[serde(default)]
    pub client_dir_overrides: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub client_exe_paths: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub auto_checkin: AutoCheckin,
    #[serde(default)]
    pub endpoint_overrides: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub proxy: std::collections::HashMap<String, ProxyConfig>,
}

fn default_theme() -> String {
    "light".into()
}

fn default_close_to_tray() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCheckin {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_hour")]
    pub hour: i64,
}

fn default_hour() -> i64 {
    10
}

fn default_keepalive() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        let mut proxy = std::collections::HashMap::new();
        proxy.insert("domestic".into(), ProxyConfig { enabled: false, listen: "127.0.0.1:7891".into(), ..Default::default() });
        proxy.insert("international".into(), ProxyConfig { enabled: false, listen: "127.0.0.1:7892".into(), ..Default::default() });
        Settings {
            theme: "light".into(),
            close_to_tray: true,
            token_keepalive: true,
            client_dir_overrides: Default::default(),
            client_exe_paths: Default::default(),
            auto_checkin: AutoCheckin { enabled: false, hour: 10 },
            endpoint_overrides: Default::default(),
            proxy,
        }
    }
}

pub struct AppState {
    pub accounts: RwLock<AccountManager>,
    pub settings: RwLock<Settings>,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        let accounts = AccountManager::load();
        let mut settings = crate::store::load_json::<Settings>("settings.json");
        settings.auto_checkin.hour = settings.auto_checkin.hour.clamp(0, 23);
        Arc::new(AppState {
            accounts: RwLock::new(accounts),
            settings: RwLock::new(settings),
        })
    }

    pub async fn proxy_config(&self, edition: &str) -> ProxyConfig {
        let settings = self.settings.read().await;
        settings
            .proxy
            .get(edition)
            .cloned()
            .unwrap_or_else(|| ProxyConfig {
                listen: if edition == "international" { "127.0.0.1:7892".into() } else { "127.0.0.1:7891".into() },
                ..Default::default()
            })
    }

    pub fn proxy_config_sync(&self, edition: &str) -> ProxyConfig {
        let settings = self.settings.try_read();
        match settings {
            Ok(settings) => settings
                .proxy
                .get(edition)
                .cloned()
                .unwrap_or_else(|| ProxyConfig {
                    listen: if edition == "international" { "127.0.0.1:7892".into() } else { "127.0.0.1:7891".into() },
                    ..Default::default()
                }),
            Err(_) => ProxyConfig {
                listen: if edition == "international" { "127.0.0.1:7892".into() } else { "127.0.0.1:7891".into() },
                ..Default::default()
            },
        }
    }

    /// 生效的 edition（应用端点覆盖）
    pub async fn effective_edition(&self, value: &str) -> Edition {
        let base = crate::editions::edition_of(value);
        let settings = self.settings.read().await;
        let overrides = match settings.endpoint_overrides.get(value) {
            Some(o) => o,
            None => return base,
        };
        if overrides.is_empty() {
            return base;
        }
        let mut edition = base;
        if let Some(v) = overrides.get("clientId") {
            edition.oauth.client_id = v.clone();
        }
        if let Some(v) = overrides.get("openApiBaseUrl") {
            edition.oauth.open_api_base_url = v.clone();
        }
        if let Some(v) = overrides.get("streamUrl") {
            edition.legacy.stream_url = v.clone();
        }
        if let Some(v) = overrides.get("modelListUrl") {
            edition.legacy.model_list_url = v.clone();
            edition.legacy.model_list_fallbacks.clear();
        }
        if let Some(v) = overrides.get("cloudBaseUrl") {
            edition.cloud.base_url = v.clone();
        }
        edition
    }
}
