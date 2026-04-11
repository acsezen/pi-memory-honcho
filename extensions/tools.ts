import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ensureSession, getHandles } from "./client.js";
import { type ReasoningLevel, getRecallMode } from "./config.js";

const REASONING_LEVELS: readonly ReasoningLevel[] = ["minimal", "low", "medium", "high", "max"];

const bumpLevel = (level: ReasoningLevel, steps: number): ReasoningLevel => {
  const idx = REASONING_LEVELS.indexOf(level);
  const target = Math.min(idx + steps, REASONING_LEVELS.length - 1);
  return REASONING_LEVELS[Math.max(0, target)];
};

const nextLevel = (level: string): ReasoningLevel | null => {
  const idx = REASONING_LEVELS.indexOf(level as ReasoningLevel);
  return idx >= 0 && idx < REASONING_LEVELS.length - 1 ? REASONING_LEVELS[idx + 1] : null;
};

export const dynamicLevel = (
  query: string,
  baseLevel: ReasoningLevel,
  dynamic: boolean,
  cap: ReasoningLevel | null,
): ReasoningLevel => {
  if (!dynamic) return baseLevel;
  const len = query.length;
  let level = baseLevel;
  if (len >= 120) level = bumpLevel(level, 1);
  if (len >= 400) level = bumpLevel(level, 1);
  if (cap) {
    const capIdx = REASONING_LEVELS.indexOf(cap);
    const levelIdx = REASONING_LEVELS.indexOf(level);
    if (levelIdx > capIdx) level = cap;
  }
  return level;
};

const ensureHandles = async () => {
  if (getRecallMode() === "context") throw new Error("Memory tools are disabled in context-only recall mode.");
  const handles = getHandles();
  if (!handles) throw new Error("Honcho is not connected. Run /honcho:setup first.");
  await ensureSession(handles);
  return handles;
};

const formatSearch = (results: Array<{ sourceHost?: string; peerId?: string; content: string }>, preview: number): string => {
  if (results.length === 0) return "No relevant memory found.";
  return results
    .map((entry, index) => `${index + 1}. [${entry.sourceHost || "pi"} | ${entry.peerId || "unknown"}] ${entry.content.slice(0, preview)}`)
    .join("\n\n");
};

const SEARCH_MAX_TOKENS = 2000;

export const registerTools = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "honcho_profile",
    label: "Honcho Profile",
    description: "Retrieve what Honcho currently knows about the user profile from this and linked workspaces.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const handles = await ensureHandles();
      const context = await handles.session!.context({
        summary: false,
        peerPerspective: handles.aiPeer,
        peerTarget: handles.userPeer,
        tokens: handles.config.contextTokens,
      });
      let result = `=== [pi] ===\n${context.peerRepresentation?.trim() || "No profile memory available yet."}`;

      for (const lh of handles.linked) {
        try {
          const rep = await lh.aiPeer.representation({ target: lh.userPeer });
          if (rep?.trim()) {
            result += `\n\n=== [${lh.name}] ===\n${rep.trim()}`;
          }
        } catch (err) {
          if (handles.config.logging) {
            console.error(`[honcho-memory] ${lh.name} profile read failed:`, err instanceof Error ? err.message : err);
          }
        }
      }

      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "honcho_search",
    label: "Honcho Search",
    description: "Search durable memory for prior conversations, facts, and decisions across all linked workspaces.",
    parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const handles = await ensureHandles();
      const limit = Math.min(handles.config.searchLimit, SEARCH_MAX_TOKENS);
      const results: Array<{ sourceHost?: string; peerId?: string; content: string }> = [];

      try {
        const mainResults = await handles.session!.search(params.query, { limit });
        results.push(...mainResults.map((r: any) => ({ ...r, sourceHost: "pi" })));
      } catch (err) {
        if (handles.config.logging) {
          console.error("[honcho-memory] primary search failed:", err instanceof Error ? err.message : err);
        }
      }

      for (const lh of handles.linked) {
        try {
          const hostResults = await lh.honcho.search(params.query, { limit });
          results.push(...hostResults.map((r: any) => ({ ...r, sourceHost: lh.name })));
        } catch (err) {
          if (handles.config.logging) {
            console.error(`[honcho-memory] ${lh.name} search failed:`, err instanceof Error ? err.message : err);
          }
        }
      }

      return {
        content: [{ type: "text", text: formatSearch(results, handles.config.toolPreviewLength) }],
        details: { count: results.length },
      };
    },
  });

  pi.registerTool({
    name: "honcho_context",
    label: "Honcho Context",
    description: "Ask Honcho to synthesize memory context for the current question across all linked workspaces.",
    parameters: Type.Object({
      query: Type.String({ description: "Question to ask about long-term memory" }),
      reasoningLevel: Type.Optional(StringEnum(["minimal", "low", "medium", "high", "max"] as const)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const handles = await ensureHandles();
      const truncatedQuery = params.query.slice(0, handles.config.dialecticMaxInputChars);
      const level = params.reasoningLevel
        ?? dynamicLevel(truncatedQuery, handles.config.reasoningLevel, handles.config.dialecticDynamic, handles.config.reasoningLevelCap);

      let reply = await handles.aiPeer.chat(truncatedQuery, {
        target: handles.userPeer,
        session: handles.session!,
        reasoningLevel: level,
      });
      if (!reply?.trim()) {
        const bumped = nextLevel(level);
        if (bumped) {
          reply = await handles.aiPeer.chat(truncatedQuery, {
            target: handles.userPeer,
            session: handles.session!,
            reasoningLevel: bumped,
          });
        }
      }
      let result = `=== [pi] ===\n${reply?.slice(0, handles.config.dialecticMaxChars) ?? "No additional context available."}`;

      for (const lh of handles.linked) {
        try {
          let hostReply = await lh.aiPeer.chat(truncatedQuery, {
            target: lh.userPeer,
            reasoningLevel: level,
          });
          if (!hostReply?.trim()) {
            const bumped = nextLevel(level);
            if (bumped) {
              hostReply = await lh.aiPeer.chat(truncatedQuery, {
                target: lh.userPeer,
                reasoningLevel: bumped,
              });
            }
          }
          if (hostReply?.trim()) {
            result += `\n\n=== [${lh.name}] ===\n${hostReply.slice(0, handles.config.dialecticMaxChars)}`;
          }
        } catch (err) {
          if (handles.config.logging) {
            console.error(`[honcho-memory] ${lh.name} context failed:`, err instanceof Error ? err.message : err);
          }
        }
      }

      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "honcho_conclude",
    label: "Honcho Conclude",
    description: "Store a durable preference, fact, or decision in Honcho.",
    parameters: Type.Object({ content: Type.String({ description: "Durable memory to store" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const handles = await ensureHandles();
      await handles.aiPeer.conclusionsOf(handles.userPeer).create({
        content: params.content,
        sessionId: handles.session!,
      });
      return {
        content: [{ type: "text", text: `Saved durable memory: ${params.content}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "honcho_seed_identity",
    label: "Honcho Seed Identity",
    description: "Seed the AI peer's identity representation in Honcho.",
    parameters: Type.Object({ content: Type.String({ description: "AI identity description" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const handles = await ensureHandles();
      const tagged = `<ai_identity_seed source="manual">\n${params.content}\n</ai_identity_seed>`;
      await handles.session!.addMessages([handles.aiPeer.message(tagged)]);
      return {
        content: [{ type: "text", text: "AI identity seeded." }],
        details: {},
      };
    },
  });
};
