# Auth & Config Specification

## src/auth.ts — One-Time Authentication

### Purpose
Interactive script to log in to Telegram and save the session string for reuse by all other scripts.

### CLI Interface
```bash
npx tsx src/auth.ts
```

### Behavior
1. Load `TG_API_ID` and `TG_API_HASH` from `.env`
2. Create `TelegramClient` with empty `StringSession("")`
3. Call `client.start()` with interactive prompts:
   - Phone number (via `input` package)
   - Auth code (via `input` package)
   - 2FA password if enabled (via `input` package)
4. On success:
   - Print `client.session.save()` to console
   - Read existing `.env`, append or update `TG_SESSION=<session_string>`
   - Print confirmation message
5. Disconnect client

### Error Cases
- Missing TG_API_ID or TG_API_HASH → print setup instructions and exit
- Auth failure → print Telegram error and exit

---

## src/config.ts — Configuration

### Purpose
Central configuration loader. All other modules import config from here.

### Exports
```ts
export const config: {
  TG_API_ID: number;
  TG_API_HASH: string;
  TG_SESSION: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;  // default: "gpt-4o"
}
```

### Behavior
- Calls `dotenv.config()` on import
- Reads from `process.env`
- Validates required fields, throws descriptive error if missing

---

## src/client.ts — Telegram Client Factory

### Purpose
Creates and connects a TelegramClient instance using the saved session.

### Exports
```ts
export async function createClient(): Promise<TelegramClient>
```

### Behavior
1. Import config
2. Create `new TelegramClient(new StringSession(config.TG_SESSION), config.TG_API_ID, config.TG_API_HASH, { connectionRetries: 5 })`
3. Call `await client.connect()`
4. Return client

---

## src/types.ts — Shared Interfaces

### Exports all interfaces used across scripts:
- `ParsedMessage` — Single message (id, date, senderId, senderName, text, replyToMsgId?)
- `ParsedChat` — Group chat collection (chatId, chatTitle, type, collectedAt, messages[])
- `ParsedPost` — Single channel post with comments (postId, postText, comments[])
- `ParsedChannelComments` — Channel comments collection (chatId, chatTitle, type, collectedAt, posts[])
- `GeneratedOutput` — Generator output (sourceFile, chatId, prompt, generatedTexts[], generatedAt)

---

## .env.example
```
TG_API_ID=
TG_API_HASH=
TG_SESSION=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
```
