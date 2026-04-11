import { createHash } from "node:crypto";
import type { HonchoConfig, SessionStrategy } from "./config.js";
import { execGit } from "./git.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8);
const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");

const repoBase = async (cwd: string): Promise<string | null> => {
  const remote = await execGit(cwd, ["remote", "get-url", "origin"]);
  if (remote?.code === 0 && remote.stdout.trim()) {
    const url = remote.stdout.trim().replace(/\.git$/, "").replace(/^(https?:\/\/)[^@]+@/, "$1");
    return sanitize(url);
  }
  const root = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root?.code === 0 && root.stdout.trim()) {
    const normalized = root.stdout.trim();
    return sanitize(`${normalized.split("/").pop() ?? "repo"}_${hash(normalized)}`);
  }
  return null;
};

const branchName = async (cwd: string): Promise<string | null> => {
  const result = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = result?.code === 0 ? result.stdout.trim() : null;
  if (name && name !== "HEAD") return sanitize(name);
  return null;
};

const directoryKey = (cwd: string): string =>
  sanitize(`dir_${cwd.split("/").pop() ?? "project"}_${hash(cwd)}`);

export const deriveSessionKey = async (cwd: string, strategy: SessionStrategy, config: HonchoConfig): Promise<string> => {
  // Priority 1: explicit mapping from config.sessions
  const manual = config.sessions[cwd];
  if (manual) {
    const key = sanitize(manual);
    return config.sessionPeerPrefix ? sanitize(`${config.peerName}_${key}`) : key;
  }

  // Priority 2: algorithmic derivation
  let key: string;
  if (strategy === "global") key = "global";
  else if (strategy === "pi-session") key = sanitize(`pi_${hash(cwd)}_${Date.now().toString(36)}`);
  else if (strategy === "per-directory") key = directoryKey(cwd);
  else if (strategy === "per-repo") key = (await repoBase(cwd)) ?? directoryKey(cwd);
  else {
    const repo = (await repoBase(cwd)) ?? directoryKey(cwd);
    const branch = await branchName(cwd);
    key = branch ? `${repo}__branch_${branch}` : repo;
  }

  return config.sessionPeerPrefix ? sanitize(`${config.peerName}_${key}`) : key;
};
