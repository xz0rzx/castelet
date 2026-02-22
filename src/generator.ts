import { readFileSync } from "fs";
import { resolve, basename } from "path";
import OpenAI from "openai";
import { config } from "./config.js";
import type {
  ParsedChat,
  ParsedChannelComments,
  ParsedMessage,
  GeneratedOutput,
  MessageEntity,
} from "./types.js";
import { hasFlag, getStringFlag, getPositionalArg } from "./utils/cli.js";
import { ensureDataDir, saveJson, buildTimestampedFilename } from "./utils/fs.js";

function applyEntities(text: string, entities: MessageEntity[]): string {
  if (entities.length === 0) return text;

  // Process entities from end to start so offsets stay valid
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);
  const chars = [...text]; // handle multi-byte correctly via spread

  for (const e of sorted) {
    const slice = chars.slice(e.offset, e.offset + e.length).join("");
    let replacement: string;

    switch (e.type) {
      case "bold":
        replacement = `**${slice}**`;
        break;
      case "italic":
        replacement = `_${slice}_`;
        break;
      case "underline":
        replacement = `__${slice}__`;
        break;
      case "strikethrough":
        replacement = `~~${slice}~~`;
        break;
      case "code":
        replacement = `\`${slice}\``;
        break;
      case "pre":
        replacement = e.language ? `\`\`\`${e.language}\n${slice}\n\`\`\`` : `\`\`\`\n${slice}\n\`\`\``;
        break;
      case "text_link":
        replacement = e.url ? `[${slice}](${e.url})` : slice;
        break;
      case "spoiler":
        replacement = `||${slice}||`;
        break;
      case "blockquote":
        replacement = slice.split("\n").map((l) => `> ${l}`).join("\n");
        break;
      default:
        replacement = slice;
    }

    chars.splice(e.offset, e.length, replacement);
  }

  return chars.join("");
}

function formatMessage(m: ParsedMessage): string {
  let text = applyEntities(m.text, m.entities);

  if (m.media) {
    const mediaLabel = m.media.fileName
      ? `[${m.media.type}: ${m.media.fileName}]`
      : `[${m.media.type}]`;
    text = text ? `${mediaLabel} ${text}` : mediaLabel;
  }

  if (m.forward) {
    const fwdLabel = m.forward.fromName
      ? `[forwarded from: ${m.forward.fromName}]`
      : m.forward.fromId
        ? `[forwarded from: ${m.forward.fromId}]`
        : "[forwarded]";
    text = `${fwdLabel} ${text}`;
  }

  return `[${m.senderName}] (${m.date}): ${text}`;
}

function formatMessagesContext(data: ParsedChat | ParsedChannelComments): string {
  if (data.type === "channel_comments") {
    const channelData = data as ParsedChannelComments;
    return channelData.posts
      .map((post) => {
        let postText = post.postEntities
          ? applyEntities(post.postText, post.postEntities)
          : post.postText;
        if (post.postMedia) {
          const label = post.postMedia.fileName
            ? `[${post.postMedia.type}: ${post.postMedia.fileName}]`
            : `[${post.postMedia.type}]`;
          postText = postText ? `${label} ${postText}` : label;
        }
        const commentsText = post.comments
          .map((c) => `  ${formatMessage(c)}`)
          .join("\n");
        return `Post #${post.postId}: ${postText}\nComments:\n${commentsText}`;
      })
      .join("\n\n---\n\n");
  }

  const chatData = data as ParsedChat;
  return chatData.messages.map(formatMessage).join("\n");
}

function parseArgs() {
  if (hasFlag("--help") || !getPositionalArg(0)) {
    console.log(`Usage:
  npx tsx src/generator.ts <inputJson> --prompt <promptFile> [--output <outputJson>]

Options:
  <inputJson>          Path to collected data JSON (from parser)
  --prompt <file>      Path to prompt template file (e.g., prompts/default.txt)
  --output <file>      Custom output path (default: data/<name>_generated_<timestamp>.json)`);
    process.exit(0);
  }

  const inputJson = getPositionalArg(0)!;
  const promptFile = getStringFlag("--prompt");
  if (!promptFile) {
    console.error("Error: --prompt <file> is required.");
    process.exit(1);
  }

  return {
    inputJson,
    promptFile,
    outputFile: getStringFlag("--output"),
  };
}

async function main() {
  const { inputJson, promptFile, outputFile } = parseArgs();

  // config.openaiApiKey now throws ConfigError if missing — no manual check needed

  const data: ParsedChat | ParsedChannelComments = JSON.parse(
    readFileSync(resolve(inputJson), "utf-8"),
  );

  const promptTemplate = readFileSync(resolve(promptFile), "utf-8");
  const messagesContext = formatMessagesContext(data);

  console.log(`Loaded ${inputJson} (${data.type})`);
  console.log(`Using prompt from ${promptFile}`);
  console.log(`Calling ${config.openaiModel}...`);

  const openai = new OpenAI({ apiKey: config.openaiApiKey });

  const response = await openai.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: "system", content: promptTemplate },
      {
        role: "user",
        content: `Here are the collected messages from "${data.chatTitle}" (${data.chatId}):\n\n${messagesContext}`,
      },
    ],
  });

  const generatedText = response.choices[0]?.message?.content || "";
  console.log(`\nGenerated text:\n${generatedText}\n`);

  const result: GeneratedOutput = {
    sourceFile: inputJson,
    prompt: promptTemplate,
    generatedTexts: [{ targetId: data.chatId, text: generatedText }],
    generatedAt: new Date().toISOString(),
  };

  const dataDir = ensureDataDir();
  const outPath =
    outputFile ??
    resolve(dataDir, buildTimestampedFilename(basename(inputJson, ".json"), "generated"));

  saveJson(resolve(outPath), result);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
