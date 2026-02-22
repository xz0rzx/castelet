# Telegram Parser/Generator/Sender — Implementation Plan

## Context

Build a collection of TypeScript scripts using GramJS (user session, not bot) that:
1. **Parse** messages from a Telegram group chat or comments under channel posts → save to JSON
2. **Generate** text from the collected data using an OpenAI GPT prompt → save to JSON
3. **Send** the generated text back to the original group/channel

---

## Project Structure

```
tg_parser/
├── src/
│   ├── config.ts            # Loads .env, exports typed config
│   ├── client.ts            # TelegramClient factory + session management
│   ├── auth.ts              # One-time login script, saves StringSession to .env
│   ├── parser.ts            # Script 1: collect messages/comments → JSON
│   ├── generator.ts         # Script 2: prompt + collected data → generated text → JSON
│   ├── sender.ts            # Script 3: send generated text to chat/channel
│   └── types.ts             # Shared TypeScript interfaces
├── data/                    # Output directory for JSON files (gitignored)
├── prompts/                 # Directory for prompt templates
│   └── default.txt          # Example prompt template
├── .env.example             # Template for required env vars
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Dependencies

- **telegram** (GramJS) — Telegram client
- **input** — CLI input for interactive auth
- **dotenv** — Environment variable loading
- **openai** — OpenAI GPT text generation
- **tsx** — Run TypeScript directly without build step
- **typescript** + **@types/node** — Dev dependencies

---

## Key GramJS APIs Used

| Operation | API |
|---|---|
| Auth / login | `new TelegramClient(StringSession, apiId, apiHash)` + `client.start(...)` |
| Save session | `client.session.save()` → store in `.env` |
| Fetch messages from group/channel | `client.iterMessages(entity, { limit })` |
| Fetch comments under a channel post | `client.iterMessages(entity, { replyTo: postMsgId })` |
| Send message to group | `client.sendMessage(entity, { message })` |
| Send comment on channel post | `client.sendMessage(entity, { message, commentTo: postMsgId })` |

---

## File-by-File Plan

### 1. `src/types.ts` — Shared interfaces

```ts
interface ParsedMessage {
  id: number;
  date: string;            // ISO timestamp
  senderId: number;
  senderName: string;
  text: string;
  replyToMsgId?: number;   // if it's a reply
}

interface ParsedChat {
  chatId: string;          // username or numeric ID used for parsing
  chatTitle: string;
  type: "group" | "channel";
  collectedAt: string;
  messages: ParsedMessage[];
}

interface ParsedPost {
  postId: number;
  postText: string;
  comments: ParsedMessage[];
}

interface ParsedChannelComments {
  chatId: string;
  chatTitle: string;
  type: "channel_comments";
  collectedAt: string;
  posts: ParsedPost[];
}

interface GeneratedOutput {
  sourceFile: string;
  chatId: string;
  prompt: string;
  generatedTexts: { targetId: string; text: string; commentTo?: number }[];
  generatedAt: string;
}
```

### 2. `src/config.ts` — Configuration

Loads from `.env`:
- `TG_API_ID` / `TG_API_HASH` — from https://my.telegram.org
- `TG_SESSION` — saved StringSession string (populated after first auth)
- `OPENAI_API_KEY` — for OpenAI GPT text generation
- `OPENAI_MODEL` — model name (default: `gpt-4o`)

### 3. `src/client.ts` — Telegram client factory

Exports `createClient()` that:
- Creates `TelegramClient` with `StringSession` from env
- Calls `client.connect()`
- Returns the connected client

### 4. `src/auth.ts` — One-time authentication script

**Run**: `npx tsx src/auth.ts`

- Creates client with empty `StringSession("")`
- Calls `client.start()` with interactive phone/password/code prompts via `input`
- Prints the session string to console and writes it to `.env` as `TG_SESSION=...`
- User runs this once, then all other scripts reuse the saved session

### 5. `src/parser.ts` — Message/comment collector (Script 1)

**Run**: `npx tsx src/parser.ts <mode> <chatId> [options]`

Two modes:

**Mode A — Group messages**: `npx tsx src/parser.ts messages <chatId> --limit 100`
- Connects client, resolves entity from `chatId` (username or invite link)
- Iterates `client.iterMessages(entity, { limit })`
- Maps each message to `ParsedMessage`
- Saves `ParsedChat` to `data/<chatId>_messages_<timestamp>.json`

**Mode B — Channel comments**: `npx tsx src/parser.ts comments <channelId> --posts 10 --comments-per-post 50`
- Connects client, resolves the channel entity
- Fetches the latest N posts via `client.iterMessages(entity, { limit: postsCount })`
- For each post, fetches comments via `client.iterMessages(entity, { replyTo: post.id, limit: commentsPerPost })`
- Saves `ParsedChannelComments` to `data/<channelId>_comments_<timestamp>.json`

### 6. `src/generator.ts` — Text generation (Script 2)

**Run**: `npx tsx src/generator.ts <inputJson> --prompt <promptFile> [--output <outputJson>]`

- Reads the collected data JSON (output from parser)
- Reads the prompt template from a text file (from `prompts/` directory)
- Interpolates collected messages into the prompt as context
- Calls OpenAI API (GPT-4o) via the `openai` SDK with the assembled prompt
- The prompt file is sent as system message; the collected messages are sent as user message context
- Saves `GeneratedOutput` to `data/<name>_generated_<timestamp>.json`

### 7. `src/sender.ts` — Message sender (Script 3)

**Run**: `npx tsx src/sender.ts <generatedJson> [--mode comment|latest]`

- Reads the generated output JSON
- Connects the Telegram client
- Two configurable modes for channels (via `--mode` flag):
  - **`comment`** (default) — Send as a comment under the specific post referenced in the data: `client.sendMessage(entity, { message: text, commentTo: postId })`
  - **`latest`** — Fetch the most recent channel post, then comment on it: fetches latest post via `client.iterMessages(entity, { limit: 1 })`, then sends with `commentTo` set to that post's ID
- For group chats → `client.sendMessage(entity, { message: text })` (no mode needed)
- Adds configurable delay between sends (default 2s) to avoid flood limits
- Logs success/failure for each send

---

## Error Handling

- All scripts wrap main logic in try/catch with descriptive error messages
- Telegram FloodWait errors: catch and sleep for the required duration, then retry
- Network errors: retry with exponential backoff (up to 3 retries)
- Missing/invalid config: fail fast with clear message about what's missing

---

## Verification

1. **Auth**: Run `npx tsx src/auth.ts`, complete phone login, verify session string is saved to `.env`
2. **Parse messages**: Run `npx tsx src/parser.ts messages <test-group> --limit 5`, check output JSON has 5 messages
3. **Parse comments**: Run `npx tsx src/parser.ts comments <test-channel> --posts 2 --comments-per-post 3`, check JSON structure
4. **Generate**: Run `npx tsx src/generator.ts data/<file>.json --prompt prompts/default.txt`, verify generated JSON
5. **Send**: Run `npx tsx src/sender.ts data/<generated>.json`, verify messages appear in Telegram
