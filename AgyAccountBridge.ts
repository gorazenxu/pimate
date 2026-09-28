import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * AGY's documented status-line payload includes the authenticated account's
 * email. Print mode and `agy models` do not expose it. This bridge is installed
 * only when the user clicks the account-display action in Pimate settings.
 * It never reads AGY's OAuth token or the system keyring.
 */
const NODE_BRIDGE_SCRIPT = `"use strict";
const fs = require("fs");
const path = require("path");
const output = path.join(__dirname, "pimate-account-status.json");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  if (input.length > 512 * 1024) process.exit(0);
});
process.stdin.on("end", () => {
  try {
    const email = JSON.parse(input)?.email;
    if (typeof email !== "string" || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || email.length > 320) {
      try { fs.unlinkSync(output); } catch { /* no previous account */ }
      return;
    }
    let previous;
    try { previous = JSON.parse(fs.readFileSync(output, "utf8")); } catch { /* first capture */ }
    if (previous?.email === email && Date.now() - previous.capturedAt < 60_000) return;
    const temporary = output + ".tmp-" + process.pid;
    fs.writeFileSync(temporary, JSON.stringify({ email, capturedAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(temporary, output);
  } catch { /* Status-line rendering must never fail because of Pimate. */ }
});
`;

/**
 * POSIX status-line bridge. AGY pipes its state JSON to the configured command,
 * so macOS/Linux can capture the email with system tools without depending on
 * Node being present in Obsidian's GUI-launched PATH.
 */
const POSIX_BRIDGE_SCRIPT = `#!/bin/sh
set -eu
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
output="$script_dir/pimate-account-status.json"
email=$(awk '
  match($0, /"email"[[:space:]]*:[[:space:]]*"[^"]*"/) {
    value = substr($0, RSTART, RLENGTH)
    sub(/^"email"[[:space:]]*:[[:space:]]*"/, "", value)
    sub(/"$/, "", value)
    if (length(value) <= 320 && value ~ /^[^[:space:]@"]+@[^[:space:]@"]+\\.[^[:space:]@"]+$/) print value
    exit
  }
')

if [ -z "$email" ]; then
  rm -f "$output"
  exit 0
fi

now_seconds=$(date +%s)
case "$now_seconds" in
  ''|*[!0-9]*) exit 0 ;;
esac
now_ms=$((now_seconds * 1000))

if [ -r "$output" ]; then
  previous_email=$(awk -F'"' '/"email"/ { print $4; exit }' "$output" 2>/dev/null || true)
  previous_at=$(sed -n 's/.*"capturedAt":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$output" 2>/dev/null || true)
  case "$previous_at" in
    ''|*[!0-9]*) previous_at=0 ;;
  esac
  if [ "$previous_email" = "$email" ] && [ "$previous_at" -gt 0 ] && [ "$((now_ms - previous_at))" -lt 60000 ]; then
    exit 0
  fi
fi

umask 077
temporary="$output.tmp-$$"
trap 'rm -f "$temporary"' 0 HUP INT TERM
printf '{"email":"%s","capturedAt":%s}\\n' "$email" "$now_ms" > "$temporary"
mv -f "$temporary" "$output"
`;

export interface AgyAccountBridgeStatus {
  enabled: boolean;
  email?: string;
  capturedAt?: number;
  customStatusLine: boolean;
}

function agyDirectory(baseDir?: string): string {
  return baseDir || path.join(os.homedir(), ".gemini", "antigravity-cli");
}

function bridgePaths(baseDir?: string) {
  const dir = agyDirectory(baseDir);
  const cacheDir = path.join(dir, "cache");
  const isWindows = process.platform === "win32";
  const scriptPath = path.join(cacheDir, isWindows ? "pimate-account-status.cjs" : "pimate-account-status.sh");
  const legacyScriptPath = path.join(cacheDir, "pimate-account-status.cjs");
  const command = isWindows
    ? `node "${scriptPath.replace(/"/g, "")}"`
    : `'${scriptPath.replace(/'/g, "'\\''")}'`;
  const legacyCommand = isWindows
    ? `node "${legacyScriptPath.replace(/"/g, "")}"`
    : `node '${legacyScriptPath.replace(/'/g, "'\\''")}'`;
  return {
    settingsPath: path.join(dir, "settings.json"),
    cacheDir,
    scriptPath,
    legacyScriptPath,
    accountPath: path.join(cacheDir, "pimate-account-status.json"),
    backupPath: path.join(cacheDir, "pimate-account-statusline-backup.json"),
    command,
    legacyCommand,
  };
}

function readSettings(settingsPath: string): Record<string, unknown> {
  const data: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid AGY settings.json");
  }
  return data as Record<string, unknown>;
}

function getStatusLine(settings: Record<string, unknown>): Record<string, unknown> {
  const value = settings.statusLine;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function writeSettings(settingsPath: string, settings: Record<string, unknown>): void {
  const temporary = `${settingsPath}.pimate-${process.pid}.tmp`;
  try {
    const mode = fs.statSync(settingsPath).mode & 0o777;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    fs.renameSync(temporary, settingsPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename completed */ }
  }
}

export function readAgyAccountBridge(baseDir?: string): AgyAccountBridgeStatus {
  const paths = bridgePaths(baseDir);
  let statusLine: Record<string, unknown> = {};
  let modelProvider: unknown;
  try {
    const settings = readSettings(paths.settingsPath);
    statusLine = getStatusLine(settings);
    modelProvider = settings.modelProvider;
  } catch {
    return { enabled: false, customStatusLine: false };
  }
  const isCurrentBridge = statusLine.command === paths.command && fs.existsSync(paths.scriptPath);
  const isLegacyBridge = statusLine.command === paths.legacyCommand && fs.existsSync(paths.legacyScriptPath);
  const enabled = (isCurrentBridge || isLegacyBridge) && statusLine.enabled !== false;
  const customStatusLine = typeof statusLine.command === "string"
    && statusLine.command.trim().length > 0
    && statusLine.command !== paths.command
    && statusLine.command !== paths.legacyCommand;
  if (!enabled || modelProvider === "gemini") return { enabled, customStatusLine };
  try {
    const data: unknown = JSON.parse(fs.readFileSync(paths.accountPath, "utf8"));
    if (data && typeof data === "object") {
      const account = data as Record<string, unknown>;
      if (typeof account.email === "string"
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)
        && account.email.length <= 320
        && typeof account.capturedAt === "number"
        && Number.isFinite(account.capturedAt)
        && account.capturedAt <= Date.now()) {
        return { enabled, customStatusLine, email: account.email, capturedAt: account.capturedAt };
      }
    }
  } catch { /* AGY has not started an interactive session since setup. */ }
  return { enabled, customStatusLine };
}

export function installAgyAccountBridge(baseDir?: string): void {
  const paths = bridgePaths(baseDir);
  const before = fs.readFileSync(paths.settingsPath, "utf8");
  const settings = readSettings(paths.settingsPath);
  const statusLine = getStatusLine(settings);
  if (statusLine.command === paths.command && statusLine.enabled !== false
    && fs.existsSync(paths.scriptPath)) return;
  const migratingLegacyBridge = paths.legacyCommand !== paths.command
    && statusLine.command === paths.legacyCommand
    && fs.existsSync(paths.legacyScriptPath);
  if (migratingLegacyBridge
    && fs.readFileSync(paths.legacyScriptPath, "utf8") !== NODE_BRIDGE_SCRIPT) {
    throw new Error("The existing Pimate status-line bridge was modified; it was left untouched");
  }
  if (typeof statusLine.command === "string" && statusLine.command.trim()
    && statusLine.command !== paths.command
    && statusLine.command !== paths.legacyCommand) {
    throw new Error("AGY already has a custom status-line command");
  }
  if (process.platform === "win32") {
    try {
      execFileSync("node", ["--version"], { timeout: 5_000, stdio: "ignore" });
    } catch {
      throw new Error("Node.js must be available in PATH for AGY account display on Windows");
    }
  }
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  const temporaryScript = `${paths.scriptPath}.pimate-${process.pid}.tmp`;
  try {
    const script = process.platform === "win32" ? NODE_BRIDGE_SCRIPT : POSIX_BRIDGE_SCRIPT;
    fs.writeFileSync(temporaryScript, script, { mode: process.platform === "win32" ? 0o600 : 0o700 });
    fs.renameSync(temporaryScript, paths.scriptPath);
  } finally {
    try { fs.unlinkSync(temporaryScript); } catch { /* rename completed */ }
  }
  if (!fs.existsSync(paths.backupPath)) {
    fs.writeFileSync(paths.backupPath, JSON.stringify(statusLine), { flag: "wx", mode: 0o600 });
  }
  if (fs.readFileSync(paths.settingsPath, "utf8") !== before) {
    throw new Error("AGY settings changed during account-display setup");
  }
  settings.statusLine = {
    ...statusLine,
    type: "command",
    command: paths.command,
    enabled: true,
    stack_with_default: true,
  };
  writeSettings(paths.settingsPath, settings);
  if (migratingLegacyBridge) {
    try { fs.unlinkSync(paths.legacyScriptPath); } catch { /* migration already works */ }
  }
}

export function removeAgyAccountBridge(baseDir?: string): void {
  const paths = bridgePaths(baseDir);
  const settings = readSettings(paths.settingsPath);
  const command = getStatusLine(settings).command;
  if (command !== paths.command && command !== paths.legacyCommand) return;
  let original: unknown;
  try { original = JSON.parse(fs.readFileSync(paths.backupPath, "utf8")); } catch { /* older setup */ }
  settings.statusLine = original && typeof original === "object" && !Array.isArray(original)
    ? original
    : { type: "", command: "", enabled: true };
  writeSettings(paths.settingsPath, settings);
  for (const file of [paths.accountPath, paths.backupPath]) {
    try { fs.unlinkSync(file); } catch { /* absent */ }
  }
  for (const [scriptPath, expected] of [
    [paths.scriptPath, process.platform === "win32" ? NODE_BRIDGE_SCRIPT : POSIX_BRIDGE_SCRIPT],
    [paths.legacyScriptPath, NODE_BRIDGE_SCRIPT],
  ] as const) {
    try {
      if (fs.readFileSync(scriptPath, "utf8") === expected) fs.unlinkSync(scriptPath);
    } catch { /* absent or user-modified */ }
  }
}
