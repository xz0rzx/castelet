# Ralph Fix Plan — tg_parser

## High Priority
- [ ] Initialize project: package.json, tsconfig.json, .gitignore, .env.example, install deps (telegram, input, dotenv, openai, tsx, typescript, @types/node)
- [ ] Create src/types.ts with all shared interfaces (ParsedMessage, ParsedChat, ParsedPost, ParsedChannelComments, GeneratedOutput)
- [ ] Create src/config.ts to load .env and export typed config (TG_API_ID, TG_API_HASH, TG_SESSION, OPENAI_API_KEY, OPENAI_MODEL)
- [ ] Create src/client.ts — TelegramClient factory using StringSession from config
- [ ] Create src/auth.ts — Interactive one-time login script, saves session to .env

## Medium Priority
- [ ] Create src/parser.ts — Mode A: collect N messages from a group chat, save to JSON
- [ ] Create src/parser.ts — Mode B: collect comments under N posts from a channel, save to JSON
- [ ] Create src/generator.ts — Read collected JSON + prompt file, call OpenAI GPT, save generated output to JSON
- [ ] Create src/sender.ts — Read generated JSON, send messages to group chat or channel (--mode comment|latest)
- [ ] Create prompts/default.txt — Example prompt template

## Low Priority
- [ ] Add FloodWait error handling with automatic retry/sleep
- [ ] Add exponential backoff for network errors (up to 3 retries)
- [ ] Add --help flag and usage output to all CLI scripts
- [ ] Create user documentation in README.md

## Completed
- [x] Project initialization (Ralph scaffolding)
- [x] Implementation plan created (castelet_plan.md)

## Notes
- Reference castelet_plan.md for full GramJS API details and file-by-file implementation guide
- All scripts are run with `npx tsx src/<script>.ts`
- User must run auth.ts first before any other script
- Data flows: auth → parser → generator → sender
- Focus on MVP: get the pipeline working end-to-end before adding error handling polish
