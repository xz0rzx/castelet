import "dotenv/config";

export const config = {
  get tgApiId(): number {
    const val = process.env.TG_API_ID;
    if (!val) {
      console.error("Error: Missing required environment variable: TG_API_ID");
      console.error("Copy .env.example to .env and fill in the values.");
      process.exit(1);
    }
    return Number(val);
  },
  get tgApiHash(): string {
    const val = process.env.TG_API_HASH;
    if (!val) {
      console.error("Error: Missing required environment variable: TG_API_HASH");
      console.error("Copy .env.example to .env and fill in the values.");
      process.exit(1);
    }
    return val;
  },
  get tgSession(): string {
    return process.env.TG_SESSION || "";
  },
  get openaiApiKey(): string {
    return process.env.OPENAI_API_KEY || "";
  },
  get openaiModel(): string {
    return process.env.OPENAI_MODEL || "gpt-4o";
  },
};
