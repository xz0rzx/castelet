import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";
import { getSession, getActiveSession, touchSession } from "./session-store.js";
import { testProxyConnectivity } from "./proxy-check.js";
import type { ProxyConfig } from "./types.js";

export async function createClient(sessionName?: string): Promise<TelegramClient> {
  let sessionString = config.tgSession;
  let proxy: ProxyConfig | undefined;

  if (sessionName) {
    const entry = getSession(sessionName);
    if (!entry) {
      throw new Error(`Session "${sessionName}" not found.`);
    }
    sessionString = entry.sessionString;
    proxy = entry.proxy;
    touchSession(sessionName);
  } else {
    const active = getActiveSession();
    if (active) {
      sessionString = active.sessionString;
      proxy = active.proxy;
      touchSession(active.name);
    }
  }

  // Kill switch: if proxy is configured, verify it's reachable before connecting
  if (proxy) {
    await testProxyConnectivity(proxy);
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, config.tgApiId, config.tgApiHash, {
    connectionRetries: 5,
    ...(proxy ? { proxy } : {}),
  });
  await client.connect();
  return client;
}
