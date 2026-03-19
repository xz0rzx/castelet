import { createConnection } from "node:net";
import type { ProxyConfig } from "./types.js";

export function testProxyConnectivity(proxy: ProxyConfig, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: proxy.ip, port: proxy.port });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Proxy ${proxy.ip}:${proxy.port} connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Proxy ${proxy.ip}:${proxy.port} unreachable: ${err.message}`));
    });
  });
}
