import { Api } from "telegram";
import { createClient } from "./client.js";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { ParsedMessage, ParsedChat, ParsedPost, ParsedChannelComments } from "./types.js";

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    console.log(`Usage:
  npx tsx src/parser.ts messages <chatId> [--limit N]
  npx tsx src/parser.ts comments <channelId> [--posts N] [--comments-per-post N]

Modes:
  messages    Fetch messages from a group or channel
  comments    Fetch comments under channel posts

Options:
  --limit N              Number of messages to fetch (default: 100)
  --posts N              Number of posts to fetch comments from (default: 10)
  --comments-per-post N  Max comments per post (default: 50)`);
    process.exit(0);
  }

  const mode = args[0];
  const chatId = args[1];

  if (!mode || !chatId) {
    console.error("Error: mode and chatId are required.");
    process.exit(1);
  }

  const getFlag = (name: string, defaultVal: number): number => {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return Number(args[idx + 1]);
    return defaultVal;
  };

  return {
    mode,
    chatId,
    limit: getFlag("--limit", 100),
    posts: getFlag("--posts", 10),
    commentsPerPost: getFlag("--comments-per-post", 50),
  };
}

function toMessage(msg: Api.Message): ParsedMessage | null {
  if (!msg.message && !msg.id) return null;
  const sender = msg.sender;
  let senderName = "Unknown";
  if (sender instanceof Api.User) {
    senderName = [sender.firstName, sender.lastName].filter(Boolean).join(" ");
  } else if (sender instanceof Api.Channel || sender instanceof Api.Chat) {
    senderName = sender.title || "Unknown";
  }

  return {
    id: msg.id,
    date: new Date((msg.date ?? 0) * 1000).toISOString(),
    senderId: Number(msg.senderId ?? 0),
    senderName,
    text: msg.message || "",
    ...(msg.replyTo && "replyToMsgId" in msg.replyTo
      ? { replyToMsgId: msg.replyTo.replyToMsgId }
      : {}),
  };
}

function ensureDataDir(): string {
  const dataDir = resolve(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function saveJson(dataDir: string, filename: string, data: unknown) {
  const filePath = resolve(dataDir, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Saved: ${filePath}`);
}

async function fetchMessages(chatId: string, limit: number) {
  const client = await createClient();
  try {
    const entity = await client.getEntity(chatId);
    const title =
      entity instanceof Api.User
        ? [entity.firstName, entity.lastName].filter(Boolean).join(" ")
        : "title" in entity
          ? (entity.title ?? chatId)
          : chatId;

    console.log(`Fetching ${limit} messages from "${title}"...`);

    const messages: ParsedMessage[] = [];
    for await (const msg of client.iterMessages(entity, { limit })) {
      if (msg instanceof Api.Message) {
        const parsed = toMessage(msg);
        if (parsed) messages.push(parsed);
      }
    }

    const result: ParsedChat = {
      chatId,
      chatTitle: String(title),
      type: entity instanceof Api.Channel && entity.broadcast ? "channel" : "group",
      collectedAt: new Date().toISOString(),
      messages,
    };

    const dataDir = ensureDataDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    saveJson(dataDir, `${safeChatId}_messages_${timestamp}.json`, result);

    console.log(`Collected ${messages.length} messages.`);
  } finally {
    await client.disconnect();
  }
}

async function fetchComments(chatId: string, postsCount: number, commentsPerPost: number) {
  const client = await createClient();
  try {
    const entity = await client.getEntity(chatId);
    const title =
      "title" in entity ? (entity.title ?? chatId) : chatId;

    console.log(`Fetching comments from "${title}" (${postsCount} posts, up to ${commentsPerPost} comments each)...`);

    const posts: ParsedPost[] = [];
    const postMessages: Api.Message[] = [];

    for await (const msg of client.iterMessages(entity, { limit: postsCount })) {
      if (msg instanceof Api.Message) {
        postMessages.push(msg);
      }
    }

    for (const post of postMessages) {
      const comments: ParsedMessage[] = [];
      try {
        for await (const reply of client.iterMessages(entity, {
          replyTo: post.id,
          limit: commentsPerPost,
        })) {
          if (reply instanceof Api.Message) {
            const parsed = toMessage(reply);
            if (parsed) comments.push(parsed);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Skipping comments for post ${post.id}: ${message}`);
      }

      posts.push({
        postId: post.id,
        postText: post.message || "",
        comments,
      });

      console.log(`Post ${post.id}: ${comments.length} comments`);
    }

    const result: ParsedChannelComments = {
      chatId,
      chatTitle: String(title),
      type: "channel_comments",
      collectedAt: new Date().toISOString(),
      posts,
    };

    const dataDir = ensureDataDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    saveJson(dataDir, `${safeChatId}_comments_${timestamp}.json`, result);

    console.log(`Collected comments from ${posts.length} posts.`);
  } finally {
    await client.disconnect();
  }
}

async function main() {
  const { mode, chatId, limit, posts, commentsPerPost } = parseArgs();

  if (mode === "messages") {
    await fetchMessages(chatId, limit);
  } else if (mode === "comments") {
    await fetchComments(chatId, posts, commentsPerPost);
  } else {
    console.error(`Unknown mode: ${mode}. Use "messages" or "comments".`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
