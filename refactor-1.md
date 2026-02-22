# Castelet Refactoring Plan

## Context

Castelet (`tg_parser`) is a TypeScript pipeline that parses Telegram messages via GramJS, generates AI responses with OpenAI, and sends them back. The current MVP works but has significant gaps when compared to Telegram parsing best practices: messages lose all formatting entities, media is silently dropped, 64-bit IDs lose precision via `Number()` cast, FloodWait errors crash the process instead of retrying, and shared utilities are duplicated across modules. This refactoring addresses these issues in 4 incremental phases.

---

## Phase 1: Foundation — Shared Utilities & Config Hardening

### 1A. Create `src/utils/cli.ts` — shared CLI argument helpers
- Extract the `getFlag()` pattern duplicated in `parser.ts:34`, `generator.ts:23`, `sender.ts:25`
- Provide `getStringFlag()`, `getNumericFlag()` (with validation: rejects negative/non-numeric), `hasFlag()`

### 1B. Create `src/utils/fs.ts` — shared file I/O
- Extract `ensureDataDir()` and `saveJson()` from `parser.ts:71-81`
- Add `buildTimestampedFilename()` to replace the duplicated sanitize+timestamp logic at `parser.ts:113-114` and `parser.ts:176-177`
- Also replaces the `mkdirSync` call in `generator.ts:104`

### 1C. Create `src/utils/retry.ts` — retry with backoff + FloodWait
- `withRetry<T>(fn, options)` — exponential backoff with jitter
- Detects Telegram `FLOOD_WAIT` errors specifically, uses the `seconds` field as delay
- Detects transient network errors (TIMEOUT, ECONNRESET, ETIMEDOUT) as retryable
- Non-retryable errors propagate immediately
- Configurable: `maxRetries`, `baseDelayMs`, `maxDelayMs`, `onRetry` callback

### 1D. Modify `src/config.ts`
- Replace `process.exit(1)` in getters with `throw new ConfigError(...)` (makes testing possible)
- Validate `TG_API_ID` is a positive integer (currently `Number(val)` silently produces NaN for garbage)
- Make `openaiApiKey` throw when empty instead of returning `""` (removes need for manual check in `generator.ts:64`)
- Export `ConfigError` class for assertion in tests

---

## Phase 2: Type System Enrichment

### Modify `src/types.ts`

**New types:**
- `EntityType` — union of `"bold" | "italic" | "underline" | "strikethrough" | "code" | "pre" | "text_link" | "mention" | "hashtag" | "bot_command" | "url" | "email" | "spoiler" | "blockquote" | "custom_emoji"`
- `MessageEntity` — `{ type, offset, length, url?, language?, userId? }`
- `MediaType` — `"photo" | "video" | "document" | "sticker" | "poll" | "voice" | "audio" | "other"`
- `MediaInfo` — `{ type, mimeType?, fileName?, fileSize?, caption? }`
- `ForwardInfo` — `{ fromId?: string, fromName?, date?, channelPostId? }`

**Modified types:**
- `ParsedMessage.senderId`: `number` → `string` (64-bit ID safety; JSON can't serialize bigint)
- `ParsedMessage.entities`: new required field `MessageEntity[]` (empty array when no formatting)
- `ParsedMessage.media?`: new optional `MediaInfo`
- `ParsedMessage.forward?`: new optional `ForwardInfo`
- `ParsedPost.postEntities`: new `MessageEntity[]`
- `ParsedPost.postMedia?`: new optional `MediaInfo`

---

## Phase 3: Parser Enrichment

### Modify `src/parser.ts`

**Replace `toMessage()` with enriched version:**
- `extractEntities(msg)` — maps GramJS entity class names to our `EntityType` via lookup table; handles `MessageEntityTextUrl.url`, `MessageEntityPre.language`, `MessageEntityMentionName.userId`
- `extractMedia(msg)` — detects photo, video, document, sticker, poll, voice, audio from `msg.media` class type and MIME
- `extractForward(msg)` — extracts `fwdFrom` metadata (sender, date, channel post ID)
- Fix `senderId`: `msg.senderId.toString()` instead of `Number(msg.senderId)`
- Include messages with media even if `text` is empty (current filter drops media-only messages)

**Adopt shared utilities:**
- Import from `utils/cli.ts`, `utils/fs.ts`; delete local `ensureDataDir`, `saveJson`, `getFlag`

**Wrap comment fetching with retry:**
- Use `withRetry()` around `client.iterMessages(entity, { replyTo })` with `maxRetries: 2`
- On exhausted retries, warn and skip (existing behavior, but now retries first)

**Enrich `ParsedPost`:**
- Add `postEntities: extractEntities(post)` and `postMedia: extractMedia(post)`

---

## Phase 4: Generator & Sender Hardening

### 4A. Modify `src/generator.ts`

**Entity-aware formatting:**
- `applyEntities(text, entities)` — converts entities to Markdown (bold→`**`, italic→`_`, code→backtick, links→`[text](url)`, etc.) for richer LLM context
- `formatMessage(m)` — includes media annotation `[photo]`, `[video: file.mp4]` and forward annotation `[forwarded from: name]`
- Update `formatMessagesContext()` to use enriched formatters for both group and channel modes

**Adopt shared utilities:**
- Replace local `getFlag`, `mkdirSync` call with imports
- Remove manual `openaiApiKey` check (config now throws)

### 4B. Modify `src/sender.ts`

**Fix FloodWait handling:**
- Move from top-level `main().catch()` to per-send `withRetry()` wrapper
- Each failed send retries up to 3 times with FloodWait-aware delay

**Add message splitting:**
- `splitMessage(text, limit=4096)` — splits at paragraph breaks → line breaks → spaces → hard split
- Log when splitting occurs with original length and chunk count

**Fix O(n^2) index bug:**
- Replace `for-of` + `indexOf(item)` at `sender.ts:107` with a standard indexed `for` loop

**Deduplicate "fetch latest post" logic:**
- Extract `fetchLatestPostId(client, entity)` helper; called by both `"latest"` mode and the fallback in `"comment"` mode

**Fix `sourceFile` path resolution:**
- Resolve `data.sourceFile` relative to the generated JSON's directory, not CWD

**Adopt shared utilities:**
- Replace local `getFlag`, `sleep` with imports

---

## Files Summary

| File | Action | Phase |
|---|---|---|
| `src/utils/cli.ts` | NEW | 1 |
| `src/utils/fs.ts` | NEW | 1 |
| `src/utils/retry.ts` | NEW | 1 |
| `src/config.ts` | MODIFY | 1 |
| `src/types.ts` | MODIFY | 2 |
| `src/parser.ts` | MODIFY | 3 |
| `src/generator.ts` | MODIFY | 4 |
| `src/sender.ts` | MODIFY | 4 |
| `src/auth.ts` | UNCHANGED | — |
| `src/client.ts` | UNCHANGED | — |

## Verification

After each phase, confirm TypeScript compilation passes: `npx tsc --noEmit`

**End-to-end test after all phases:**
1. `npm run parse -- messages <test-group> --limit 5` → inspect JSON for entities, media, string senderId
2. `npm run parse -- messages <test-group> --limit abc` → verify numeric validation error
3. `npm run generate -- data/<output>.json --prompt prompts/default.txt` → verify markdown-enriched context in LLM prompt
4. `npm run send -- data/<generated>.json --delay 500` → verify message sending with retry logs
5. Generate a >4096 char response and verify the sender splits it into multiple messages

## Deliberately Excluded

- No media file downloading (metadata is sufficient for AI context)
- No shared client lifecycle / connection pool (each script is short-lived CLI)
- No middleware/plugin architecture (4-step pipeline doesn't warrant it)
- No cursor-based pagination (current `limit` param is sufficient for the use case)
- No test framework setup (config changes make testing *possible*; writing tests is a separate effort)
