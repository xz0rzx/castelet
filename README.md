# Castelet

Telegram automation tool — parse messages from chats and channels, generate AI-powered responses with OpenAI, and send them back to Telegram. Comes with a web UI for the full workflow.

## Prerequisites

- **Node.js** 18+
- **Telegram API credentials** — get `API_ID` and `API_HASH` at [my.telegram.org](https://my.telegram.org)
- **OpenAI API key** — from [platform.openai.com](https://platform.openai.com)

## Setup

```bash
git clone https://github.com/xz0rzx/castelet.git
cd castelet
npm install
cp .env.example .env
```

Fill in your `.env`:

```env
TG_API_ID=your_api_id
TG_API_HASH=your_api_hash
TG_SESSION=
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o
```

## Usage

### Web UI (recommended)

```bash
npm run ui
```

Open `http://localhost:3333`. The interface walks you through 4 steps:

1. **Setup** — check API keys, authenticate Telegram sessions
2. **Parse** — collect messages or comments from a Telegram chat/channel
3. **Generate** — create AI responses using a customizable prompt template
4. **Send** — post generated texts back to Telegram

### CLI

Each step can also be run standalone:

```bash
# Authenticate with Telegram
npm run auth

# Parse messages from a chat
npm run parse -- messages @chatname --limit 100

# Parse comments from a channel
npm run parse -- comments @channelname --posts 5 --comments-per-post 20

# Generate responses
npm run generate -- data/parsed_file.json --prompt prompts/default.txt

# Send generated texts
npm run send -- data/generated_file.json --mode comment --delay 2000
```

## Project Structure

```
src/
  auth.ts              # Telegram authentication
  client.ts            # GramJS client wrapper
  parser.ts            # Message/comment collector
  generator.ts         # OpenAI text generation
  sender.ts            # Send messages back to Telegram
  session-store.ts     # Multi-session management
  types.ts             # TypeScript type definitions
  web/
    server.ts          # HTTP server
    api.ts             # REST API endpoints
    runner.ts          # Background job runner (spawn + SSE)
    auth-handler.ts    # Interactive auth flow for web UI
web/
  index.html           # Frontend
  app.js               # UI logic
  style.css            # Styles
prompts/
  default.txt          # Default prompt template
data/                  # Parsed and generated JSON files (auto-created)
```

## License

MIT
