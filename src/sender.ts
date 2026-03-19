import { Api, TelegramClient } from "telegram";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { createClient } from "./client.js";
import type { GeneratedOutput } from "./types.js";
import { hasFlag, getStringFlag, getNumericFlag, getPositionalArg } from "./utils/cli.js";
import { withRetry, sleep } from "./utils/retry.js";

function parseArgs() {
  if (hasFlag("--help") || !getPositionalArg(0)) {
    console.log(`Usage:
  npx tsx src/sender.ts <generatedJson> [--mode comment|latest] [--delay N]

Options:
  <generatedJson>      Path to generated output JSON (from generator)
  --mode <mode>        Send mode for channels:
                         comment  - comment under the specific post (default)
                         latest   - comment under the most recent post
  --delay N            Delay between sends in milliseconds (default: 2000)
  --session <name>     Use a named Telegram session
  --workspace-dir <dir>  Workspace directory (reserved for workspace mode)`);
    process.exit(0);
  }

  return {
    inputJson: getPositionalArg(0)!,
    mode: (getStringFlag("--mode", "comment")) as "comment" | "latest",
    delay: getNumericFlag("--delay", 2000),
    session: getStringFlag("--session"),
    workspaceDir: getStringFlag("--workspace-dir"),
  };
}

function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try splitting at paragraph break
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt <= 0) {
      // Try splitting at line break
      splitAt = remaining.lastIndexOf("\n", limit);
    }
    if (splitAt <= 0) {
      // Try splitting at space
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0) {
      // Hard split
      splitAt = limit;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  console.log(`Split message (${text.length} chars) into ${chunks.length} chunks.`);
  return chunks;
}

async function fetchLatestPostId(
  client: TelegramClient,
  entity: Api.Channel,
): Promise<number | null> {
  for await (const msg of client.iterMessages(entity, { limit: 1 })) {
    if (msg instanceof Api.Message) return msg.id;
  }
  return null;
}

async function main() {
  const { inputJson, mode, delay, session } = parseArgs();

  const inputPath = resolve(inputJson);
  const data: GeneratedOutput = JSON.parse(
    readFileSync(inputPath, "utf-8"),
  );

  const client = await createClient(session);

  try {
    for (let i = 0; i < data.generatedTexts.length; i++) {
      const { targetId, text } = data.generatedTexts[i];
      const entity = await client.getEntity(targetId);

      const isChannel =
        entity instanceof Api.Channel && entity.broadcast;

      const chunks = splitMessage(text);

      if (isChannel) {
        let postId: number;

        if (mode === "latest") {
          const latestId = await fetchLatestPostId(client, entity);
          if (!latestId) {
            console.error(`No posts found in channel ${targetId}`);
            continue;
          }
          postId = latestId;
          console.log(`Using latest post #${postId}`);
        } else {
          // "comment" mode — try to extract postId from source data
          // Resolve sourceFile relative to the generated JSON's directory
          const sourceFilePath = resolve(dirname(inputPath), data.sourceFile);
          const sourceData = JSON.parse(
            readFileSync(sourceFilePath, "utf-8"),
          );
          if (sourceData.posts && sourceData.posts.length > 0) {
            postId = sourceData.posts[0].postId;
          } else {
            // Fallback to latest post
            const latestId = await fetchLatestPostId(client, entity);
            if (!latestId) {
              console.error(`No posts found in channel ${targetId}`);
              continue;
            }
            postId = latestId;
          }
        }

        for (const chunk of chunks) {
          console.log(`Sending comment to ${targetId} on post #${postId}...`);
          await withRetry(
            () => client.sendMessage(entity, { message: chunk, commentTo: postId }),
            {
              maxRetries: 3,
              onRetry: (err, attempt, delayMs) => {
                console.warn(`Retry ${attempt} for send to ${targetId} (waiting ${delayMs}ms)...`);
              },
            },
          );
          console.log(`Sent comment on post #${postId}`);
        }
      } else {
        // Group chat — send directly
        for (const chunk of chunks) {
          console.log(`Sending message to ${targetId}...`);
          await withRetry(
            () => client.sendMessage(entity, { message: chunk }),
            {
              maxRetries: 3,
              onRetry: (err, attempt, delayMs) => {
                console.warn(`Retry ${attempt} for send to ${targetId} (waiting ${delayMs}ms)...`);
              },
            },
          );
          console.log(`Sent message to ${targetId}`);
        }
      }

      if (i < data.generatedTexts.length - 1) {
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
  console.error("Fatal error:", err.message);
  process.exit(1);
});
