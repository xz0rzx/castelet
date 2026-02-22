# Agent Build Instructions — tg_parser

## Project Setup
```bash
# Install dependencies
npm install

# Copy env template and fill in your credentials
cp .env.example .env
# Edit .env with: TG_API_ID, TG_API_HASH, OPENAI_API_KEY
```

## First-Time Authentication
```bash
# Log in to Telegram (interactive — enter phone, code, optional 2FA password)
npx tsx src/auth.ts
# This saves TG_SESSION to .env automatically
```

## Running Scripts
```bash
# Parse messages from a group chat (collect 100 messages)
npx tsx src/parser.ts messages <chatId> --limit 100

# Parse comments from channel posts (10 posts, 50 comments each)
npx tsx src/parser.ts comments <channelId> --posts 10 --comments-per-post 50

# Generate text from collected data using a prompt
npx tsx src/generator.ts data/<file>.json --prompt prompts/default.txt

# Send generated text to Telegram
npx tsx src/sender.ts data/<generated>.json --mode comment
npx tsx src/sender.ts data/<generated>.json --mode latest
```

## Running Tests
```bash
npm test
```

## Tech Stack
- **Language**: TypeScript (run via tsx, no build step)
- **Telegram**: GramJS (`telegram` package) with user session (StringSession)
- **LLM**: OpenAI GPT (`openai` package, default model: gpt-4o)
- **Config**: dotenv for environment variables
- **Auth input**: `input` package for interactive CLI prompts

## Key Files
| File | Purpose |
|---|---|
| `src/types.ts` | Shared TypeScript interfaces |
| `src/config.ts` | .env loader, typed config export |
| `src/client.ts` | TelegramClient factory (connect from saved session) |
| `src/auth.ts` | One-time interactive Telegram login |
| `src/parser.ts` | Collect messages/comments → JSON |
| `src/generator.ts` | Prompt + data → OpenAI GPT → JSON |
| `src/sender.ts` | Send generated text to Telegram |
| `castelet_plan.md` | Full implementation plan with GramJS API reference |

## Key Learnings
- Update this section when you learn new build optimizations
- Document any gotchas or special setup requirements

## Feature Development Quality Standards

**CRITICAL**: All new features MUST meet the following mandatory requirements before being considered complete.

### Testing Requirements

- **Minimum Coverage**: 85% code coverage ratio required for all new code
- **Test Pass Rate**: 100% - all tests must pass, no exceptions
- **Test Types Required**:
  - Unit tests for all business logic and services
  - Integration tests for API endpoints or main functionality
  - End-to-end tests for critical user workflows
- **Coverage Validation**:
  ```bash
  npm run test:coverage
  ```

### Git Workflow Requirements

Before moving to the next feature, ALL changes must be:

1. **Committed with Clear Messages**:
   ```bash
   git add .
   git commit -m "feat(module): descriptive message following conventional commits"
   ```
   - Use conventional commit format: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, etc.
   - Include scope when applicable: `feat(parser):`, `fix(sender):`, `test(generator):`

2. **Pushed to Remote Repository** (when configured)

3. **Branch Hygiene**:
   - Work on feature branches, never directly on `main`
   - Branch naming: `feature/<name>`, `fix/<name>`, `docs/<name>`

### Feature Completion Checklist

- [ ] All tests pass
- [ ] Code coverage meets 85% minimum
- [ ] Changes committed with conventional commit messages
- [ ] .ralph/fix_plan.md task marked as complete
- [ ] Documentation updated
- [ ] .ralph/AGENT.md updated (if new patterns introduced)
