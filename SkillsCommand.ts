import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export function skillsArgs(action: "add" | "find", input: string, global = false): string[] {
  const value = input.trim();
  if (!value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("-")) {
    throw new Error("Invalid skill source or search query");
  }
  // Sources are repository/URL identifiers; query text may contain spaces and
  // quotes, which are safe as a single argv value (never interpreted by Shell).
  if (action === "add" && !/^[A-Za-z0-9@][A-Za-z0-9@._:/#?=+%~-]*$/.test(value)) {
    throw new Error("Invalid skill source");
  }
  return action === "find" ? ["skills", "find", value]
    : ["skills", "add", value, "-y", "--agent", "pi", ...(global ? ["-g"] : [])];
}

export function resolveSkillsRunner(options: {
  platform?: string; pathValue?: string; exists?: (candidate: string) => boolean;
} = {}): { cmd: string; prefix: string[] } {
  if ((options.platform || process.platform) !== "win32") return { cmd: "npx", prefix: [] };
  const exists = options.exists || fs.existsSync;
  const dirs = (options.pathValue ?? process.env.PATH ?? process.env.Path ?? "").split(";").map(d => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const node = dirs.map(d => path.win32.join(d, "node.exe")).find(exists);
  const script = dirs.map(d => path.win32.join(d, "node_modules", "npm", "bin", "npx-cli.js")).find(exists);
  if (!node || !script) throw new Error("Cannot locate Node.js and npm npx-cli.js in PATH; reinstall npm or configure PATH");
  return { cmd: node, prefix: [script] };
}

export function runSkillsCommand(action: "add" | "find", input: string,
  options: { global?: boolean; cwd?: string },
  callback: (error: Error | null, stdout: string, stderr: string) => void): void {
  try {
    const args = skillsArgs(action, input, options.global);
    const runner = resolveSkillsRunner();
    execFile(runner.cmd, [...runner.prefix, ...args], {
      cwd: options.cwd, shell: false, windowsHide: true,
      timeout: action === "add" ? 120_000 : 15_000, maxBuffer: 2 * 1024 * 1024,
    }, callback);
  } catch (error) {
    callback(error instanceof Error ? error : new Error("Skills command failed"), "", "");
  }
}
