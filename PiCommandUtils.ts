import * as path from "path";

/** Source metadata attached to commands returned by Pi's get_commands RPC. */
export interface PiCommandSourceInfo {
  path?: string;
  [key: string]: unknown;
}

/** A command that Pi can invoke through the prompt RPC. */
export interface PiCommandInfo {
  name: string;
  description?: string;
  source?: string;
  sourceInfo?: PiCommandSourceInfo;
  /** Kept for compatibility with older Pi builds that exposed a top-level path. */
  path?: string;
}

/**
 * Resolve a Pi resource path using the same base directory Pi uses for RPC
 * startup, then normalize separators and Windows casing for comparison.
 */
export function normalizePiPathForComparison(
  value: string,
  basePath: string = process.cwd()
): string {
  const resolved = path.resolve(basePath, value.trim()).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Return the canonical provenance path, with a legacy fallback for old Pi. */
export function getPiCommandSourcePath(
  command: PiCommandInfo
): string | undefined {
  const sourcePath = command.sourceInfo?.path;
  if (typeof sourcePath === "string" && sourcePath.trim()) return sourcePath;
  return typeof command.path === "string" && command.path.trim()
    ? command.path
    : undefined;
}

/** Check whether a command is an extension command from the expected file. */
export function isPiCommandFromPath(
  command: PiCommandInfo,
  expectedPath: string,
  basePath: string = process.cwd()
): boolean {
  const sourcePath = getPiCommandSourcePath(command);
  if (command.source !== "extension" || !sourcePath || !expectedPath.trim()) {
    return false;
  }

  return (
    normalizePiPathForComparison(sourcePath, basePath) ===
    normalizePiPathForComparison(expectedPath, basePath)
  );
}
