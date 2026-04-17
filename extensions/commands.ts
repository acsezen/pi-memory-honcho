import { Honcho } from "@honcho-ai/sdk";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { bootstrap, clearHandles, getHandles } from "./client.js";
import { type RecallMode, normalizeRecallMode, resolveConfig, saveConfig, setRecallMode } from "./config.js";
import { clearCachedContext, refreshCachedContext, renderCachedContext } from "./context.js";
import { deriveSessionKey } from "./session.js";

const parseCsv = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const statusText = async (cwd: string): Promise<string> => {
  const config = await resolveConfig(cwd);
  const handles = getHandles();
  const cache = renderCachedContext(config.contextTokens);
  const sessionSource = handles?.sessionKey && config.sessions[cwd]
    ? "manual" : "derived";
  return [
    `Enabled: ${config.enabled ? "yes" : "no"}`,
    `Connected: ${handles ? "yes" : "no"}`,
    `Workspace: ${config.workspace}`,
    `Peer: ${config.peerName}`,
    `AI peer: ${config.aiPeer}`,
    `Linked hosts: ${config.linkedHosts.length > 0 ? config.linkedHosts.join(", ") : "none"}`,
    `Strategy: ${config.sessionStrategy}`,
    `Recall mode: ${config.recallMode}`,
    `Write frequency: ${config.writeFrequency}`,
    `Injection: ${config.injectionFrequency}`,
    `Dialectic dynamic: ${config.dialecticDynamic ? "on" : "off"}`,
    `Reasoning level: ${config.reasoningLevel}${config.reasoningLevelCap ? ` (cap: ${config.reasoningLevelCap})` : ""}`,
    `Context TTL: ${config.contextRefreshTtlSeconds}s`,
    `Max message length: ${config.maxMessageLength}`,
    `Save messages: ${config.saveMessages ? "yes" : "no"}`,
    `Session key: ${handles?.sessionKey ?? "uninitialized"} (${sessionSource})`,
    `Cache: ${cache ? `${cache.length} chars` : "empty"}`,
  ].join("\n");
};

const connect = async (ctx: ExtensionContext): Promise<void> => {
  clearHandles();
  const config = await resolveConfig(ctx.cwd);
  if (!config.enabled || !config.apiKey) throw new Error("Honcho is not configured.");
  const handles = await bootstrap(config, ctx.cwd);
  await refreshCachedContext(handles);
};

export const registerCommands = (pi: ExtensionAPI): void => {
  pi.registerCommand("honcho:status", {
    description: "Show Honcho connection and cache status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(await statusText(ctx.cwd), "info");
    }
  });

  pi.registerCommand("honcho:setup", {
    description: "Optional setup/override flow for Honcho in PI",
    handler: async (_args, ctx) => {
      const existing = await resolveConfig(ctx.cwd);
      const maskedKey = existing.apiKey ? `${existing.apiKey.slice(0, 6)}...` : "hch-...";
      const apiKeyInput = await ctx.ui.input("Honcho API key", maskedKey);
      const apiKey = apiKeyInput === maskedKey ? existing.apiKey : apiKeyInput;
      if (!apiKey) {
        ctx.ui.notify("Setup cancelled: API key is required.", "warning");
        return;
      }
      const peerName = await ctx.ui.input("Your peer name", existing.peerName);
      const workspace = await ctx.ui.input("Honcho workspace", existing.workspace);
      const aiPeer = await ctx.ui.input("AI peer name", existing.aiPeer);
      const endpoint = await ctx.ui.input("Endpoint (optional)", existing.baseURL ?? "");
      const linkedHosts = await ctx.ui.input(
        "Linked hosts (comma-separated, optional)",
        existing.linkedHosts.join(", "),
      );
      const strategyInput = await ctx.ui.input(
        "Session strategy (per-repo / per-directory / git-branch / pi-session / global)",
        existing.sessionStrategy,
      );
      await saveConfig({
        apiKey,
        peerName: peerName ?? existing.peerName,
        workspace: workspace ?? existing.workspace,
        aiPeer: aiPeer ?? existing.aiPeer,
        endpoint: endpoint || undefined,
        linkedHosts: parseCsv(linkedHosts, existing.linkedHosts),
        sessionStrategy:
          strategyInput === "per-repo"
          || strategyInput === "git-branch"
          || strategyInput === "pi-session"
          || strategyInput === "per-directory"
          || strategyInput === "global"
            ? strategyInput
            : existing.sessionStrategy,
      });
      await connect(ctx);
      ctx.ui.notify("Honcho setup saved and connection initialized.", "info");
    }
  });

  pi.registerCommand("honcho:config", {
    description: "Show the current effective Honcho config for PI",
    handler: async (_args, ctx) => {
      const config = await resolveConfig(ctx.cwd);
      const safe = { ...config, apiKey: config.apiKey ? `${config.apiKey.slice(0, 6)}...redacted` : undefined };
      ctx.ui.notify(JSON.stringify(safe, null, 2), "info");
    }
  });

  pi.registerCommand("honcho:interview", {
    description: "Kick off a short preference interview and save a durable summary",
    handler: async (_args, ctx) => {
      const handles = getHandles();
      if (!handles) {
        ctx.ui.notify("Connect Honcho first with /honcho:setup.", "warning");
        return;
      }
      const preference = await ctx.ui.input("What should PI remember about how you like to work?");
      if (!preference) {
        ctx.ui.notify("Interview cancelled.", "warning");
        return;
      }
      await handles.aiPeer.conclusionsOf(handles.userPeer).create({
        content: `User preference: ${preference}`,
        sessionId: handles.session ?? undefined,
      });
      ctx.ui.notify("Saved interview insight to Honcho.", "info");
    }
  });

  pi.registerCommand("honcho:doctor", {
    description: "Run a quick Honcho preflight for config, connectivity, and session mapping",
    handler: async (_args, ctx) => {
      const config = await resolveConfig(ctx.cwd);
      const checks: string[] = [];

      checks.push(`api_key: ${config.apiKey ? "ok" : "missing"}`);
      checks.push(`workspace: ${config.workspace}`);
      checks.push(`session_strategy: ${config.sessionStrategy}`);
      checks.push(`linked_hosts: ${config.linkedHosts.length > 0 ? config.linkedHosts.join(", ") : "none"}`);

      if (!config.enabled || !config.apiKey) {
        ctx.ui.notify([...checks, "connectivity: skipped (Honcho not configured)"].join("\n"), "warning");
        return;
      }

      try {
        const honcho = new Honcho({ apiKey: config.apiKey, baseURL: config.baseURL, workspaceId: config.workspace, environment: config.environment });
        const sessionKey = await deriveSessionKey(ctx.cwd, config.sessionStrategy, config);
        await Promise.all([
          honcho.peer(config.peerName),
          honcho.peer(config.aiPeer),
          honcho.session(sessionKey)
        ]);
        checks.push(`connectivity: ok`);
        checks.push(`session_key: ${sessionKey}`);
        ctx.ui.notify(checks.join("\n"), "info");
      } catch (error) {
        checks.push(`connectivity: failed`);
        checks.push(`error: ${error instanceof Error ? error.message : String(error)}`);
        ctx.ui.notify(checks.join("\n"), "error");
      }
    }
  });

  pi.registerCommand("honcho:mode", {
    description: "Switch recall mode (hybrid / context / tools)",
    handler: async (args, ctx) => {
      const mode = normalizeRecallMode(args?.trim());
      setRecallMode(mode);
      ctx.ui.notify(`Recall mode set to: ${mode}`, "info");
    },
  });

  pi.registerCommand("honcho:map", {
    description: "Map the current directory to a custom Honcho session name",
    handler: async (args, ctx) => {
      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("Usage: /honcho:map <session-name>", "warning");
        return;
      }
      ctx.ui.notify(`Session mapping: ${ctx.cwd} → ${name}\nNote: add to ~/.honcho/config.json sessions manually for persistence.`, "info");
    },
  });

  pi.registerCommand("honcho:sync", {
    description: "Force context refresh and flush pending uploads",
    handler: async (_args, ctx) => {
      const handles = getHandles();
      if (!handles) {
        ctx.ui.notify("Connect Honcho first with /honcho:setup.", "warning");
        return;
      }
      clearCachedContext();
      await refreshCachedContext(handles);
      ctx.ui.notify("Context refreshed.", "info");
    },
  });
};
