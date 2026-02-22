import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type AuthStep = "phone" | "code" | "password" | "done";

interface AuthState {
  client: TelegramClient;
  step: AuthStep;
  resolve: ((value: string) => void) | null;
  error: string | null;
}

let authState: AuthState | null = null;

export async function startAuth(): Promise<{ step: AuthStep }> {
  if (authState) {
    throw new Error("Auth already in progress. Complete or cancel it first.");
  }

  const client = new TelegramClient(
    new StringSession(""),
    config.tgApiId,
    config.tgApiHash,
    { connectionRetries: 5 }
  );

  authState = {
    client,
    step: "phone",
    resolve: null,
    error: null,
  };

  // Start auth in background — callbacks will wait for respondAuth()
  const authPromise = client.start({
    phoneNumber: () =>
      new Promise<string>((res) => {
        authState!.step = "phone";
        authState!.resolve = res;
      }),
    phoneCode: () =>
      new Promise<string>((res) => {
        authState!.step = "code";
        authState!.resolve = res;
      }),
    password: () =>
      new Promise<string>((res) => {
        authState!.step = "password";
        authState!.resolve = res;
      }),
    onError: (err) => {
      if (authState) authState.error = err.message;
    },
  });

  authPromise
    .then(() => {
      if (!authState) return;
      // Save session to .env
      const sessionString = authState.client.session.save() as unknown as string;
      saveSessionToEnv(sessionString);
      authState.step = "done";
      authState.resolve = null;
    })
    .catch((err) => {
      if (authState) {
        authState.error = err.message;
        authState.step = "done";
      }
    });

  // Wait a tick for the first callback to fire
  await new Promise((r) => setTimeout(r, 500));

  return { step: authState.step };
}

export function respondAuth(value: string): { step: AuthStep; error: string | null } {
  if (!authState) {
    throw new Error("No auth in progress.");
  }
  if (!authState.resolve) {
    return { step: authState.step, error: authState.error };
  }

  authState.resolve(value);
  authState.resolve = null;

  // Return current step — the next callback hasn't fired yet,
  // so caller should poll or wait for the next step
  return { step: authState.step, error: authState.error };
}

export function getAuthStep(): { step: AuthStep; error: string | null } | null {
  if (!authState) return null;
  return { step: authState.step, error: authState.error };
}

export async function cancelAuth(): Promise<void> {
  if (authState) {
    try {
      await authState.client.disconnect();
    } catch {
      // ignore
    }
    authState = null;
  }
}

function saveSessionToEnv(sessionString: string) {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    let envContent = readFileSync(envPath, "utf-8");
    if (envContent.match(/^TG_SESSION=.*$/m)) {
      envContent = envContent.replace(
        /^TG_SESSION=.*$/m,
        `TG_SESSION=${sessionString}`
      );
    } else {
      envContent += `\nTG_SESSION=${sessionString}\n`;
    }
    writeFileSync(envPath, envContent);
  } else {
    writeFileSync(envPath, `TG_SESSION=${sessionString}\n`);
  }
  // Update process.env so config picks it up
  process.env.TG_SESSION = sessionString;
}
