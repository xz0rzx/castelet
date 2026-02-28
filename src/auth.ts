import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import { config } from "./config.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { addSession, setActiveSession, isValidSessionName } from "./session-store.js";
import type { TgSession } from "./types.js";

function getFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

async function main() {
  console.log("Telegram Authentication");
  console.log("=======================\n");

  let sessionName = getFlag("--name") || "default";
  if (!isValidSessionName(sessionName)) {
    console.error(
      `Invalid session name "${sessionName}". Use lowercase letters, numbers, hyphens, underscores (max 32 chars).`,
    );
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(""),
    config.tgApiId,
    config.tgApiHash,
    { connectionRetries: 5 }
  );

  let phone = "";

  await client.start({
    phoneNumber: async () => {
      phone = await input.text("Enter your phone number: ");
      return phone;
    },
    password: async () => await input.text("Enter your 2FA password (if set): "),
    phoneCode: async () => await input.text("Enter the code you received: "),
    onError: (err) => console.error("Auth error:", err.message),
  });

  const sessionString = client.session.save() as unknown as string;
  console.log("\nAuthentication successful!");

  // Fetch display name
  let displayName = sessionName;
  try {
    const me = await client.getMe();
    if (me && "firstName" in me) {
      displayName = [me.firstName, me.lastName].filter(Boolean).join(" ") || displayName;
    }
  } catch {
    // ignore
  }

  // Save to session registry
  const entry: TgSession = {
    name: sessionName,
    sessionString,
    phone,
    displayName,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  addSession(entry);
  setActiveSession(sessionName);
  console.log(`Session "${sessionName}" saved to data/sessions.json and set as active.`);

  // Also write session to .env for backward compatibility
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    let envContent = readFileSync(envPath, "utf-8");
    if (envContent.match(/^TG_SESSION=.*$/m)) {
      envContent = envContent.replace(/^TG_SESSION=.*$/m, `TG_SESSION=${sessionString}`);
    } else {
      envContent += `\nTG_SESSION=${sessionString}\n`;
    }
    writeFileSync(envPath, envContent);
  } else {
    writeFileSync(envPath, `TG_SESSION=${sessionString}\n`);
  }
  process.env.TG_SESSION = sessionString;
  console.log("Session also saved to .env file.");

  await client.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
