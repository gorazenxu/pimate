import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

function readSnapshot(filePath: string): string | null {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error("Refusing to replace a linked auth file");
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot read auth file safely");
  }
}

/** Update only the requested fields, using the latest file, never a UI snapshot. */
export function updatePiAuthFile(
  filePath: string,
  update: (data: Record<string, any>) => void
): void {
  const before = readSnapshot(filePath);
  let data: Record<string, any> = {};
  if (before !== null) {
    try {
      data = JSON.parse(before);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    } catch {
      throw new Error("Invalid auth file; existing credentials were not overwritten");
    }
  }
  update(data);
  const serialized = JSON.stringify(data, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.pimate-auth-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Detect external refreshes before replacement (optimistic concurrency check).
    if (readSnapshot(filePath) !== before) throw new Error("Auth file changed; retry saving credentials");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    // Do not expose file contents or credentials through filesystem errors.
    throw new Error("Could not save credentials safely; existing auth file was kept");
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { console.warn("[pimate] Could not close temporary auth file"); }
    }
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[pimate] Could not remove temporary auth file");
      }
    }
  }
}
