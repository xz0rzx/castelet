import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config.js";
import { addSession, setActiveSession } from "../session-store.js";
import type { TgSession } from "../types.js";

type AuthStep = "phone" | "code" | "password" | "done";

interface AuthState {
  client: TelegramClient;
  step: AuthStep;
  resolve: ((value: string) => void) | null;
  error: string | null;
  sessionName: string;
  phone: string;
}

let authState: AuthState | null = null;

export async function startAuth(sessionName: string): Promise<{ step: AuthStep }> {
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
    sessionName,
    phone: "",
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
    .then(async () => {
      if (!authState) return;
      const sessionString = authState.client.session.save() as unknown as string;

      // Fetch display name
      let displayName = authState.sessionName;
      try {
        const me = await authState.client.getMe();
        if (me && "firstName" in me) {
          displayName = [me.firstName, me.lastName].filter(Boolean).join(" ") || displayName;
        }
      } catch {
        // ignore — use sessionName as fallback
      }

      const entry: TgSession = {
        name: authState.sessionName,
        sessionString,
        phone: authState.phone,
        displayName,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      addSession(entry);
      setActiveSession(entry.name);

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

  // Capture phone number during phone step
  if (authState.step === "phone") {
    authState.phone = value;
  }

  authState.resolve(value);
  authState.resolve = null;

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
