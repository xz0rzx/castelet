import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";
import { getSession, getActiveSession, touchSession } from "./session-store.js";

export async function createClient(sessionName?: string): Promise<TelegramClient> {
  let sessionString = config.tgSession;

  if (sessionName) {
    const entry = getSession(sessionName);
    if (entry) {
      sessionString = entry.sessionString;
      touchSession(sessionName);
    }
  } else {
    const active = getActiveSession();
    if (active) {
      sessionString = active.sessionString;
      touchSession(active.name);
    }
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, config.tgApiId, config.tgApiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
}
