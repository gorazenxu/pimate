import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

/** Update one provider without replacing unrelated settings or malformed files. */
export function updatePiModelsFile(filePath: string, id: string, value: Record<string, unknown> | null): void {
  const read = (): string | null => {
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error("Linked models.json is not supported");
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Cannot safely read models.json");
    }
  };
  const before = read();
  let data: Record<string, any> = {};
  if (before !== null) {
    try {
      data = JSON.parse(before);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      if (data.providers !== undefined && (!data.providers || typeof data.providers !== "object" || Array.isArray(data.providers))) throw new Error();
    } catch {
      throw new Error("Invalid models.json; existing file was not changed");
    }
  }
  const providers = { ...data.providers };
  if (value === null) delete providers[id];
  else Object.defineProperty(providers, id, { value, enumerable: true, configurable: true, writable: true });
  data.providers = providers;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.pimate-models-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    const mode = before === null ? 0o600 : fs.statSync(filePath).mode & 0o777;
    fd = fs.openSync(temp, "wx", mode);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (read() !== before) throw new Error("models.json changed while saving; retry");
    fs.renameSync(temp, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[pimate] Could not remove temporary models file"); }
  }
}
