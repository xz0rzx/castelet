import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import { config } from "./config.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

async function main() {
  console.log("Telegram Authentication");
  console.log("=======================\n");

  const client = new TelegramClient(
    new StringSession(""),
    config.tgApiId,
    config.tgApiHash,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () => await input.text("Enter your phone number: "),
    password: async () => await input.text("Enter your 2FA password (if set): "),
    phoneCode: async () => await input.text("Enter the code you received: "),
    onError: (err) => console.error("Auth error:", err.message),
  });

  const sessionString = client.session.save() as unknown as string;
  console.log("\nAuthentication successful!");
  console.log(`\nSession string:\n${sessionString}\n`);

  // Write session to .env file
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

  console.log("Session saved to .env file.");
  await client.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
