import { describe, expect, test } from "vitest";
import { chunkTextSmart, sanitizeCredentials, stripToolOutput, WriteScheduler } from "../upload.js";
import { dynamicLevel } from "../tools.js";
import {
  normalizeSessionStrategy,
  normalizeRecallMode,
  normalizeReasoningLevel,
  resolveObservation,
} from "../config.js";
import type { HonchoHandles } from "../client.js";
import type { HonchoConfig } from "../config.js";

const reconstructChunkedText = (chunks: string[]): string =>
  chunks.map((chunk, index) => index === 0 ? chunk : chunk.replace(/^\[continued\] /, "")).join("");

// ---------------------------------------------------------------------------
// chunkTextSmart
// ---------------------------------------------------------------------------
describe("chunkTextSmart", () => {
  test("returns single chunk when text fits within maxLen", () => {
    const result = chunkTextSmart("hello world", 100);
    expect(result).toEqual(["hello world"]);
  });

  test("splits at paragraph boundary", () => {
    const text = "paragraph one.\n\nparagraph two is here.";
    // maxLen cuts somewhere in the second paragraph
    const result = chunkTextSmart(text, 20);
    expect(result[0]).toBe("paragraph one.\n\n");
    expect(result[1]).toContain("[continued]");
    expect(result[1]).toContain("paragraph two");
  });

  test("splits at sentence boundary when no paragraph break", () => {
    const text = "First sentence. Second sentence here.";
    const result = chunkTextSmart(text, 20);
    expect(result[0]).toBe("First sentence. ");
    expect(result[1]).toMatch(/^\[continued\]/);
  });

  test("splits at word boundary when no sentence break", () => {
    const text = "word1 word2 word3 word4 word5";
    const result = chunkTextSmart(text, 12);
    // Should split at a space, not mid-word
    expect(result[0]).not.toMatch(/\w$/);  // shouldn't end mid-word (ends with space)
    expect(result.length).toBeGreaterThan(1);
  });

  test("hard cuts when no boundary found", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const result = chunkTextSmart(text, 10);
    expect(result[0]).toBe("abcdefghij");
    // Subsequent chunks get [continued] prefix which adds to length,
    // so the remaining 16 chars get split further
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toMatch(/^\[continued\] /);
    }
    // All chunks together should reconstruct the original text
    expect(reconstructChunkedText(result)).toBe(text);
  });

  test("handles empty string", () => {
    expect(chunkTextSmart("", 100)).toEqual([""]);
  });

  test("handles text exactly at maxLen", () => {
    const text = "exactly10!";
    expect(chunkTextSmart(text, 10)).toEqual(["exactly10!"]);
  });

  test("prefixes continued chunks with [continued]", () => {
    const text = "a".repeat(30);
    const result = chunkTextSmart(text, 10);
    expect(result[0]).not.toContain("[continued]");
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toMatch(/^\[continued\]/);
    }
  });
});

// ---------------------------------------------------------------------------
// dynamicLevel
// ---------------------------------------------------------------------------
describe("dynamicLevel", () => {
  test("returns base level when dynamic is false", () => {
    const longQuery = "a".repeat(500);
    expect(dynamicLevel(longQuery, "low", false, null)).toBe("low");
  });

  test("no bump for short queries (<120 chars)", () => {
    const query = "short query";
    expect(dynamicLevel(query, "low", true, null)).toBe("low");
  });

  test("bumps once for medium queries (>=120, <400 chars)", () => {
    const query = "a".repeat(200);
    expect(dynamicLevel(query, "low", true, null)).toBe("medium");
  });

  test("bumps twice for long queries (>=400 chars)", () => {
    const query = "a".repeat(500);
    expect(dynamicLevel(query, "low", true, null)).toBe("high");
  });

  test("caps at max level", () => {
    const query = "a".repeat(500);
    expect(dynamicLevel(query, "high", true, null)).toBe("max");
  });

  test("applies reasoning cap", () => {
    const query = "a".repeat(500);
    // Would bump low → high, but cap is medium
    expect(dynamicLevel(query, "low", true, "medium")).toBe("medium");
  });

  test("cap has no effect when level is below cap", () => {
    const query = "short";
    expect(dynamicLevel(query, "low", true, "high")).toBe("low");
  });

  test("exactly 120 chars triggers first bump", () => {
    const query = "a".repeat(120);
    expect(dynamicLevel(query, "minimal", true, null)).toBe("low");
  });

  test("exactly 400 chars triggers second bump", () => {
    const query = "a".repeat(400);
    expect(dynamicLevel(query, "minimal", true, null)).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// normalizeSessionStrategy
// ---------------------------------------------------------------------------
describe("normalizeSessionStrategy", () => {
  test("returns valid strategies as-is", () => {
    expect(normalizeSessionStrategy("per-directory")).toBe("per-directory");
    expect(normalizeSessionStrategy("git-branch")).toBe("git-branch");
    expect(normalizeSessionStrategy("pi-session")).toBe("pi-session");
    expect(normalizeSessionStrategy("per-repo")).toBe("per-repo");
    expect(normalizeSessionStrategy("global")).toBe("global");
  });

  test("defaults to per-directory for unknown values", () => {
    expect(normalizeSessionStrategy("invalid")).toBe("per-directory");
    expect(normalizeSessionStrategy("")).toBe("per-directory");
  });

  test("defaults to per-directory for undefined", () => {
    expect(normalizeSessionStrategy(undefined)).toBe("per-directory");
  });
});

// ---------------------------------------------------------------------------
// normalizeRecallMode
// ---------------------------------------------------------------------------
describe("normalizeRecallMode", () => {
  test("returns valid modes as-is", () => {
    expect(normalizeRecallMode("hybrid")).toBe("hybrid");
    expect(normalizeRecallMode("context")).toBe("context");
    expect(normalizeRecallMode("tools")).toBe("tools");
  });

  test("maps legacy 'auto' to hybrid", () => {
    expect(normalizeRecallMode("auto")).toBe("hybrid");
  });

  test("defaults to hybrid for unknown values", () => {
    expect(normalizeRecallMode("invalid")).toBe("hybrid");
    expect(normalizeRecallMode(undefined)).toBe("hybrid");
  });
});

// ---------------------------------------------------------------------------
// normalizeReasoningLevel
// ---------------------------------------------------------------------------
describe("normalizeReasoningLevel", () => {
  test("returns valid levels as-is", () => {
    expect(normalizeReasoningLevel("minimal")).toBe("minimal");
    expect(normalizeReasoningLevel("low")).toBe("low");
    expect(normalizeReasoningLevel("medium")).toBe("medium");
    expect(normalizeReasoningLevel("high")).toBe("high");
    expect(normalizeReasoningLevel("max")).toBe("max");
  });

  test("maps legacy 'mid' to medium", () => {
    expect(normalizeReasoningLevel("mid")).toBe("medium");
  });

  test("defaults to low for unknown values", () => {
    expect(normalizeReasoningLevel("invalid")).toBe("low");
    expect(normalizeReasoningLevel(undefined)).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// resolveObservation
// ---------------------------------------------------------------------------
describe("resolveObservation", () => {
  test("directional preset: all true", () => {
    const result = resolveObservation("directional", {});
    expect(result).toEqual({
      observeMe: true,
      observeOthers: true,
      aiObserveMe: true,
      aiObserveOthers: true,
    });
  });

  test("unified preset: shared pool pattern", () => {
    const result = resolveObservation("unified", {});
    expect(result).toEqual({
      observeMe: true,
      observeOthers: false,
      aiObserveMe: false,
      aiObserveOthers: true,
    });
  });

  test("explicit overrides take precedence over preset", () => {
    const result = resolveObservation("directional", { observeOthers: false });
    expect(result.observeMe).toBe(true);         // from preset
    expect(result.observeOthers).toBe(false);     // explicit override
    expect(result.aiObserveMe).toBe(true);        // from preset
    expect(result.aiObserveOthers).toBe(true);    // from preset
  });

  test("all explicit overrides applied", () => {
    const result = resolveObservation("unified", {
      observeMe: false,
      observeOthers: true,
      aiObserveMe: true,
      aiObserveOthers: false,
    });
    expect(result).toEqual({
      observeMe: false,
      observeOthers: true,
      aiObserveMe: true,
      aiObserveOthers: false,
    });
  });
});

// ---------------------------------------------------------------------------
// chunkTextSmart — edge cases
// ---------------------------------------------------------------------------
describe("chunkTextSmart edge cases", () => {
  test("maxLen of 1 produces single-char hard cuts", () => {
    const result = chunkTextSmart("abc", 1);
    expect(result[0]).toBe("a");
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("text with only paragraph breaks splits cleanly", () => {
    const text = "a\n\nb\n\nc";
    const result = chunkTextSmart(text, 5);
    expect(result[0]).toBe("a\n\n");
    expect(result[1]).toMatch(/b\n\n/);
  });

  test("sentence boundary at position 0 is not used as cut point", () => {
    // ". " at position 0 should not be treated as a valid boundary (para > 0 check)
    const text = ". second part here and more text";
    const result = chunkTextSmart(text, 15);
    // Should still produce valid chunks
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(reconstructChunkedText(result)).toBe(text);
  });

  test("preserves all content across many chunks", () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const result = chunkTextSmart(words, 30);
    expect(reconstructChunkedText(result)).toBe(words);
  });
});

// ---------------------------------------------------------------------------
// dynamicLevel — edge cases
// ---------------------------------------------------------------------------
describe("dynamicLevel edge cases", () => {
  test("starting from max cannot bump further", () => {
    const query = "a".repeat(500);
    expect(dynamicLevel(query, "max", true, null)).toBe("max");
  });

  test("starting from minimal with 119 chars stays minimal", () => {
    const query = "a".repeat(119);
    expect(dynamicLevel(query, "minimal", true, null)).toBe("minimal");
  });

  test("cap equal to base level has no effect", () => {
    const query = "short";
    expect(dynamicLevel(query, "medium", true, "medium")).toBe("medium");
  });

  test("cap below base level clamps down", () => {
    const query = "short";
    expect(dynamicLevel(query, "high", true, "low")).toBe("low");
  });

  test("empty query stays at base", () => {
    expect(dynamicLevel("", "medium", true, null)).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// WriteScheduler
// ---------------------------------------------------------------------------

const makeHandles = (sent: Array<unknown[]>): HonchoHandles => ({
  honcho: {} as HonchoHandles["honcho"],
  userPeer: { message: (text: string) => ({ role: "user", text }) } as unknown as HonchoHandles["userPeer"],
  aiPeer: { message: (text: string) => ({ role: "assistant", text }) } as unknown as HonchoHandles["aiPeer"],
  session: {
    addMessages: async (msgs: unknown[]) => { sent.push(msgs); },
  } as unknown as HonchoHandles["session"],
  sessionKey: "test-session",
  config: { maxMessageLength: 25000, logging: false } as HonchoConfig,
  linked: [],
});

const fakeMessages = (texts: Array<{ role: "user" | "assistant"; content: string }>) =>
  texts.map((t) => ({ role: t.role, content: t.content })) as unknown as import("@mariozechner/pi-agent-core").AgentMessage[];

describe("WriteScheduler", () => {
  test("turn mode sends immediately on each turn", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    const scheduler = new WriteScheduler("turn");

    await scheduler.onTurnEnd(handles, fakeMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]));

    expect(sent.length).toBe(1);
    expect(sent[0].length).toBe(2);
  });

  test("session mode accumulates until flush", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    const scheduler = new WriteScheduler("session");

    await scheduler.onTurnEnd(handles, fakeMessages([
      { role: "user", content: "turn 1" },
    ]));
    await scheduler.onTurnEnd(handles, fakeMessages([
      { role: "user", content: "turn 2" },
    ]));

    // Nothing sent yet
    expect(sent.length).toBe(0);

    await scheduler.flush();
    // Both turns flushed
    expect(sent.length).toBe(2);
  });

  test("N-turn mode flushes every N turns", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    const scheduler = new WriteScheduler(3);

    await scheduler.onTurnEnd(handles, fakeMessages([{ role: "user", content: "t1" }]));
    await scheduler.onTurnEnd(handles, fakeMessages([{ role: "user", content: "t2" }]));
    expect(sent.length).toBe(0);

    await scheduler.onTurnEnd(handles, fakeMessages([{ role: "user", content: "t3" }]));
    // Flushed after 3rd turn
    expect(sent.length).toBe(3);
  });

  test("async mode enqueues without blocking onTurnEnd", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    const scheduler = new WriteScheduler("async");

    await scheduler.onTurnEnd(handles, fakeMessages([
      { role: "user", content: "async msg" },
    ]));

    // Async: may not be sent yet, but flush drains it
    await scheduler.flush();
    expect(sent.length).toBe(1);
  });

  test("skips messages with empty content", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    const scheduler = new WriteScheduler("turn");

    await scheduler.onTurnEnd(handles, fakeMessages([
      { role: "user", content: "" },
      { role: "assistant", content: "   " },
    ]));

    // Both empty after trim, nothing sent
    expect(sent.length).toBe(0);
  });

  test("filters out non-user/assistant roles", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    const scheduler = new WriteScheduler("turn");

    const messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ] as unknown as import("@mariozechner/pi-agent-core").AgentMessage[];

    await scheduler.onTurnEnd(handles, messages);
    expect(sent.length).toBe(1);
    expect(sent[0].length).toBe(1); // only user message
  });

  test("reset clears pending and turn count", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    const scheduler = new WriteScheduler("session");

    await scheduler.onTurnEnd(handles, fakeMessages([{ role: "user", content: "msg" }]));
    scheduler.reset();
    await scheduler.flush();

    // Nothing sent — reset cleared pending
    expect(sent.length).toBe(0);
  });

  test("chunks long messages according to maxMessageLength", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    // Use a small maxMessageLength to force chunking
    (handles.config as { maxMessageLength: number }).maxMessageLength = 20;
    const scheduler = new WriteScheduler("turn");

    await scheduler.onTurnEnd(handles, fakeMessages([
      { role: "user", content: "This is a longer message that exceeds the limit" },
    ]));

    expect(sent.length).toBe(1);
    // Should have been chunked into multiple message objects
    expect(sent[0].length).toBeGreaterThan(1);
  });

  test("handles array content blocks", async () => {
    const sent: Array<unknown[]> = [];
    const handles = makeHandles(sent);
    const scheduler = new WriteScheduler("turn");

    const messages = [{
      role: "assistant",
      content: [
        { type: "text", text: "first block" },
        { type: "text", text: "second block" },
      ],
    }] as unknown as import("@mariozechner/pi-agent-core").AgentMessage[];

    await scheduler.onTurnEnd(handles, messages);
    expect(sent.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sanitizeCredentials (Layer 1)
// ---------------------------------------------------------------------------
describe("sanitizeCredentials", () => {
  test("redacts API key in key=value format", () => {
    const input = 'export API_KEY="sk-abc123def456ghi789"';
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("sk-abc123def456ghi789");
    expect(result).toContain("<REDACTED>");
  });

  test("redacts OpenAI-style keys (sk- prefix)", () => {
    // sk- pattern needs 20+ chars after prefix
    const input = "My key is sk-proj-abcdefghij1234567890abcdefghij";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("sk-proj-abcdefghij1234567890abcdefghij");
    expect(result).toContain("<REDACTED>:OPENAI_KEY");
  });

  test("redacts AWS access key IDs", () => {
    const input = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("<REDACTED>:AWS_KEY");
  });

  test("redacts GitHub personal access tokens", () => {
    const input = "token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
    expect(result).toContain("<REDACTED>:GITHUB_TOKEN");
  });

  test("redacts GitLab tokens", () => {
    const input = "GITLAB_TOKEN=glpat-abcdefghijklmnopqrst";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("glpat-abcdefghijklmnopqrst");
  });

  test("redacts Honcho API keys (standalone)", () => {
    // Without a keyword prefix, standalone pattern matches
    const input = "Use this key: hch-v3-abcdefghijklmnopqrstuvwx";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("hch-v3-abcdefghijklmnopqrstuvwx");
    expect(result).toContain("<REDACTED>:HONCHO_KEY");
  });

  test("redacts Honcho API keys (with keyword)", () => {
    // Contextual pattern matches first when keyword present
    const input = "apiKey: hch-v3-abcdefghijklmnopqrstuvwx";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("hch-v3-abcdefghijklmnopqrstuvwx");
    expect(result).toContain("<REDACTED>");
  });

  test("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("<REDACTED>:BEARER_TOKEN");
  });

  test("redacts password= patterns", () => {
    const input = 'password: "mySuperSecret123!"';
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("mySuperSecret123!");
    expect(result).toContain("<REDACTED>:CREDENTIAL");
  });

  test("redacts multiple credentials in same text", () => {
    const input = 'API_KEY=sk-abc123 and PASSWORD=hunter2andmore';
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("sk-abc123");
    expect(result).not.toContain("hunter2andmore");
  });

  test("preserves normal text without credentials", () => {
    const input = "The user prefers dark mode and uses TypeScript for all projects.";
    expect(sanitizeCredentials(input)).toBe(input);
  });

  test("preserves short values that are not credentials", () => {
    const input = "key: abc";
    // "abc" is only 3 chars, below the 8-char threshold
    expect(sanitizeCredentials(input)).toBe(input);
  });

  test("redacts npm tokens (standalone)", () => {
    const input = "token is npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab right here";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab");
    expect(result).toContain("<REDACTED>:NPM_TOKEN");
  });

  test("redacts npm tokens (with keyword prefix)", () => {
    // _authToken= triggers contextual pattern first
    const input = "//registry.npmjs.org/:_authToken=npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab");
    expect(result).toContain("<REDACTED>");
  });

  test("redacts Slack tokens", () => {
    const input = "SLACK_TOKEN=xoxb-1234567890-abcdefghij";
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("xoxb-1234567890-abcdefghij");
    expect(result).toContain("<REDACTED>:SLACK_TOKEN");
  });

  test("redacts env var exports with known names", () => {
    const input = 'export OPENAI_API_KEY="sk-longkeyvalue1234567890"';
    const result = sanitizeCredentials(input);
    expect(result).not.toContain("sk-longkeyvalue1234567890");
  });
});

// ---------------------------------------------------------------------------
// stripToolOutput (Layer 2)
// ---------------------------------------------------------------------------
describe("stripToolOutput", () => {
  test("strips large code blocks containing credential keywords", () => {
    const longContent = "x".repeat(500);
    const input = `Here is the file:\n\`\`\`\npassword: ${longContent}\n\`\`\``;
    const result = stripToolOutput(input);
    expect(result).toContain("[tool output redacted");
    expect(result).not.toContain(longContent);
  });

  test("preserves short code blocks", () => {
    const input = "```\nconst x = 1;\n```";
    expect(stripToolOutput(input)).toBe(input);
  });

  test("preserves large code blocks without credential keywords", () => {
    const longContent = "line\n".repeat(200);
    const input = `\`\`\`\n${longContent}\`\`\``;
    expect(stripToolOutput(input)).toBe(input);
  });

  test("preserves normal text", () => {
    const input = "The function works by iterating over the array.";
    expect(stripToolOutput(input)).toBe(input);
  });
});
