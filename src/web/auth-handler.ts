import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { addSession } from "../session-store.js";
import { testProxyConnectivity } from "../proxy-check.js";
import {
  getTabActiveAuthFlow,
  getTabLatestAuthFlow,
  setAuthFlowError,
  setAuthFlowPhone,
  setAuthFlowStep,
  setTabWorkspaceSelectedSession,
  startTabAuthFlow,
} from "./workspace-service.js";
import type { TgSession, ProxyConfig } from "../types.js";

type AuthStep = "phone" | "code" | "password" | "done";

interface RuntimeAuthState {
  flowId: string;
  tabId: string;
  client: TelegramClient;
  step: AuthStep;
  resolve: ((value: string) => void) | null;
  error: string | null;
  sessionName: string;
  phone: string;
  proxy?: ProxyConfig;
}

const authStates = new Map<string, RuntimeAuthState>();

function getAuthState(tabId: string): RuntimeAuthState | null {
  return authStates.get(tabId) ?? null;
}

function setStep(state: RuntimeAuthState, step: AuthStep): void {
  state.step = step;
  setAuthFlowStep(state.flowId, step);
}

function setError(state: RuntimeAuthState, error: string | null): void {
  state.error = error;
  setAuthFlowError(state.flowId, error);
}

export async function startAuth(tabId: string, sessionName: string, proxy?: ProxyConfig): Promise<{ step: AuthStep }> {
  if (getAuthState(tabId)) {
    throw new Error("Auth already in progress in this tab. Complete or cancel it first.");
  }

  if (proxy) {
    await testProxyConnectivity(proxy);
  }

  const flowId = randomUUID();
  startTabAuthFlow(flowId, tabId, sessionName, proxy);

  const client = new TelegramClient(
    new StringSession(""),
    config.tgApiId,
    config.tgApiHash,
    {
      connectionRetries: 5,
      ...(proxy ? { proxy } : {}),
    }
  );

  const authState: RuntimeAuthState = {
    flowId,
    tabId,
    client,
    step: "phone",
    resolve: null,
    error: null,
    sessionName,
    phone: "",
    proxy,
  };
  authStates.set(tabId, authState);

  const authPromise = client.start({
    phoneNumber: () =>
      new Promise<string>((res) => {
        const state = getAuthState(tabId);
        if (!state) throw new Error("Auth state is missing.");
        setStep(state, "phone");
        state.resolve = res;
      }),
    phoneCode: () =>
      new Promise<string>((res) => {
        const state = getAuthState(tabId);
        if (!state) throw new Error("Auth state is missing.");
        setStep(state, "code");
        state.resolve = res;
      }),
    password: () =>
      new Promise<string>((res) => {
        const state = getAuthState(tabId);
        if (!state) throw new Error("Auth state is missing.");
        setStep(state, "password");
        state.resolve = res;
      }),
    onError: (err) => {
      const state = getAuthState(tabId);
      if (state) setError(state, err.message);
    },
  });

  authPromise
    .then(async () => {
      const state = getAuthState(tabId);
      if (!state) return;

      const sessionString = state.client.session.save() as unknown as string;

      let displayName = state.sessionName;
      try {
        const me = await state.client.getMe();
        if (me && "firstName" in me) {
          displayName = [me.firstName, me.lastName].filter(Boolean).join(" ") || displayName;
        }
      } catch {
        // ignore — use sessionName as fallback
      }

      const entry: TgSession = {
        name: state.sessionName,
        sessionString,
        phone: state.phone,
        displayName,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        ...(state.proxy ? { proxy: state.proxy } : {}),
      };
      addSession(entry);
      setTabWorkspaceSelectedSession(tabId, entry.name);
      setError(state, null);
      setStep(state, "done");
      state.resolve = null;
      authStates.delete(tabId);
      await state.client.disconnect().catch(() => {});
    })
    .catch(async (err) => {
      const state = getAuthState(tabId);
      if (!state) return;
      setError(state, err.message);
      setStep(state, "done");
      authStates.delete(tabId);
      await state.client.disconnect().catch(() => {});
    });

  await new Promise((r) => setTimeout(r, 500));
  return { step: authState.step };
}

export function respondAuth(tabId: string, value: string): { step: AuthStep; error: string | null } {
  const authState = getAuthState(tabId);
  if (!authState) {
    const flow = getTabLatestAuthFlow(tabId);
    if (!flow) {
      throw new Error("No auth in progress.");
    }
    return {
      step: flow.step === "done" || flow.step === "error" || flow.step === "cancelled" ? "done" : (flow.step as AuthStep),
      error: flow.errorMessage,
    };
  }
  if (!authState.resolve) {
    return { step: authState.step, error: authState.error };
  }

  if (authState.step === "phone") {
    authState.phone = value;
    setAuthFlowPhone(authState.flowId, value);
  }

  setError(authState, null);
  authState.resolve(value);
  authState.resolve = null;
  return { step: authState.step, error: authState.error };
}

export function getAuthStep(tabId: string): { step: AuthStep; error: string | null } | null {
  const authState = getAuthState(tabId);
  if (authState) {
    return { step: authState.step, error: authState.error };
  }
  const flow = getTabLatestAuthFlow(tabId);
  if (!flow) return null;
  const step = flow.step === "done" || flow.step === "error" || flow.step === "cancelled"
    ? "done"
    : (flow.step as AuthStep);
  return { step, error: flow.errorMessage };
}

export async function cancelAuth(tabId: string): Promise<void> {
  const authState = getAuthState(tabId);
  if (!authState) {
    const flow = getTabActiveAuthFlow(tabId);
    if (flow) {
      setAuthFlowStep(flow.id, "cancelled");
    }
    return;
  }
  try {
    await authState.client.disconnect();
  } catch {
    // ignore
  } finally {
    setAuthFlowStep(authState.flowId, "cancelled");
    authStates.delete(tabId);
  }
}
