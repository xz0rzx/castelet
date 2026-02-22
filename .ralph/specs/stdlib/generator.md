# Generator Specification — src/generator.ts

## Purpose
CLI script that reads collected Telegram data (from parser), combines it with a prompt template, calls OpenAI GPT to generate text, and saves the result to JSON.

## CLI Interface
```bash
npx tsx src/generator.ts <inputJson> --prompt <promptFile> [--output <outputJson>]
```
- `<inputJson>` — Path to the parser output JSON file (e.g. `data/mychat_messages_2024.json`)
- `--prompt` — Path to a prompt template text file (e.g. `prompts/default.txt`)
- `--output` — Optional custom output path (default: `data/<name>_generated_<timestamp>.json`)

## Behavior
1. Read and parse the input JSON file
2. Read the prompt template file as plain text
3. Detect input type (`ParsedChat` or `ParsedChannelComments`) from the `type` field
4. Build OpenAI API request:
   - **System message**: The prompt template text
   - **User message**: The collected messages formatted as context (sender: text, one per line)
5. Call OpenAI chat completions API using the `openai` SDK
   - Model: from `OPENAI_MODEL` env var (default: `gpt-4o`)
6. Extract the generated text from the response
7. Build `GeneratedOutput` object:
   - `sourceFile`: path to the input JSON
   - `chatId`: from the input data
   - `prompt`: the prompt template text
   - `generatedTexts`: array with `{ targetId, text, commentTo? }`
   - `generatedAt`: ISO timestamp
8. Write to output JSON file
9. Print: generated text preview (first 200 chars) and output file path

## Prompt Template
Prompt files are plain text. The generator prepends the collected messages as context in the user message. Example prompt:

```
You are analyzing a Telegram group conversation. Based on the messages provided, write a thoughtful response that contributes to the discussion.
```

## Output Format
See `src/types.ts` for `GeneratedOutput` interface.

## Error Cases
- Input file not found → print error and exit
- Prompt file not found → print error and exit
- OpenAI API error → print error details and exit
- Missing OPENAI_API_KEY → tell user to set it in .env
