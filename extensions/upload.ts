import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { WriteFrequency } from "./config.js";
import type { HonchoHandles } from "./client.js";

// ---------------------------------------------------------------------------
// Layer 1: Credential sanitization
// ---------------------------------------------------------------------------

const REDACT_PLACEHOLDER = "<REDACTED>";
const CONTINUED_PREFIX = "[continued] ";

/** Patterns that match credential values in context (keyword + value). */
const CONTEXTUAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // key=value or key: value patterns for known credential keywords
  { re: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?key|auth[_-]?token|bearer|password|passphrase|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?([^\s'"`,;}{]{8,})['"]?/gi, label: "CREDENTIAL" },
  // export VAR="value" for known env var names
  { re: /(?:export\s+)?(?:API_KEY|SECRET_KEY|ACCESS_KEY|AUTH_TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY|CLIENT_SECRET|DATABASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY|EXA_API_KEY|HONCHO_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN)\s*=\s*['"]?([^\s'"`,;}{]{8,})['"]?/gi, label: "ENV_SECRET" },
];

/** Patterns that match standalone credential formats (no keyword context needed). */
const STANDALONE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // AWS access key IDs
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_KEY" },
  // Bearer tokens
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g, label: "BEARER_TOKEN" },
  // GitHub personal access tokens
  { re: /\bgh[ps]_[A-Za-z0-9]{36,}\b/g, label: "GITHUB_TOKEN" },
  // GitLab tokens
  { re: /\bglpat-[A-Za-z0-9\-]{20,}\b/g, label: "GITLAB_TOKEN" },
  // Honcho API keys
  { re: /\bhch-v\d+-[A-Za-z0-9]{20,}\b/g, label: "HONCHO_KEY" },
  // npm tokens
  { re: /\bnpm_[A-Za-z0-9]{36,}\b/g, label: "NPM_TOKEN" },
  // Slack tokens
  { re: /\bxox[bpors]-[A-Za-z0-9\-]{10,}\b/g, label: "SLACK_TOKEN" },
  // OpenAI API keys
  { re: /\bsk-[A-Za-z0-9\-]{20,}\b/g, label: "OPENAI_KEY" },
  // Generic long hex secrets (64+ chars, likely SHA/HMAC keys)
  { re: /\b[0-9a-f]{64,}\b/gi, label: "HEX_SECRET" },
];

export const sanitizeCredentials = (text: string): string => {
  let result = text;
  for (const { re, label } of CONTEXTUAL_PATTERNS) {
    re.lastIndex = 0;
    result = result.replace(re, (match, value) =>
      match.replace(value, `${REDACT_PLACEHOLDER}:${label}`),
    );
  }
  for (const { re, label } of STANDALONE_PATTERNS) {
    re.lastIndex = 0;
    result = result.replace(re, `${REDACT_PLACEHOLDER}:${label}`);
  }
  return result;
};

// ---------------------------------------------------------------------------
// Layer 2: Tool output filtering
// ---------------------------------------------------------------------------

/** Detect and strip content that looks like raw file dumps or command output. */
export const stripToolOutput = (text: string): string => {
  // Strip content between common tool output markers
  let result = text;
  // Remove fenced code blocks that look like file contents (```\nFILE_CONTENT\n```)
  // but keep short code blocks (likely explanations, not dumps)
  result = result.replace(/```[\w]*\n([\s\S]{500,}?)```/g, (match) => {
    // Check if it contains credential-like patterns — if so, redact the whole block
    if (/(?:password|secret|key|token|apikey)\s*[:=]/i.test(match)) {
      return "```\n[tool output redacted — contained potential credentials]\n```";
    }
    return match;
  });
  return result;
};

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

const extractText = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (entry && typeof entry === "object" && "type" in entry && "text" in entry) {
        const block = entry as { type?: string; text?: string };
        if (block.type === "text" && typeof block.text === "string") return [block.text];
      }
      return [];
    })
    .join("\n")
    .trim();
};

const findChunkBoundary = (search: string, maxLen: number): number => {
  const paragraph = search.lastIndexOf("\n\n");
  if (paragraph > 0) return paragraph + 2;

  const sentence = search.lastIndexOf(". ");
  if (sentence > 0) return sentence + 2;

  const word = search.lastIndexOf(" ");
  if (word > 0) return word + 1;

  return maxLen;
};

export const chunkTextSmart = (text: string, maxLen: number): string[] => {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const search = remaining.slice(0, maxLen);
    const cut = findChunkBoundary(search, maxLen);
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks.map((chunk, index) => index === 0 ? chunk : `${CONTINUED_PREFIX}${chunk}`);
};

interface PendingWrite {
  handles: HonchoHandles;
  payload: Array<{ role: "user" | "assistant"; text: string }>;
}

type ConversationMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;

const isConversationMessage = (message: AgentMessage): message is ConversationMessage =>
  message.role === "user" || message.role === "assistant";

const sanitizeMessageText = (message: ConversationMessage): string =>
  sanitizeCredentials(stripToolOutput(extractText(message.content)));

export class WriteScheduler {
  private pending: PendingWrite[] = [];
  private turnCount = 0;
  private asyncQueue: Promise<void> = Promise.resolve();

  constructor(private frequency: WriteFrequency | number) {}

  private async sendWithRetry(handles: HonchoHandles, payload: PendingWrite["payload"]): Promise<void> {
    const messages = payload.map((m) =>
      m.role === "user" ? handles.userPeer.message(m.text) : handles.aiPeer.message(m.text),
    );
    try {
      await handles.session!.addMessages(messages);
    } catch (firstError) {
      console.warn("[honcho-memory] upload failed, retrying in 2s:",
        firstError instanceof Error ? firstError.message : firstError);
      await new Promise((r) => setTimeout(r, 2000));
      await handles.session!.addMessages(messages);
    }
  }

  private enqueueAsync(write: PendingWrite): void {
    this.asyncQueue = this.asyncQueue
      .then(() => this.sendWithRetry(write.handles, write.payload))
      .catch((error) => {
        console.error("[honcho-memory] upload queue error:", error instanceof Error ? error.message : error);
      });
  }

  private preparePayload(handles: HonchoHandles, messages: AgentMessage[]): PendingWrite["payload"] {
    return messages
      .flatMap((message) => {
        if (!isConversationMessage(message)) return [];
        const text = sanitizeMessageText(message);
        if (text.length === 0) return [];
        return chunkTextSmart(text, handles.config.maxMessageLength).map((chunk) => ({
          role: message.role,
          text: chunk,
        }));
      });
  }

  async onTurnEnd(handles: HonchoHandles, messages: AgentMessage[]): Promise<void> {
    const payload = this.preparePayload(handles, messages);
    if (payload.length === 0) return;

    this.turnCount++;

    if (this.frequency === "async") {
      this.enqueueAsync({ handles, payload });
      return;
    }

    if (this.frequency === "turn") {
      await this.sendWithRetry(handles, payload);
      return;
    }

    // "session" or N-turn: accumulate
    this.pending.push({ handles, payload });

    if (typeof this.frequency === "number" && this.turnCount % this.frequency === 0) {
      await this.flushPending();
    }
  }

  private async flushPending(): Promise<void> {
    const batch = this.pending.splice(0);
    for (const write of batch) {
      try {
        await this.sendWithRetry(write.handles, write.payload);
      } catch (error) {
        console.error("[honcho-memory] batch flush error:", error instanceof Error ? error.message : error);
      }
    }
  }

  async flush(): Promise<void> {
    await this.flushPending();
    await this.asyncQueue;
  }

  reset(): void {
    this.pending = [];
    this.turnCount = 0;
    this.asyncQueue = Promise.resolve();
  }
}
