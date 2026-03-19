import { Api } from "telegram";
import { createClient } from "./client.js";
import { resolve } from "path";
import type {
  ParsedMessage,
  ParsedChat,
  ParsedPost,
  ParsedChannelComments,
  MessageEntity,
  MediaInfo,
  MediaType,
  ForwardInfo,
  EntityType,
} from "./types.js";
import { hasFlag, getNumericFlag, getStringFlag, getPositionalArg } from "./utils/cli.js";
import { ensureDataDir, saveJson, buildTimestampedFilename } from "./utils/fs.js";
import { withRetry } from "./utils/retry.js";

// GramJS entity class name → our EntityType
const ENTITY_TYPE_MAP: Record<string, EntityType> = {
  MessageEntityBold: "bold",
  MessageEntityItalic: "italic",
  MessageEntityUnderline: "underline",
  MessageEntityStrike: "strikethrough",
  MessageEntityCode: "code",
  MessageEntityPre: "pre",
  MessageEntityTextUrl: "text_link",
  MessageEntityMention: "mention",
  MessageEntityMentionName: "mention",
  MessageEntityHashtag: "hashtag",
  MessageEntityBotCommand: "bot_command",
  MessageEntityUrl: "url",
  MessageEntityEmail: "email",
  MessageEntitySpoiler: "spoiler",
  MessageEntityBlockquote: "blockquote",
  MessageEntityCustomEmoji: "custom_emoji",
};

function extractEntities(msg: Api.Message): MessageEntity[] {
  if (!msg.entities) return [];
  return msg.entities
    .map((e) => {
      const type = ENTITY_TYPE_MAP[e.className];
      if (!type) return null;
      const entity: MessageEntity = {
        type,
        offset: e.offset,
        length: e.length,
      };
      if ("url" in e && typeof e.url === "string") entity.url = e.url;
      if ("language" in e && typeof e.language === "string") entity.language = e.language;
      if ("userId" in e && e.userId != null) entity.userId = String(e.userId);
      return entity;
    })
    .filter((e): e is MessageEntity => e !== null);
}

function extractMedia(msg: Api.Message): MediaInfo | undefined {
  const media = msg.media;
  if (!media) return undefined;

  let type: MediaType = "other";
  let mimeType: string | undefined;
  let fileName: string | undefined;
  let fileSize: number | undefined;

  if (media instanceof Api.MessageMediaPhoto) {
    type = "photo";
  } else if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    mimeType = doc.mimeType;
    fileSize = doc.size != null ? Number(doc.size) : undefined;

    // Determine type from MIME or attributes
    if (mimeType?.startsWith("video/")) {
      type = "video";
    } else if (mimeType?.startsWith("audio/")) {
      type = "audio";
    } else if (doc.attributes.some((a) => a.className === "DocumentAttributeSticker")) {
      type = "sticker";
    } else if (doc.attributes.some((a) => a.className === "DocumentAttributeAudio" && (a as unknown as Record<string, unknown>).voice)) {
      type = "voice";
    } else {
      type = "document";
    }

    const fileAttr = doc.attributes.find((a) => a.className === "DocumentAttributeFilename");
    if (fileAttr && "fileName" in fileAttr) fileName = String(fileAttr.fileName);
  } else if (media instanceof Api.MessageMediaPoll) {
    type = "poll";
  }

  const caption = msg.message || undefined;
  return { type, ...(mimeType && { mimeType }), ...(fileName && { fileName }), ...(fileSize && { fileSize }), ...(caption && { caption }) };
}

function extractForward(msg: Api.Message): ForwardInfo | undefined {
  const fwd = msg.fwdFrom;
  if (!fwd) return undefined;

  const info: ForwardInfo = {};
  if (fwd.fromId) info.fromId = String(fwd.fromId);
  if (fwd.fromName) info.fromName = fwd.fromName;
  if (fwd.date) info.date = new Date(fwd.date * 1000).toISOString();
  if (fwd.channelPost) info.channelPostId = fwd.channelPost;
  return info;
}

function toGroupedIdKey(groupedId: { toString(): string } | null | undefined): string | null {
  if (groupedId == null) return null;
  return groupedId.toString();
}

function getLogicalPostKey(msg: Api.Message): string {
  const groupedIdKey = toGroupedIdKey(msg.groupedId);
  return groupedIdKey ? `group:${groupedIdKey}` : `single:${msg.id}`;
}

function pickCanonicalPostMessage(messages: Api.Message[]): Api.Message {
  // For grouped albums, Telegram discussion threads are usually attached to the earliest item.
  const sortedByIdAsc = [...messages].sort((a, b) => a.id - b.id);
  return sortedByIdAsc[0];
}

function pickCaptionSourceMessage(messages: Api.Message[]): Api.Message | null {
  const withText = messages.filter((m) => !!m.message);
  if (withText.length === 0) return null;
  const sortedByIdAsc = withText.sort((a, b) => a.id - b.id);
  return sortedByIdAsc[0];
}

function parseArgs() {
  if (hasFlag("--help") || !getPositionalArg(0)) {
    console.log(`Usage:
  npx tsx src/parser.ts messages <chatId> [--limit N]
  npx tsx src/parser.ts comments <channelId> [--posts N] [--comments-per-post N]

Modes:
  messages    Fetch messages from a group or channel
  comments    Fetch comments under channel posts

Options:
  --limit N              Number of messages to fetch (default: 100)
  --posts N              Number of posts to fetch comments from (default: 10)
  --comments-per-post N  Max comments per post (default: 50)
  --session <name>       Use a named Telegram session
  --workspace-dir <dir>  Custom output workspace data directory`);
    process.exit(0);
  }

  const mode = getPositionalArg(0);
  const chatId = getPositionalArg(1);

  if (!mode || !chatId) {
    console.error("Error: mode and chatId are required.");
    process.exit(1);
  }

  return {
    mode,
    chatId,
    limit: getNumericFlag("--limit", 100),
    posts: getNumericFlag("--posts", 10),
    commentsPerPost: getNumericFlag("--comments-per-post", 50),
    session: getStringFlag("--session"),
    workspaceDir: getStringFlag("--workspace-dir"),
  };
}

function toMessage(msg: Api.Message): ParsedMessage | null {
  // Include messages with media even if text is empty
  if (!msg.message && !msg.media && !msg.id) return null;

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
    senderId: String(msg.senderId ?? "0"),
    senderName,
    text: msg.message || "",
    entities: extractEntities(msg),
    ...(msg.replyTo && "replyToMsgId" in msg.replyTo
      ? { replyToMsgId: msg.replyTo.replyToMsgId }
      : {}),
    ...(() => {
      const media = extractMedia(msg);
      return media ? { media } : {};
    })(),
    ...(() => {
      const forward = extractForward(msg);
      return forward ? { forward } : {};
    })(),
  };
}

async function fetchMessages(chatId: string, limit: number, session?: string, workspaceDir?: string) {
  const client = await createClient(session);
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

    const dataDir = ensureDataDir(workspaceDir);
    const filename = buildTimestampedFilename(chatId, "messages");
    saveJson(resolve(dataDir, filename), result);

    console.log(`Collected ${messages.length} messages.`);
  } finally {
    await client.disconnect();
  }
}

async function fetchComments(
  chatId: string,
  postsCount: number,
  commentsPerPost: number,
  session?: string,
  workspaceDir?: string,
) {
  const client = await createClient(session);
  try {
    const entity = await client.getEntity(chatId);
    const title =
      "title" in entity ? (entity.title ?? chatId) : chatId;

    console.log(`Fetching comments from "${title}" (${postsCount} posts, up to ${commentsPerPost} comments each)...`);

    const posts: ParsedPost[] = [];
    const groupedMessages = new Map<string, Api.Message[]>();
    const postKeysInOrder: string[] = [];

    for await (const msg of client.iterMessages(entity)) {
      if (!(msg instanceof Api.Message)) continue;
      const key = getLogicalPostKey(msg);
      if (!groupedMessages.has(key)) {
        groupedMessages.set(key, [msg]);
        postKeysInOrder.push(key);
      } else {
        groupedMessages.get(key)!.push(msg);
      }
      if (postKeysInOrder.length >= postsCount) break;
    }

    for (const key of postKeysInOrder) {
      const messageGroup = groupedMessages.get(key) || [];
      if (messageGroup.length === 0) continue;
      const post = pickCanonicalPostMessage(messageGroup);
      const captionSource = pickCaptionSourceMessage(messageGroup);
      const comments: ParsedMessage[] = [];
      try {
        await withRetry(
          async () => {
            for await (const reply of client.iterMessages(entity, {
              replyTo: post.id,
              limit: commentsPerPost,
            })) {
              if (reply instanceof Api.Message) {
                const parsed = toMessage(reply);
                if (parsed) comments.push(parsed);
              }
            }
          },
          {
            maxRetries: 2,
            onRetry: (err, attempt, delayMs) => {
              console.warn(`Retrying comments for post ${post.id} (attempt ${attempt}, waiting ${delayMs}ms)...`);
            },
          },
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Skipping comments for post ${post.id}: ${message}`);
      }

      posts.push({
        postId: post.id,
        postText: captionSource?.message || "",
        postEntities: captionSource ? extractEntities(captionSource) : extractEntities(post),
        ...(() => {
          const media = extractMedia(post);
          return media ? { postMedia: media } : {};
        })(),
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

    const dataDir = ensureDataDir(workspaceDir);
    const filename = buildTimestampedFilename(chatId, "comments");
    saveJson(resolve(dataDir, filename), result);

    console.log(`Collected comments from ${posts.length} posts.`);
  } finally {
    await client.disconnect();
  }
}

async function main() {
  const { mode, chatId, limit, posts, commentsPerPost, session, workspaceDir } = parseArgs();

  if (mode === "messages") {
    await fetchMessages(chatId, limit, session, workspaceDir);
  } else if (mode === "comments") {
    await fetchComments(chatId, posts, commentsPerPost, session, workspaceDir);
  } else {
    console.error(`Unknown mode: ${mode}. Use "messages" or "comments".`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
