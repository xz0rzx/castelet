import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, basename } from "path";
import OpenAI from "openai";
import { config } from "./config.js";
import type { ParsedChat, ParsedChannelComments, GeneratedOutput } from "./types.js";

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    console.log(`Usage:
  npx tsx src/generator.ts <inputJson> --prompt <promptFile> [--output <outputJson>]

Options:
  <inputJson>          Path to collected data JSON (from parser)
  --prompt <file>      Path to prompt template file (e.g., prompts/default.txt)
  --output <file>      Custom output path (default: data/<name>_generated_<timestamp>.json)`);
    process.exit(0);
  }

  const inputJson = args[0];

  const getFlag = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return undefined;
  };

  const promptFile = getFlag("--prompt");
  if (!promptFile) {
    console.error("Error: --prompt <file> is required.");
    process.exit(1);
  }

  return {
    inputJson: inputJson!,
    promptFile,
    outputFile: getFlag("--output"),
  };
}

function formatMessagesContext(data: ParsedChat | ParsedChannelComments): string {
  if (data.type === "channel_comments") {
    const channelData = data as ParsedChannelComments;
    return channelData.posts
      .map((post) => {
        const commentsText = post.comments
          .map((c) => `  [${c.senderName}]: ${c.text}`)
          .join("\n");
        return `Post #${post.postId}: ${post.postText}\nComments:\n${commentsText}`;
      })
      .join("\n\n---\n\n");
  }

  const chatData = data as ParsedChat;
  return chatData.messages
    .map((m) => `[${m.senderName}] (${m.date}): ${m.text}`)
    .join("\n");
}

async function main() {
  const { inputJson, promptFile, outputFile } = parseArgs();

  if (!config.openaiApiKey) {
    console.error("Error: OPENAI_API_KEY is not set in .env");
    process.exit(1);
  }

  const data: ParsedChat | ParsedChannelComments = JSON.parse(
    readFileSync(resolve(inputJson), "utf-8")
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

  const dataDir = resolve(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });

  const outPath =
    outputFile ??
    resolve(
      dataDir,
      `${basename(inputJson, ".json")}_generated_${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );

  writeFileSync(resolve(outPath), JSON.stringify(result, null, 2));
  console.log(`Saved: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
