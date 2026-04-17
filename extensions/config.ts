import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execGit } from "./git.js";

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
const DEFAULT_WORKSPACE = "pi";
const DEFAULT_AI_PEER = "pi";
const DEFAULT_RECALL_MODE: RecallMode = "hybrid";
const DEFAULT_SESSION_STRATEGY: SessionStrategy = "per-repo";
const DEFAULT_REASONING_LEVEL: ReasoningLevel = "low";
const DEFAULT_WRITE_FREQUENCY: WriteFrequency = "async";
const DEFAULT_INJECTION_FREQUENCY: InjectionFrequency = "every-turn";
const DEFAULT_OBSERVATION_MODE: ObservationMode = "directional";
const DEFAULT_ENVIRONMENT: "local" | "production" = "production";
const DEFAULT_CONTEXT_TOKENS = 1200;
const DEFAULT_CONTEXT_REFRESH_TTL_SECONDS = 300;
const DEFAULT_MAX_MESSAGE_LENGTH = 25000;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_TOOL_PREVIEW_LENGTH = 500;
const DEFAULT_DIALECTIC_MAX_CHARS = 600;
const DEFAULT_DIALECTIC_MAX_INPUT_CHARS = 10000;
const ENV_FILE_NAMES = [".env", ".env.local"] as const;

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
  return DEFAULT_SESSION_STRATEGY;
};

export const normalizeRecallMode = (value: string | undefined): RecallMode => {
  if (value === "hybrid" || value === "context" || value === "tools") return value;
  if (value === "auto") return "hybrid";
  return DEFAULT_RECALL_MODE;
};

export const normalizeReasoningLevel = (value: string | undefined): ReasoningLevel => {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "max") return value;
  if (value === "mid") return "medium";
  return DEFAULT_REASONING_LEVEL;
};

const normalizeWriteFrequency = (value: string | number | undefined): WriteFrequency | number => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
    if (value === "async" || value === "turn" || value === "session") return value;
  }
  return DEFAULT_WRITE_FREQUENCY;
};

const normalizeInjectionFrequency = (value: string | undefined): InjectionFrequency => {
  if (value === "every-turn" || value === "first-turn") return value;
  return DEFAULT_INJECTION_FREQUENCY;
};

const normalizeObservationMode = (value: string | undefined): ObservationMode => {
  if (value === "directional" || value === "unified") return value;
  if (value === "shared") return "unified";
  if (value === "separate" || value === "cross") return "directional";
  return DEFAULT_OBSERVATION_MODE;
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

export const parseDotEnv = (raw: string): Record<string, string> => {
  const result: Record<string, string> = {};

  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    if (!value) {
      result[key] = "";
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }

    result[key] = value;
  }

  return result;
};

const collectEnvDirectories = (cwd: string, rootDir: string): string[] => {
  const dirs: string[] = [];
  let current = resolve(cwd);
  const stopAt = resolve(rootDir);

  while (true) {
    dirs.push(current);
    if (current === stopAt) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.reverse();
};

const findEnvRoot = async (cwd: string): Promise<string> => {
  const repoRoot = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (repoRoot?.code === 0 && repoRoot.stdout.trim()) {
    return resolve(repoRoot.stdout.trim());
  }
  return resolve(cwd);
};

export const readDotEnv = async (cwd: string = process.cwd()): Promise<Record<string, string>> => {
  const merged: Record<string, string> = {};
  const rootDir = await findEnvRoot(cwd);

  for (const dir of collectEnvDirectories(cwd, rootDir)) {
    for (const fileName of ENV_FILE_NAMES) {
      try {
        const raw = await readFile(join(dir, fileName), "utf8");
        Object.assign(merged, parseDotEnv(raw));
      } catch {
        // Ignore missing or unreadable env files.
      }
    }
  }

  return merged;
};

const inferPeerName = async (cwd: string): Promise<string> => {
  const email = await execGit(cwd, ["config", "--get", "user.email"]);
  const emailValue = email?.code === 0 ? email.stdout.trim() : "";
  if (emailValue) {
    const localPart = emailValue.split("@")[0]?.trim();
    if (localPart) return localPart;
  }

  const gitName = await execGit(cwd, ["config", "--get", "user.name"]);
  const gitNameValue = gitName?.code === 0 ? gitName.stdout.trim() : "";
  if (gitNameValue) return gitNameValue;

  return userInfo().username ?? "user";
};

export const resolveConfig = async (cwd: string = process.cwd()): Promise<HonchoConfig> => {
  const file = await readConfigFile();
  const env = { ...(await readDotEnv(cwd)), ...process.env };
  const host = file?.hosts?.pi ?? {};
  const inferredPeerName = await inferPeerName(cwd);
  const apiKey = env.HONCHO_API_KEY ?? file?.apiKey;
  const peerName = env.HONCHO_PEER_NAME ?? file?.peerName ?? inferredPeerName;
  const baseURL = env.HONCHO_URL ?? host.endpoint ?? file?.baseUrl;
  const workspace = env.HONCHO_WORKSPACE_ID ?? host.workspace ?? DEFAULT_WORKSPACE;
  const aiPeer = env.HONCHO_AI_PEER ?? host.aiPeer ?? DEFAULT_AI_PEER;
  const linkedHosts = host.linkedHosts ?? [];
  const sessionStrategy = normalizeSessionStrategy(env.HONCHO_SESSION_STRATEGY ?? host.sessionStrategy);
  const recallMode = normalizeRecallMode(env.HONCHO_RECALL_MODE ?? host.recallMode);
  const contextTokens = toPositiveInt(env.HONCHO_CONTEXT_TOKENS ?? host.contextTokens, DEFAULT_CONTEXT_TOKENS);
  const contextRefreshTtlSeconds = toPositiveInt(
    env.HONCHO_CONTEXT_REFRESH_TTL_SECONDS ?? host.contextRefreshTtlSeconds,
    DEFAULT_CONTEXT_REFRESH_TTL_SECONDS,
  );
  const maxMessageLength = toPositiveInt(
    env.HONCHO_MAX_MESSAGE_LENGTH ?? host.maxMessageLength,
    DEFAULT_MAX_MESSAGE_LENGTH,
  );
  const searchLimit = toPositiveInt(env.HONCHO_SEARCH_LIMIT ?? host.searchLimit, DEFAULT_SEARCH_LIMIT);
  const toolPreviewLength = toPositiveInt(env.HONCHO_TOOL_PREVIEW_LENGTH ?? host.toolPreviewLength, DEFAULT_TOOL_PREVIEW_LENGTH);
  const reasoningLevel = normalizeReasoningLevel(env.HONCHO_REASONING_LEVEL ?? host.reasoningLevel);
  const contextInjectionInterval = toPositiveInt(env.HONCHO_CONTEXT_INJECTION_INTERVAL ?? host.contextInjectionInterval, 1);

  // Observation: preset first, then explicit overrides
  const obsMode = normalizeObservationMode(env.HONCHO_OBSERVATION_MODE ?? host.observationMode);
  const explicitObs = {
    observeMe: host.observeMe !== undefined ? toBool(env.HONCHO_OBSERVE_ME ?? host.observeMe, true) : undefined,
    observeOthers: host.observeOthers !== undefined ? toBool(env.HONCHO_OBSERVE_OTHERS ?? host.observeOthers, true) : undefined,
    aiObserveMe: host.aiObserveMe !== undefined ? toBool(env.HONCHO_AI_OBSERVE_ME ?? host.aiObserveMe, true) : undefined,
    aiObserveOthers: host.aiObserveOthers !== undefined ? toBool(env.HONCHO_AI_OBSERVE_OTHERS ?? host.aiObserveOthers, true) : undefined,
  };
  const obs = resolveObservation(obsMode, explicitObs);

  // Phase 1 additions
  const saveMessages = toBool(env.HONCHO_SAVE_MESSAGES ?? host.saveMessages, true);
  const writeFrequency = normalizeWriteFrequency(env.HONCHO_WRITE_FREQUENCY ?? host.writeFrequency);
  const dialecticDynamic = toBool(env.HONCHO_DIALECTIC_DYNAMIC ?? host.dialecticDynamic, true);
  const dialecticMaxChars = toPositiveInt(env.HONCHO_DIALECTIC_MAX_CHARS ?? host.dialecticMaxChars, DEFAULT_DIALECTIC_MAX_CHARS);
  const dialecticMaxInputChars = toPositiveInt(env.HONCHO_DIALECTIC_MAX_INPUT_CHARS ?? host.dialecticMaxInputChars, DEFAULT_DIALECTIC_MAX_INPUT_CHARS);
  const sessionPeerPrefix = toBool(env.HONCHO_SESSION_PEER_PREFIX ?? host.sessionPeerPrefix, false);
  const injectionFrequency = normalizeInjectionFrequency(env.HONCHO_INJECTION_FREQUENCY ?? host.injectionFrequency);
  const contextCadence = toPositiveInt(env.HONCHO_CONTEXT_CADENCE ?? host.contextCadence, 1);
  const dialecticCadence = toPositiveInt(env.HONCHO_DIALECTIC_CADENCE ?? host.dialecticCadence, 1);
  const reasoningLevelCapRaw = env.HONCHO_REASONING_LEVEL_CAP ?? host.reasoningLevelCap;
  const reasoningLevelCap = reasoningLevelCapRaw ? normalizeReasoningLevel(reasoningLevelCapRaw) : null;
  const envRaw = env.HONCHO_ENVIRONMENT ?? host.environment ?? DEFAULT_ENVIRONMENT;
  const environment: "local" | "production" = envRaw === "local" ? "local" : "production";
  const logging = toBool(env.HONCHO_LOGGING ?? file?.logging, true);
  const sessions = file?.sessions ?? {};
  const contextRefreshMessageThreshold = file?.contextRefresh?.messageThreshold ?? null;

  const enabled = (env.HONCHO_ENABLED ? env.HONCHO_ENABLED === "true" : Boolean(apiKey || baseURL));

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
