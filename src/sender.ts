import { Api } from "telegram";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "./client.js";
import type { GeneratedOutput } from "./types.js";

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    console.log(`Usage:
  npx tsx src/sender.ts <generatedJson> [--mode comment|latest] [--delay N]

Options:
  <generatedJson>      Path to generated output JSON (from generator)
  --mode <mode>        Send mode for channels:
                         comment  - comment under the specific post (default)
                         latest   - comment under the most recent post
  --delay N            Delay between sends in milliseconds (default: 2000)`);
    process.exit(0);
  }

  const inputJson = args[0];

  const getFlag = (name: string, defaultVal: string): string => {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return defaultVal;
  };

  return {
    inputJson: inputJson!,
    mode: getFlag("--mode", "comment") as "comment" | "latest",
    delay: Number(getFlag("--delay", "2000")),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { inputJson, mode, delay } = parseArgs();

  const data: GeneratedOutput = JSON.parse(
    readFileSync(resolve(inputJson), "utf-8")
  );

  const client = await createClient();

  try {
    for (const item of data.generatedTexts) {
      const { targetId, text } = item;
      const entity = await client.getEntity(targetId);

      const isChannel =
        entity instanceof Api.Channel && entity.broadcast;

      if (isChannel) {
        let postId: number;

        if (mode === "latest") {
          const msgs: Api.Message[] = [];
          for await (const msg of client.iterMessages(entity, { limit: 1 })) {
            if (msg instanceof Api.Message) msgs.push(msg);
          }
          if (msgs.length === 0) {
            console.error(`No posts found in channel ${targetId}`);
            continue;
          }
          postId = msgs[0].id;
          console.log(`Using latest post #${postId}`);
        } else {
          // "comment" mode — try to extract postId from source data
          const sourceData = JSON.parse(
            readFileSync(resolve(data.sourceFile), "utf-8")
          );
          if (sourceData.posts && sourceData.posts.length > 0) {
            postId = sourceData.posts[0].postId;
          } else {
            // Fallback to latest post
            const msgs: Api.Message[] = [];
            for await (const msg of client.iterMessages(entity, { limit: 1 })) {
              if (msg instanceof Api.Message) msgs.push(msg);
            }
            postId = msgs[0]?.id;
            if (!postId) {
              console.error(`No posts found in channel ${targetId}`);
              continue;
            }
          }
        }

        console.log(`Sending comment to ${targetId} on post #${postId}...`);
        await client.sendMessage(entity, {
          message: text,
          commentTo: postId,
        });
        console.log(`Sent comment on post #${postId}`);
      } else {
        // Group chat — send directly
        console.log(`Sending message to ${targetId}...`);
        await client.sendMessage(entity, { message: text });
        console.log(`Sent message to ${targetId}`);
      }

      if (data.generatedTexts.indexOf(item) < data.generatedTexts.length - 1) {
        console.log(`Waiting ${delay}ms...`);
        await sleep(delay);
      }
    }

    console.log("All messages sent.");
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  if (err.errorMessage === "FLOOD_WAIT") {
    const waitSeconds = err.seconds || 30;
    console.error(`Flood wait: retry after ${waitSeconds} seconds.`);
  } else {
    console.error("Fatal error:", err.message);
  }
  process.exit(1);
});
