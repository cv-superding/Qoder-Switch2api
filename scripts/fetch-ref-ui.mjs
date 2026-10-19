// 拉取原版 WorkBuddy-Switch2api 的关键 UI 文件作对照
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.argv[2];
const FILES = [
  "src/App.tsx",
  "src/components/account-card.tsx",
  "src/pages/AccountsPage.tsx",
  "src/index.css",
];
const OUT = "C:/Users/Administrator/AppData/Local/Temp/ref-ui";

for (const f of FILES) {
  const resp = await fetch(`https://api.github.com/repos/cv-superding/WorkBuddy-Switch2api/contents/${f}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ref-fetch" },
  });
  const j = await resp.json();
  if (!j.content) { console.log("fail", f, j.message || ""); continue; }
  const dest = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(j.content, "base64"));
  console.log("got", f);
}
