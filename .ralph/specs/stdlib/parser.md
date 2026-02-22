# Parser Specification — src/parser.ts

## Purpose
CLI script that connects to Telegram via GramJS user session and collects messages or comments, saving them to JSON.

## CLI Interface

### Mode A — Group/Chat Messages
```bash
npx tsx src/parser.ts messages <chatId> --limit <number>
```
- `<chatId>` — Telegram username (e.g. `my_group`), numeric ID, or invite link
- `--limit` — Number of messages to collect (default: 100)

### Mode B — Channel Post Comments
```bash
npx tsx src/parser.ts comments <channelId> --posts <number> --comments-per-post <number>
```
- `<channelId>` — Channel username or numeric ID
- `--posts` — Number of recent posts to fetch comments from (default: 10)
- `--comments-per-post` — Max comments to collect per post (default: 50)

## Behavior

### Messages Mode
1. Connect to Telegram using saved session from `src/client.ts`
2. Resolve entity from `chatId` via `client.getEntity(chatId)`
3. Iterate messages: `client.iterMessages(entity, { limit })`
4. For each message, extract: `id`, `date` (ISO string), `senderId`, `senderName`, `text`, `replyToMsgId`
5. Build `ParsedChat` object (see `src/types.ts`)
6. Write JSON to `data/<chatId>_messages_<timestamp>.json`
7. Print summary: count of messages saved, output file path

### Comments Mode
1. Connect to Telegram using saved session
2. Resolve channel entity
3. Fetch latest N posts: `client.iterMessages(entity, { limit: postsCount })`
4. For each post:
   - Fetch comments: `client.iterMessages(entity, { replyTo: post.id, limit: commentsPerPost })`
   - Build `ParsedPost` with `postId`, `postText`, and `comments[]`
5. Build `ParsedChannelComments` object
6. Write JSON to `data/<channelId>_comments_<timestamp>.json`
7. Print summary per post and total

## Output Format
See `src/types.ts` for `ParsedChat` and `ParsedChannelComments` interfaces.

## Error Cases
- Invalid/unknown chatId → print error and exit
- No messages found → write empty array, warn user
- FloodWait → sleep for required seconds, then continue
- Session not found → tell user to run `npx tsx src/auth.ts` first
