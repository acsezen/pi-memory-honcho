import type { HonchoHandles } from "./client.js";

interface CachedContext {
  profile: string | null;
  aiProfile: string | null;
  peerCard: string[] | null;
  aiCard: string[] | null;
  summary: string | null;
  refreshedAt: number | null;
  pinned: boolean;
}

const EMPTY: CachedContext = { profile: null, aiProfile: null, peerCard: null, aiCard: null, summary: null, refreshedAt: null, pinned: false };
let cachedContext: CachedContext = EMPTY;
let messagesSinceRefresh = 0;

const normalize = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeCard = (card: unknown): string[] | null => {
  if (!Array.isArray(card)) return null;
  const items = card.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  return items.length > 0 ? items : null;
};

export const clearCachedContext = (): void => {
  cachedContext = EMPTY;
  messagesSinceRefresh = 0;
};

export const incrementMessageCount = (count: number): void => {
  messagesSinceRefresh += count;
};

export const refreshCachedContext = async (handles: HonchoHandles): Promise<void> => {
  if (!handles.session) return;
  try {
    const [userCtx, aiCtx] = await Promise.all([
      handles.session.context({
        summary: true,
        peerPerspective: handles.aiPeer,
        peerTarget: handles.userPeer,
        tokens: handles.config.contextTokens,
      }),
      handles.session.context({
        summary: false,
        peerPerspective: handles.userPeer,
        peerTarget: handles.aiPeer,
        tokens: Math.floor(handles.config.contextTokens / 3),
      }),
    ]);
    cachedContext = {
      profile: normalize(userCtx.peerRepresentation),
      aiProfile: normalize(aiCtx.peerRepresentation),
      peerCard: normalizeCard(userCtx.peerCard),
      aiCard: normalizeCard(aiCtx.peerCard),
      summary: normalize(userCtx.summary?.content),
      refreshedAt: Date.now(),
      pinned: false,
    };
    messagesSinceRefresh = 0;
  } catch (error) {
    console.error("[honcho-memory] context refresh failed:", error instanceof Error ? error.message : error);
  }
};

export const pinCachedContext = (): void => {
  if (cachedContext.refreshedAt !== null) cachedContext.pinned = true;
};

export let pendingRefresh: Promise<void> | null = null;

export const backgroundRefresh = (handles: HonchoHandles): void => {
  pendingRefresh = refreshCachedContext(handles).finally(() => { pendingRefresh = null; });
};

export const shouldRefreshCachedContext = (handles: HonchoHandles): boolean => {
  if (cachedContext.pinned) return false;
  if (cachedContext.refreshedAt === null) return true;
  const ttlExpired = (Date.now() - cachedContext.refreshedAt) / 1000 >= handles.config.contextRefreshTtlSeconds;
  const thresholdExceeded = handles.config.contextRefreshMessageThreshold !== null
    && messagesSinceRefresh >= handles.config.contextRefreshMessageThreshold;
  return ttlExpired || thresholdExceeded;
};

const truncateToBudget = (text: string, tokens: number): string => {
  const budgetChars = tokens * 4;
  return text.length > budgetChars ? text.slice(0, budgetChars) : text;
};

export const renderCachedContext = (contextTokens: number): string | null => {
  const sections = [
    cachedContext.profile ? `User profile:\n${cachedContext.profile}` : null,
    cachedContext.peerCard?.length ? `User peer card:\n${cachedContext.peerCard.join("\n")}` : null,
    cachedContext.aiProfile ? `AI peer profile:\n${cachedContext.aiProfile}` : null,
    cachedContext.aiCard?.length ? `AI peer card:\n${cachedContext.aiCard.join("\n")}` : null,
    cachedContext.summary ? `Project summary:\n${cachedContext.summary}` : null,
    cachedContext.refreshedAt ? `Context refreshed: ${new Date(cachedContext.refreshedAt).toISOString()}` : null,
  ].filter((value): value is string => Boolean(value));

  if (!sections.length) return null;
  const raw = `[Persistent memory]\n${sections.join("\n\n")}`;
  return truncateToBudget(raw, contextTokens);
};
