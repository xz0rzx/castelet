# Sender Specification — src/sender.ts

## Purpose
CLI script that reads generated text from JSON and sends it to the original Telegram group chat or channel using GramJS user session.

## CLI Interface
```bash
npx tsx src/sender.ts <generatedJson> [--mode comment|latest] [--delay <ms>]
```
- `<generatedJson>` — Path to the generator output JSON file
- `--mode` — Channel send mode (default: `comment`):
  - `comment` — Send as comment under the specific post referenced in the data (`commentTo` field)
  - `latest` — Fetch the most recent channel post and comment on it
- `--delay` — Delay between sends in milliseconds (default: 2000)

## Behavior

### For Group Chats
1. Connect to Telegram using saved session
2. Read the generated JSON file
3. For each entry in `generatedTexts`:
   - Resolve entity from `targetId`
   - Send: `client.sendMessage(entity, { message: text })`
   - Wait for configured delay
4. Log success/failure for each send

### For Channel Posts (mode: comment)
1. Connect to Telegram
2. Read the generated JSON
3. For each entry with a `commentTo` field:
   - Send: `client.sendMessage(entity, { message: text, commentTo: postId })`
   - Wait for configured delay
4. Log results

### For Channel Posts (mode: latest)
1. Connect to Telegram
2. Fetch latest post: `client.iterMessages(entity, { limit: 1 })`
3. For each generated text:
   - Send: `client.sendMessage(entity, { message: text, commentTo: latestPost.id })`
   - Wait for configured delay
4. Log results

## Error Cases
- Generated JSON not found → print error and exit
- Session not found → tell user to run auth.ts first
- FloodWait → sleep for required seconds, then retry the send
- Send failure → log error, continue with next message
- No commentTo in data + mode is comment → warn and skip entry
