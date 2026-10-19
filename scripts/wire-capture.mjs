// 本地 TCP 监听器：捕获 Rust/Node 发出的原始 HTTP 请求字节
import net from "node:net";
import fs from "node:fs";

const PORT = 9999;
const OUT = process.argv[2] ?? "C:/Users/Administrator/AppData/Local/Temp/wire-capture.txt";

const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    // 请求头结束后再等一小会儿拿全 body
    if (buf.includes("\r\n\r\n")) {
      const headerEnd = buf.indexOf("\r\n\r\n") + 4;
      const lenMatch = /content-length: (\d+)/i.exec(buf.slice(0, headerEnd).toString());
      if (lenMatch) {
        const need = headerEnd + parseInt(lenMatch[1], 10);
        if (buf.length < need) return;
      }
    }
    fs.appendFileSync(OUT, "===== CAPTURE " + new Date().toISOString() + " =====\n" + buf.toString("utf8") + "\n");
    socket.end("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\ndata: [DONE]\n\n");
    setTimeout(() => socket.destroy(), 100);
  });
  socket.on("error", () => {});
});
server.listen(PORT, "127.0.0.1", () => console.log(`capturing on :${PORT} → ${OUT}`));
