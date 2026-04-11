import { Honcho } from "@honcho-ai/sdk";
import type { Peer, Session } from "@honcho-ai/sdk";
import type { HonchoConfig } from "./config.js";
import { readConfigFile } from "./config.js";
import { deriveSessionKey } from "./session.js";

export interface LinkedHostHandle {
  name: string;
  honcho: Honcho;
  userPeer: Peer;
  aiPeer: Peer;
}

export interface HonchoHandles {
  honcho: Honcho;
  userPeer: Peer;
  aiPeer: Peer;
  session: Session | null;
  sessionKey: string;
  config: HonchoConfig;
  linked: LinkedHostHandle[];
}

let cachedHandles: HonchoHandles | null = null;
let sessionPromise: Promise<Session> | null = null;

export const getHandles = (): HonchoHandles | null => cachedHandles;
export const clearHandles = (): void => {
  cachedHandles = null;
  sessionPromise = null;
};

const initSession = async (handles: HonchoHandles): Promise<Session> => {
  const session = await handles.honcho.session(handles.sessionKey);
  await session.addPeers([
    [handles.userPeer, { observeMe: handles.config.observeMe, observeOthers: handles.config.observeOthers }],
    [handles.aiPeer, { observeMe: handles.config.aiObserveMe, observeOthers: handles.config.aiObserveOthers }],
  ]);
  handles.session = session;
  return session;
};

export const ensureSession = async (handles: HonchoHandles): Promise<Session> => {
  if (handles.session) return handles.session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = initSession(handles).finally(() => { sessionPromise = null; });
  return sessionPromise;
};

export const bootstrap = async (config: HonchoConfig, cwd: string): Promise<HonchoHandles> => {
  const honcho = new Honcho({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    workspaceId: config.workspace,
    environment: config.environment,
  });
  const sessionKey = await deriveSessionKey(cwd, config.sessionStrategy, config);
  const [userPeer, aiPeer] = await Promise.all([
    honcho.peer(config.peerName),
    honcho.peer(config.aiPeer),
  ]);

  // Bootstrap linked host clients (read-only cross-workspace access)
  const linked: LinkedHostHandle[] = [];
  if (config.linkedHosts.length > 0) {
    const file = await readConfigFile();
    const allHosts = file?.hosts ?? {};
    const settled = await Promise.allSettled(
      config.linkedHosts.map(async (hostName): Promise<LinkedHostHandle | null> => {
        const hc = allHosts[hostName];
        if (!hc?.workspace || !hc?.aiPeer) return null;
        const h = new Honcho({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          workspaceId: hc.workspace,
          environment: config.environment,
        });
        const [up, ap] = await Promise.all([h.peer(config.peerName), h.peer(hc.aiPeer)]);
        return { name: hostName, honcho: h, userPeer: up, aiPeer: ap };
      }),
    );
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) linked.push(result.value);
      else if (result.status === "rejected" && config.logging) {
        console.error("[honcho-memory] linked host bootstrap failed:", result.reason);
      }
    }
  }

  if (config.recallMode === "tools") {
    // Lazy: defer session creation until first tool call
    cachedHandles = { honcho, userPeer, aiPeer, session: null, sessionKey, config, linked };
    return cachedHandles;
  }

  // Eager: full init
  cachedHandles = { honcho, userPeer, aiPeer, session: null, sessionKey, config, linked };
  await ensureSession(cachedHandles);
  return cachedHandles;
};
