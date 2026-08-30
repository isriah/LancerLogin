import { createServer } from "node:http";

const port = Number(process.env.LANCERLOGIN_KIOSK_PORT ?? 8788);
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (request.url === "/health") { response.end(JSON.stringify({ ok: true, service: "lancerlogin-kiosk", readerOnline: false, paired: false })); return; }
  response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" }));
});

if (process.env.NODE_ENV !== "test") server.listen(port, "127.0.0.1", () => console.log(`LancerLogin kiosk service listening on http://127.0.0.1:${port}`));

export { server };
