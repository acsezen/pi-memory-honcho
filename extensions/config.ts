import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export type SessionStrategy = "per-directory" | "git-branch" | "pi-session" | "per-repo" | "global";
export type RecallMode = "hybrid" | "context" | "tools";
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";
export type WriteFrequency = "async" | "turn" | "session";
export type InjectionFrequency = "every-turn" | "first-turn";
export type ObservationMode = "directional" | "unified";

export interface PiHostConfig {
  workspace: string;
  aiPeer: string;
  linkedHosts?: string[];
  endpoint?: string;
  sessionStrategy?: SessionStrategy;
  recallMode?: RecallMode;
  contextTokens?: number;
  contextRefreshTtlSeconds?: number;
  maxMessageLength?: number;
  searchLimit?: number;
  toolPreviewLength?: number;
  observeMe?: boolean;
  observeOthers?: boolean;
  aiObserveMe?: boolean;
  aiObserveOthers?: boolean;
  reasoningLevel?: ReasoningLevel;
  contextInjectionInterval?: number;
  // Phase 1 additions
  saveMessages?: boolean;
  writeFrequency?: WriteFrequency | number;
  dialecticDynamic?: boolean;
  dialecticMaxChars?: number;
  dialecticMaxInputChars?: number;
  sessionPeerPrefix?: boolean;
  observationMode?: ObservationMode;
  injectionFrequency?: InjectionFrequency;
  contextCadence?: number;
  dialecticCadence?: number;
  reasoningLevelCap?: ReasoningLevel;
  environment?: "local" | "production";
  logging?: boolean;
}

export interface HonchoConfigFile {
  apiKey?: string;
  peerName?: string;
  baseUrl?: string;
  sessions?: Record<string, string>;
  globalOverride?: boolean;
  contextRefresh?: { messageThreshold?: number };
  logging?: boolean;
  hosts?: {
    [key: string]: Partial<PiHostConfig> | undefined;
    pi?: Partial<PiHostConfig>;
  };
}

export interface HonchoConfig {
  enabled: boolean;
  apiKey?: string;
  peerName: string;
  baseURL?: string;
  workspace: string;
  aiPeer: string;
  linkedHosts: string[];
  sessionStrategy: SessionStrategy;
  recallMode: RecallMode;
  contextTokens: number;
  contextRefreshTtlSeconds: number;
  maxMessageLength: number;
  searchLimit: number;
  toolPreviewLength: number;
  observeMe: boolean;
  observeOthers: boolean;
  aiObserveMe: boolean;
  aiObserveOthers: boolean;
  reasoningLevel: ReasoningLevel;
  contextInjectionInterval: number;
  // Phase 1 additions
  saveMessages: boolean;
  writeFrequency: WriteFrequency | number;
  dialecticDynamic: boolean;
  dialecticMaxChars: number;
  dialecticMaxInputChars: number;
  sessionPeerPrefix: boolean;
  observationMode: ObservationMode;
  injectionFrequency: InjectionFrequency;
  contextCadence: number;
  dialecticCadence: number;
  reasoningLevelCap: ReasoningLevel | null;
  environment: "local" | "production";
  logging: boolean;
  sessions: Record<string, string>;
  contextRefreshMessageThreshold: number | null;
}

export const CONFIG_PATH = join(homedir(), ".honcho", "config.json");
const DEFAULT_CONTEXT_TOKENS = 1200;
const DEFAULT_CONTEXT_REFRESH_TTL_SECONDS = 300;
const DEFAULT_MAX_MESSAGE_LENGTH = 25000;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_TOOL_PREVIEW_LENGTH = 500;
const DEFAULT_DIALECTIC_MAX_CHARS = 600;
const DEFAULT_DIALECTIC_MAX_INPUT_CHARS = 10000;

const toPositiveInt = (value: string | number | undefined, fallback: number): number => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
};

const toBool = (value: string | boolean | undefined, fallback: boolean): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return fallback;
};

export const normalizeSessionStrategy = (value: string | undefined): SessionStrategy => {
  if (value === "per-directory" || value === "git-branch" || value === "pi-session" || value === "per-repo" || value === "global") return value;
  return "per-directory";
};

export const normalizeRecallMode = (value: string | undefined): RecallMode => {
  if (value === "hybrid" || value === "context" || value === "tools") return value;
  if (value === "auto") return "hybrid";
  return "hybrid";
};

export const normalizeReasoningLevel = (value: string | undefined): ReasoningLevel => {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "max") return value;
  if (value === "mid") return "medium";
  return "low";
};

const normalizeWriteFrequency = (value: string | number | undefined): WriteFrequency | number => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
    if (value === "async" || value === "turn" || value === "session") return value;
  }
  return "async";
};

const normalizeInjectionFrequency = (value: string | undefined): InjectionFrequency => {
  if (value === "every-turn" || value === "first-turn") return value;
  return "every-turn";
};

const normalizeObservationMode = (value: string | undefined): ObservationMode => {
  if (value === "directional" || value === "unified") return value;
  if (value === "shared") return "unified";
  if (value === "separate" || value === "cross") return "directional";
  return "directional";
};

export const resolveObservation = (
  mode: ObservationMode,
  explicit: { observeMe?: boolean; observeOthers?: boolean; aiObserveMe?: boolean; aiObserveOthers?: boolean },
): { observeMe: boolean; observeOthers: boolean; aiObserveMe: boolean; aiObserveOthers: boolean } => {
  const presets: Record<ObservationMode, { observeMe: boolean; observeOthers: boolean; aiObserveMe: boolean; aiObserveOthers: boolean }> = {
    directional: { observeMe: true, observeOthers: true, aiObserveMe: true, aiObserveOthers: true },
    unified: { observeMe: true, observeOthers: false, aiObserveMe: false, aiObserveOthers: true },
  };
  const base = presets[mode];
  return {
    observeMe: explicit.observeMe ?? base.observeMe,
    observeOthers: explicit.observeOthers ?? base.observeOthers,
    aiObserveMe: explicit.aiObserveMe ?? base.aiObserveMe,
    aiObserveOthers: explicit.aiObserveOthers ?? base.aiObserveOthers,
  };
};

let activeRecallMode: RecallMode = "hybrid";
export const getRecallMode = (): RecallMode => activeRecallMode;
export const setRecallMode = (mode: RecallMode): void => { activeRecallMode = mode; };

export const readConfigFile = async (): Promise<HonchoConfigFile | null> => {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as HonchoConfigFile) : null;
  } catch {
    return null;
  }
};

export const resolveConfig = async (): Promise<HonchoConfig> => {
  const file = await readConfigFile();
  const host = file?.hosts?.pi ?? {};
  const apiKey = process.env.HONCHO_API_KEY ?? file?.apiKey;
  const peerName = process.env.HONCHO_PEER_NAME ?? file?.peerName ?? userInfo().username ?? "user";
  const baseURL = process.env.HONCHO_URL ?? host.endpoint ?? file?.baseUrl;
  const workspace = process.env.HONCHO_WORKSPACE_ID ?? host.workspace ?? "pi";
  const aiPeer = process.env.HONCHO_AI_PEER ?? host.aiPeer ?? "pi";
  const linkedHosts = host.linkedHosts ?? [];
  const sessionStrategy = normalizeSessionStrategy(process.env.HONCHO_SESSION_STRATEGY ?? host.sessionStrategy);
  const recallMode = normalizeRecallMode(process.env.HONCHO_RECALL_MODE ?? host.recallMode);
  const contextTokens = toPositiveInt(process.env.HONCHO_CONTEXT_TOKENS ?? host.contextTokens, DEFAULT_CONTEXT_TOKENS);
  const contextRefreshTtlSeconds = toPositiveInt(
    process.env.HONCHO_CONTEXT_REFRESH_TTL_SECONDS ?? host.contextRefreshTtlSeconds,
    DEFAULT_CONTEXT_REFRESH_TTL_SECONDS,
  );
  const maxMessageLength = toPositiveInt(
    process.env.HONCHO_MAX_MESSAGE_LENGTH ?? host.maxMessageLength,
    DEFAULT_MAX_MESSAGE_LENGTH,
  );
  const searchLimit = toPositiveInt(process.env.HONCHO_SEARCH_LIMIT ?? host.searchLimit, DEFAULT_SEARCH_LIMIT);
  const toolPreviewLength = toPositiveInt(process.env.HONCHO_TOOL_PREVIEW_LENGTH ?? host.toolPreviewLength, DEFAULT_TOOL_PREVIEW_LENGTH);
  const reasoningLevel = normalizeReasoningLevel(process.env.HONCHO_REASONING_LEVEL ?? host.reasoningLevel);
  const contextInjectionInterval = toPositiveInt(process.env.HONCHO_CONTEXT_INJECTION_INTERVAL ?? host.contextInjectionInterval, 1);

  // Observation: preset first, then explicit overrides
  const obsMode = normalizeObservationMode(process.env.HONCHO_OBSERVATION_MODE ?? host.observationMode);
  const explicitObs = {
    observeMe: host.observeMe !== undefined ? toBool(process.env.HONCHO_OBSERVE_ME ?? host.observeMe, true) : undefined,
    observeOthers: host.observeOthers !== undefined ? toBool(process.env.HONCHO_OBSERVE_OTHERS ?? host.observeOthers, true) : undefined,
    aiObserveMe: host.aiObserveMe !== undefined ? toBool(process.env.HONCHO_AI_OBSERVE_ME ?? host.aiObserveMe, true) : undefined,
    aiObserveOthers: host.aiObserveOthers !== undefined ? toBool(process.env.HONCHO_AI_OBSERVE_OTHERS ?? host.aiObserveOthers, true) : undefined,
  };
  const obs = resolveObservation(obsMode, explicitObs);

  // Phase 1 additions
  const saveMessages = toBool(process.env.HONCHO_SAVE_MESSAGES ?? host.saveMessages, true);
  const writeFrequency = normalizeWriteFrequency(process.env.HONCHO_WRITE_FREQUENCY ?? host.writeFrequency);
  const dialecticDynamic = toBool(process.env.HONCHO_DIALECTIC_DYNAMIC ?? host.dialecticDynamic, true);
  const dialecticMaxChars = toPositiveInt(process.env.HONCHO_DIALECTIC_MAX_CHARS ?? host.dialecticMaxChars, DEFAULT_DIALECTIC_MAX_CHARS);
  const dialecticMaxInputChars = toPositiveInt(process.env.HONCHO_DIALECTIC_MAX_INPUT_CHARS ?? host.dialecticMaxInputChars, DEFAULT_DIALECTIC_MAX_INPUT_CHARS);
  const sessionPeerPrefix = toBool(process.env.HONCHO_SESSION_PEER_PREFIX ?? host.sessionPeerPrefix, false);
  const injectionFrequency = normalizeInjectionFrequency(process.env.HONCHO_INJECTION_FREQUENCY ?? host.injectionFrequency);
  const contextCadence = toPositiveInt(process.env.HONCHO_CONTEXT_CADENCE ?? host.contextCadence, 1);
  const dialecticCadence = toPositiveInt(process.env.HONCHO_DIALECTIC_CADENCE ?? host.dialecticCadence, 1);
  const reasoningLevelCapRaw = process.env.HONCHO_REASONING_LEVEL_CAP ?? host.reasoningLevelCap;
  const reasoningLevelCap = reasoningLevelCapRaw ? normalizeReasoningLevel(reasoningLevelCapRaw) : null;
  const envRaw = process.env.HONCHO_ENVIRONMENT ?? host.environment ?? "production";
  const environment: "local" | "production" = envRaw === "local" ? "local" : "production";
  const logging = toBool(process.env.HONCHO_LOGGING ?? file?.logging, true);
  const sessions = file?.sessions ?? {};
  const contextRefreshMessageThreshold = file?.contextRefresh?.messageThreshold ?? null;

  const enabled = (process.env.HONCHO_ENABLED ? process.env.HONCHO_ENABLED === "true" : Boolean(apiKey || baseURL));

  return {
    enabled,
    apiKey,
    peerName,
    baseURL,
    workspace,
    aiPeer,
    linkedHosts,
    sessionStrategy,
    recallMode,
    contextTokens,
    contextRefreshTtlSeconds,
    maxMessageLength,
    searchLimit,
    toolPreviewLength,
    ...obs,
    observationMode: obsMode,
    reasoningLevel,
    contextInjectionInterval,
    saveMessages,
    writeFrequency,
    dialecticDynamic,
    dialecticMaxChars,
    dialecticMaxInputChars,
    sessionPeerPrefix,
    injectionFrequency,
    contextCadence,
    dialecticCadence,
    reasoningLevelCap,
    environment,
    logging,
    sessions,
    contextRefreshMessageThreshold,
  };
};

export const saveConfig = async (input: {
  apiKey?: string;
  peerName?: string;
  workspace?: string;
  aiPeer?: string;
  endpoint?: string;
  linkedHosts?: string[];
  sessionStrategy?: SessionStrategy;
}): Promise<void> => {
  const current = (await readConfigFile()) ?? {};
  const next: HonchoConfigFile = { ...current };
  if (input.apiKey) next.apiKey = input.apiKey;
  if (input.peerName) next.peerName = input.peerName;

  const pi: Partial<PiHostConfig> = { ...(current.hosts?.pi ?? {}) };
  if (input.workspace) pi.workspace = input.workspace;
  if (input.aiPeer) pi.aiPeer = input.aiPeer;
  if (input.endpoint) pi.endpoint = input.endpoint;
  if (input.linkedHosts) pi.linkedHosts = input.linkedHosts;
  if (input.sessionStrategy) pi.sessionStrategy = input.sessionStrategy;
  next.hosts = { ...(current.hosts ?? {}), pi };

  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
};
