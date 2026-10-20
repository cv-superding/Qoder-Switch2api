//! 统一 HTTP 客户端：避免个别上游卡死时阻塞整个 WebUI / 反代。
use std::time::Duration;

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 流式请求只限制建连时间，总时长由调用方按帧控制
pub fn stream_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}
