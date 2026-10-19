// 占住 8787 端口（模拟其他工具占用），用于验证自动换端口
const net = require("node:net");
const server = net.createServer();
server.on("error", (e) => { console.error("occupy failed:", e.code); process.exit(1); });
server.listen(8787, "127.0.0.1", () => {
  console.log("8787 occupied");
  setInterval(() => {}, 60000);
});
