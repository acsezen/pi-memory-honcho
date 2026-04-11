import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bootstrap, clearHandles, ensureSession, getHandles, type HonchoHandles } from "./client.js";
import { registerCommands } from "./commands.js";
import { getRecallMode, resolveConfig, setRecallMode } from "./config.js";
import {
  backgroundRefresh,
  clearCachedContext,
  incrementMessageCount,
  pendingRefresh,
  pinCachedContext,
  refreshCachedContext,
  renderCachedContext,
  shouldRefreshCachedContext,
} from "./context.js";
import { registerTools } from "./tools.js";
import { WriteScheduler } from "./upload.js";

const setStatus = (ctx: { ui: { setStatus(id: string, text: string): void } }, state: "off" | "connected" | "syncing" | "offline") => {
  const labels: Record<typeof state, string> = {
    off: "🧠 Honcho off",
    connected: "🧠 Honcho connected",
    syncing: "🧠 Honcho syncing",
    offline: "🧠 Honcho offline",
  };
  ctx.ui.setStatus("honcho", labels[state]);
};

const MIGRATION_DIR = join(homedir(), ".honcho", "migrations");
const MAX_MIGRATE_CHARS = 4000;

const migrateMemoryFiles = async (handles: HonchoHandles, cwd: string): Promise<void> => {
  if (!handles.session) return;
  const markerPath = join(MIGRATION_DIR, createHash("sha256").update(handles.sessionKey).digest("hex").slice(0, 16));
  try {
    await access(markerPath);
    return;
  } catch { /* marker doesn't exist, proceed */ }

  const filesToMigrate = ["MEMORY.md", "USER.md", "SOUL.md"];
  const conclusions: Array<{ content: string; sessionId: typeof handles.session }> = [];

  for (const filename of filesToMigrate) {
    try {
      const content = await readFile(join(cwd, filename), "utf8");
      const trimmed = content.trim();
      if (trimmed) {
        conclusions.push({
          content: `[Migrated from ${filename}]\n${trimmed.slice(0, MAX_MIGRATE_CHARS)}`,
          sessionId: handles.session,
        });
      }
    } catch { /* file doesn't exist, skip */ }
  }

  if (conclusions.length > 0) {
    await handles.aiPeer.conclusionsOf(handles.userPeer).create(conclusions);
    await mkdir(MIGRATION_DIR, { recursive: true });
    await writeFile(markerPath, `migrated=${new Date().toISOString()}\n`, "utf8");
    if (handles.config.logging) {
      console.log(`[honcho-memory] Migrated ${conclusions.length} memory file(s) to Honcho.`);
    }
  }
};

export default function honchoMemory(pi: ExtensionAPI): void {
  let initializing: Promise<void> | null = null;
  let turnCount = 0;
  let lastContextTurn = 0;
  let scheduler: WriteScheduler | null = null;

  registerTools(pi);
  registerCommands(pi);

  const initialize = (ctx: { cwd: string; ui: { setStatus(id: string, text: string): void } }) => {
    initializing = (async () => {
      try {
        clearHandles();
        clearCachedContext();
        turnCount = 0;
        lastContextTurn = 0;
        scheduler?.reset();
        scheduler = null;

        const config = await resolveConfig();
        if (!config.enabled || !config.apiKey) {
          setStatus(ctx, "off");
          return;
        }
        setRecallMode(config.recallMode);
        scheduler = new WriteScheduler(config.writeFrequency);

        const handles = await bootstrap(config, ctx.cwd);
        pi.setSessionName(handles.sessionKey);

        if (handles.session) {
          await refreshCachedContext(handles);
          if (config.injectionFrequency === "first-turn") {
            pinCachedContext();
          }
          migrateMemoryFiles(handles, ctx.cwd).catch((error) => {
            if (config.logging) {
              console.error("[honcho-memory] migration failed:", error instanceof Error ? error.message : error);
            }
          });
        }

        setStatus(ctx, "connected");
      } catch (error) {
        console.error("[honcho-memory] initialization failed:", error instanceof Error ? error.message : error);
        setStatus(ctx, "offline");
      } finally {
        initializing = null;
      }
    })();
  };

  pi.on("session_start", async (_event, ctx) => {
    initialize(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (initializing) await initializing;
    const recallMode = getRecallMode();
    if (recallMode === "tools") return;
    const handles = getHandles();
    if (!handles || !handles.session) return;

    turnCount++;

    // Injection frequency: "first-turn" only injects on turn 1
    if (handles.config.injectionFrequency === "first-turn" && turnCount > 1) return;

    // Context cadence: respect minimum turns between context API calls
    const contextCadence = handles.config.contextCadence;
    const shouldRefresh = (turnCount - lastContextTurn) >= contextCadence
      && shouldRefreshCachedContext(handles);

    if (pendingRefresh) await pendingRefresh;

    if (shouldRefresh) {
      backgroundRefresh(handles);
      lastContextTurn = turnCount;
    }

    const memory = renderCachedContext(handles.config.contextTokens);
    if (!memory) return;
    const toolHint = recallMode === "hybrid"
      ? "\n\nUse honcho_search / honcho_context when durable context may matter. Use honcho_conclude for stable preferences, decisions, and long-lived project facts."
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n${memory}${toolHint}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    const handles = getHandles();
    if (!handles) return;
    if (!handles.config.saveMessages) return;

    // Ensure session exists for upload (lazy init case)
    try {
      await ensureSession(handles);
    } catch {
      return;
    }

    incrementMessageCount(event.messages.length);
    setStatus(ctx, "syncing");
    try {
      await scheduler?.onTurnEnd(handles, event.messages);
      setStatus(ctx, "connected");
    } catch (error) {
      if (handles.config.logging) {
        console.error("[honcho-memory] upload failed:", error instanceof Error ? error.message : error);
      }
      setStatus(ctx, "offline");
    }
  });

  const flush = async () => { await scheduler?.flush(); };

  pi.on("session_shutdown", flush);
  pi.on("session_before_switch", flush);
  pi.on("session_before_fork", flush);
  pi.on("session_before_compact", flush);
}
