import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";

export async function createClient(): Promise<TelegramClient> {
  const session = new StringSession(config.tgSession);
  const client = new TelegramClient(session, config.tgApiId, config.tgApiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
}
