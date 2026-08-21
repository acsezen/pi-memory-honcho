import { describe, expect, it, vi } from "vitest";

const bootstrap = vi.fn();
const resolveConfig = vi.fn();

vi.mock("../extensions/client.js", () => ({
  bootstrap,
  clearHandles: vi.fn(),
  ensureSession: vi.fn(),
  getHandles: vi.fn(() => null),
}));
vi.mock("../extensions/config.js", () => ({
  getRecallMode: vi.fn(() => "tools"),
  resolveConfig,
  setRecallMode: vi.fn(),
}));
vi.mock("../extensions/context.js", () => ({
  backgroundRefresh: vi.fn(),
  clearCachedContext: vi.fn(),
  incrementMessageCount: vi.fn(),
  pendingRefresh: null,
  pinCachedContext: vi.fn(),
  refreshCachedContext: vi.fn(),
  renderCachedContext: vi.fn(() => ""),
  shouldRefreshCachedContext: vi.fn(() => false),
}));
vi.mock("../extensions/tools.js", () => ({ registerTools: vi.fn() }));
vi.mock("../extensions/commands.js", () => ({ registerCommands: vi.fn() }));
vi.mock("../extensions/upload.js", () => ({ WriteScheduler: class { reset() {} } }));


describe("Honcho initialization", () => {
  it("does not overwrite Pi's display name", async () => {
    resolveConfig.mockResolvedValue({ enabled: true, apiKey: "test-key", recallMode: "tools", writeFrequency: "turn" });
    bootstrap.mockResolvedValue({ sessionKey: "dir_project_12345678", session: null });
    const events = new Map<string, Function>();
    const pi = { on: vi.fn((event, handler) => events.set(event, handler)), setSessionName: vi.fn() };
    const { default: extension } = await import("../extensions/index.js");
    extension(pi as never);

    events.get("session_start")?.({}, { cwd: "/tmp/project", ui: { setStatus: vi.fn() } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bootstrap).toHaveBeenCalled();
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });
});
