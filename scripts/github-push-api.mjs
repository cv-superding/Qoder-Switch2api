// 通过 GitHub Git Data API 直推仓库（绕过对 github.com git 端点的代理封锁）
// 用法: node scripts/github-push-api.mjs <token> <owner> <repo> <branch>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [token, owner, repo, branch = "main"] = process.argv.slice(2);
if (!token || !owner || !repo) {
  console.error("usage: node github-push-api.mjs <token> <owner> <repo> [branch]");
  process.exit(1);
}
const ROOT = "E:\\code\\workbuddy-project\\Qoder-Switch2api";
const API = "https://api.github.com";

async function api(path, body, method, raw = false) {
  method = method || (body ? "POST" : "GET");
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "push-script",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path} -> ${resp.status}: ${text.slice(0, 300)}`);
  return raw ? text : JSON.parse(text);
}

// 收集要上传的文件（与 .gitignore 一致）
const IGNORE = /(^|[\\/])(node_modules|dist|\.smoke|\.workbuddy|target|gen)([\\/]|$)|\.log$|\.tmp$|\.git[\\/]/;
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (IGNORE.test(rel) || rel === ".cargo" && false) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
console.log(`files to push: ${files.length}`);

// 1. 逐个创建 blob（并发 8）
const tree = [];
let done = 0;
const queue = [...files];
async function worker() {
  while (queue.length) {
    const full = queue.shift();
    const rel = relative(ROOT, full).split(sep).join("/");
    const content = readFileSync(full);
    const isText = !content.slice(0, 8000).includes(0);
    const blob = await api(`/repos/${owner}/${repo}/git/blobs`, isText
      ? { content: content.toString("utf8"), encoding: "utf-8" }
      : { content: content.toString("base64"), encoding: "base64" });
    tree.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
    done++;
    if (done % 20 === 0) console.log(`blobs: ${done}/${files.length}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`blobs created: ${tree.length}`);

// 2. 基树：远程 main（若存在）
let baseTree;
try {
  const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const baseCommit = await api(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
  baseTree = baseCommit.tree.sha;
  console.log(`base tree: ${baseTree}`);
} catch { console.log("no remote branch, creating root tree"); }

// 3. 创建 tree
const newTree = await api(`/repos/${owner}/${repo}/git/trees`, {
  base_tree: baseTree, tree,
});
console.log(`tree: ${newTree.sha}`);

// 4. 创建 commit
const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  message: "Qoder-Switch2api: 账号切换 + OpenAI/Anthropic 兼容反代网关\n\n- 双档位（国内/国际）账号管理：OAuth 设备流 / 客户端登录态导入 / PAT\n- Cosy 签名流式聊天，反代 OpenAI/Anthropic 双协议\n- 账号池轮转 + 失败冷却 + 401 自动续期\n- Node/Express 后端（可运行）+ Tauri/Rust 后端（src-tauri）",
  tree: newTree.sha,
  parents: baseTree ? [] : undefined,
});
console.log(`commit: ${commit.sha}`);

// 5. 更新 ref（force，本地为准）
try {
  await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true }, "PATCH");
} catch {
  await api(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha }, "POST");
}
console.log(`PUSHED: https://github.com/${owner}/${repo}/commit/${commit.sha}`);
