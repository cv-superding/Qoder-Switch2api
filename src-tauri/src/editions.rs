//! 国内版 / 国际版双档位定义。

use serde::{Deserialize, Serialize};

pub const EDITION_LIST: [&str; 2] = ["domestic", "international"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OauthEdition {
    pub login_base_url: String,
    pub open_api_base_url: String,
    pub client_id: String,
    pub client_id_inferred: bool,
    pub poll_path: String,
    pub refresh_path: String,
    pub user_info_path: String,
    pub user_status_path: String,
    pub user_plan_path: String,
    pub quota_usage_path: String,
    pub me_usage_path: String,
    pub campaigns_path: String,
    pub claim_path: String,
    pub pat_exchange_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyEdition {
    pub stream_url: String,
    pub stream_path: String,
    pub model_list_url: String,
    #[serde(default)]
    pub model_list_fallbacks: Vec<String>,
    pub cosy_version: String,
    pub server_pub_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudEdition {
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edition {
    pub value: String,
    pub label: String,
    pub product_name: String,
    pub client_dirs: Vec<String>,
    pub client_process_names: Vec<String>,
    pub oauth: OauthEdition,
    pub legacy: LegacyEdition,
    pub cloud: CloudEdition,
    pub proxy_default_port: u16,
}

pub fn editions() -> Vec<Edition> {
    vec![domestic(), international()]
}

pub fn edition_of(value: &str) -> Edition {
    if value == "international" {
        international()
    } else {
        domestic()
    }
}

pub fn domestic() -> Edition {
    Edition {
        value: "domestic".into(),
        label: "国内版".into(),
        product_name: "Qoder CN".into(),
        client_dirs: vec![
            "com.qodercn.app.stable".into(),
            "QoderCN".into(),
            "Qoder CN".into(),
        ],
        client_process_names: vec!["Qoder".into(), "QoderCN".into()],
        oauth: OauthEdition {
            login_base_url: "https://qoder.com.cn/device/selectAccounts".into(),
            open_api_base_url: "https://openapi.qoder.com.cn".into(),
            client_id: "1c5e33e1-364d-4ce6-b02c-acaa81274a5c".into(),
            client_id_inferred: true,
            poll_path: "/api/v1/deviceToken/poll".into(),
            refresh_path: "/api/v1/deviceToken/refresh".into(),
            user_info_path: "/api/v1/userinfo".into(),
            user_status_path: "/api/v3/user/status".into(),
            user_plan_path: "/api/v2/user/plan".into(),
            quota_usage_path: "/api/v2/quota/usage".into(),
            me_usage_path: "/sash/api/v2/me/usage".into(),
            campaigns_path: "/sash/api/v1/me/campaigns".into(),
            claim_path: "/sash/api/v1/me/campaigns".into(),
            pat_exchange_path: "/api/v1/jobToken/exchange".into(),
        },
        legacy: LegacyEdition {
            stream_url: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1".into(),
            stream_path: "/api/v2/service/pro/sse/agent_chat_generation".into(),
            model_list_url: "https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1".into(),
            model_list_fallbacks: vec![],
            cosy_version: "0.1.43".into(),
            server_pub_key: "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\nXcW+ML9FoCI6AOvOzwIDAQAB\n-----END PUBLIC KEY-----".into(),
        },
        cloud: CloudEdition {
            base_url: "https://api.qoder.com.cn".into(),
        },
        proxy_default_port: 7891,
    }
}

pub fn international() -> Edition {
    Edition {
        value: "international".into(),
        label: "国际版".into(),
        product_name: "Qoder".into(),
        client_dirs: vec!["com.qoder.app.stable".into(), "Qoder".into()],
        client_process_names: vec!["Qoder".into()],
        oauth: OauthEdition {
            login_base_url: "https://qoder.com/device/selectAccounts".into(),
            open_api_base_url: "https://openapi.qoder.sh".into(),
            client_id: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb".into(),
            client_id_inferred: false,
            poll_path: "/api/v1/deviceToken/poll".into(),
            refresh_path: "/api/v1/deviceToken/refresh".into(),
            user_info_path: "/api/v1/userinfo".into(),
            user_status_path: "/api/v3/user/status".into(),
            user_plan_path: "/api/v2/user/plan".into(),
            quota_usage_path: "/api/v2/quota/usage".into(),
            me_usage_path: "/sash/api/v2/me/usage".into(),
            campaigns_path: "/sash/api/v1/me/campaigns".into(),
            claim_path: "/sash/api/v1/me/campaigns".into(),
            pat_exchange_path: "/api/v1/jobToken/exchange".into(),
        },
        legacy: LegacyEdition {
            stream_url: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1".into(),
            stream_path: "/api/v2/service/pro/sse/agent_chat_generation".into(),
            model_list_url: "https://api1.qoder.sh/algo/api/v2/model/list?Encode=1".into(),
            model_list_fallbacks: vec![
                "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1".into(),
                "https://api3.qoder.sh/algo/api/v2/model/list?Encode=1".into(),
            ],
            cosy_version: "0.1.43".into(),
            server_pub_key: "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\nXcW+ML9FoCI6AOvOzwIDAQAB\n-----END PUBLIC KEY-----".into(),
        },
        cloud: CloudEdition {
            base_url: "https://api.qoder.com".into(),
        },
        proxy_default_port: 7892,
    }
}

pub fn account_group_label(group: &str) -> &'static str {
    match group {
        "desktop" => "桌面端",
        "proxy" => "反代API",
        _ => "未分组",
    }
}
