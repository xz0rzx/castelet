import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { handleApi } from "./api.js";
import { migrateFromEnv } from "../session-store.js";

migrateFromEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CASTELET_PORT) || 3333;
const WEB_DIR = resolve(__dirname, "..", "..", "web");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(path: string, res: import("node:http").ServerResponse) {
  let filePath: string;
  if (path === "/" || path === "/index.html") {
    filePath = resolve(WEB_DIR, "index.html");
  } else {
    filePath = resolve(WEB_DIR, path.slice(1));
  }

  // Prevent directory traversal
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    try {
      await handleApi(req, res, path);
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  serveStatic(path, res);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Castelet UI running at ${url}`);

  // Auto-open browser
  const openCmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} ${url}`);
});
