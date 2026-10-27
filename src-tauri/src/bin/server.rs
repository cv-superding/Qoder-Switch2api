//! 独立服务模式：不起桌面窗口，只跑 Web 服务 + 反代（等价于 Node 版 npm start）。
//! 构建：cargo build --bin qoder-server

#[tokio::main]
async fn main() {
    let state = qoder_switch2api_lib::AppState::new();
    qoder_switch2api_lib::refresh_proxy_servers(&state).await;
    // 独立服务模式也必须启动自动签到，否则设置页的开关只是展示
    let state_for_checkin = state.clone();
    tokio::spawn(async move {
        qoder_switch2api_lib::schedule_auto_checkin(state_for_checkin).await;
    });
    let state_for_keepalive = state.clone();
    tokio::spawn(async move {
        qoder_switch2api_lib::schedule_token_keepalive(state_for_keepalive).await;
    });
    qoder_switch2api_lib::start_web_server(state).await;
}
