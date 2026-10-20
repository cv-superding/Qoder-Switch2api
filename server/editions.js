/**
 * 国内版 / 国际版双档位定义。
 *
 * 两个版本是两套独立部署：域名、账号体系、Credits 全部不互通。
 * 端点来源：
 *  - international：来自 qoder2api（Go）与 Qoder 官方 Cloud Agents 文档，已核实；
 *  - domestic：来自阿里云 Qoder CN 防火墙白名单与多个开源项目（cpa-multi-plugins /
 *    dsh-qoder-connect / 52pojie 签到脚本）交叉验证，已核实；
 *  - 少量字段（CN OAuth client_id、CN 模型列表域名）标注为推断，可在设置页覆盖。
 */

export const EDITION_LIST = ["domestic", "international"];

export const EDITIONS = {
  domestic: {
    value: "domestic",
    label: "国内版",
    productName: "Qoder CN",
    /** 客户端数据目录候选（按优先级），见 paths.js */
    clientDirs: ["com.qodercn.app.stable", "QoderCN", "Qoder CN"],
    clientProcessNames: ["Qoder", "QoderCN", "qodercn"],
    /** OAuth 设备流 */
    oauth: {
      loginBaseUrl: "https://qoder.com.cn/device/selectAccounts",
      openApiBaseUrl: "https://openapi.qoder.com.cn",
      // 推断值：QoderWork CN 使用的 client_id；Qoder CN IDE 若登录失败可在设置页修改
      clientId: "1c5e33e1-364d-4ce6-b02c-acaa81274a5c",
      clientIdInferred: true,
      pollPath: "/api/v1/deviceToken/poll",
      refreshPath: "/api/v1/deviceToken/refresh",
      userInfoPath: "/api/v1/userinfo",
      userStatusPath: "/api/v3/user/status",
      userPlanPath: "/api/v2/user/plan",
      quotaUsagePath: "/api/v2/quota/usage",
      meUsagePath: "/sash/api/v2/me/usage",
      campaignsPath: "/sash/api/v1/me/campaigns",
      claimPath: "/sash/api/v1/me/campaigns",
      patExchangePath: "/api/v1/jobToken/exchange",
    },
    /** 旧版 Cosy 流式对话（与 Qoder-Switch / qoder2api 同构） */
    legacy: {
      streamUrl:
        "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
      streamPath: "/api/v2/service/pro/sse/agent_chat_generation",
      modelListUrl: "https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1",
      cosyVersion: "0.1.43",
      serverPubKey:
        "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\nXcW+ML9FoCI6AOvOzwIDAQAB\n-----END PUBLIC KEY-----",
    },
    /** Cloud Agents（PAT）模式 */
    cloud: {
      baseUrl: "https://api.qoder.com.cn",
    },
    proxyDefaultPort: 7891,
    /** 端点是否全部经过交叉验证（false 的字段在 UI 标注「推断」） */
    verified: true,
  },
  international: {
    value: "international",
    label: "国际版",
    productName: "Qoder",
    // 新版 Qoder 桌面端实际使用 com.qoder.app.stable；旧版本曾使用 Qoder
    clientDirs: ["com.qoder.app.stable", "Qoder"],
    clientProcessNames: ["Qoder"],
    oauth: {
      loginBaseUrl: "https://qoder.com/device/selectAccounts",
      openApiBaseUrl: "https://openapi.qoder.sh",
      clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
      clientIdInferred: false,
      pollPath: "/api/v1/deviceToken/poll",
      refreshPath: "/api/v1/deviceToken/refresh",
      userInfoPath: "/api/v1/userinfo",
      userStatusPath: "/api/v3/user/status",
      userPlanPath: "/api/v2/user/plan",
      quotaUsagePath: "/api/v2/quota/usage",
      meUsagePath: "/sash/api/v2/me/usage",
      campaignsPath: "/sash/api/v1/me/campaigns",
      claimPath: "/sash/api/v1/me/campaigns",
      patExchangePath: "/api/v1/jobToken/exchange",
    },
    legacy: {
      streamUrl:
        "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
      streamPath: "/api/v2/service/pro/sse/agent_chat_generation",
      modelListUrl: "https://api3.qoder.sh/algo/api/v2/model/list?Encode=1",
      cosyVersion: "0.1.43",
      serverPubKey:
        "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\nXcW+ML9FoCI6AOvOzwIDAQAB\n-----END PUBLIC KEY-----",
    },
    cloud: {
      baseUrl: "https://api.qoder.com",
    },
    proxyDefaultPort: 7892,
    verified: true,
  },
};

export function editionOf(value) {
  return EDITIONS[value] ?? EDITIONS.domestic;
}

export function editionLabel(value) {
  return editionOf(value).label;
}

/** 账号分组（沿用 WorkBuddy-Switch2api 的语义） */
export const ACCOUNT_GROUPS = [
  { value: "", label: "未分组" },
  { value: "desktop", label: "桌面端" },
  { value: "proxy", label: "反代API" },
];

export function accountGroupLabel(group) {
  return ACCOUNT_GROUPS.find((g) => g.value === (group ?? ""))?.label ?? "未分组";
}
