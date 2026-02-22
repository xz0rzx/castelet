import "dotenv/config";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const config = {
  get tgApiId(): number {
    const val = process.env.TG_API_ID;
    if (!val) {
      throw new ConfigError(
        "Missing required environment variable: TG_API_ID. Copy .env.example to .env and fill in the values.",
      );
    }
    const num = Number(val);
    if (!Number.isInteger(num) || num <= 0) {
      throw new ConfigError(
        `TG_API_ID must be a positive integer, got "${val}".`,
      );
    }
    return num;
  },
  get tgApiHash(): string {
    const val = process.env.TG_API_HASH;
    if (!val) {
      throw new ConfigError(
        "Missing required environment variable: TG_API_HASH. Copy .env.example to .env and fill in the values.",
      );
    }
    return val;
  },
  get tgSession(): string {
    return process.env.TG_SESSION || "";
  },
  get openaiApiKey(): string {
    const val = process.env.OPENAI_API_KEY;
    if (!val) {
      throw new ConfigError(
        "Missing required environment variable: OPENAI_API_KEY.",
      );
    }
    return val;
  },
  get openaiModel(): string {
    return process.env.OPENAI_MODEL || "gpt-4o";
  },
};
