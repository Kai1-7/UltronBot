const http = require("node:http");
const { getRuntimeMetrics, sampleRuntimeMetrics } = require("./metrics");

function startHealthServer(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/" || url.pathname === "/healthz" || url.pathname === "/metrics") {
      const metrics = url.pathname === "/metrics" ? sampleRuntimeMetrics() : getRuntimeMetrics();

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "Ultron Bot",
          uptimeSeconds: Math.floor(process.uptime()),
          metrics
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Not Found" }));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Health server escuchando en 0.0.0.0:${port}`);
  });

  return server;
}

module.exports = { startHealthServer };
