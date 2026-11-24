export interface MessageImage {
  data?: string;
  mimeType?: string;
  src?: string;
  vaultPath?: string;
  label?: string;
}

const AGY_VAULT_IMAGE_REF_RE = /@((?:999agy对话图片)\/[^\s"'<>`()\[\]]+\.(?:png|jpe?g|gif|webp|bmp|avif))/gi;

/**
 * Extract safe relative Vault image paths written by AGY attachment persistence,
 * ignoring traversal segments and references inside fenced code blocks.
 */
export function extractAgyVaultImagePaths(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    AGY_VAULT_IMAGE_REF_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = AGY_VAULT_IMAGE_REF_RE.exec(line)) !== null) {
      const candidate = match[1];
      if (!candidate || candidate.includes("..") || candidate.includes("\\") || candidate.includes("://")) {
        continue;
      }
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
    }
  }
  return out;
}

/** Native Pi image blocks only: never load URLs or paths found in chat text. */
export function getMessageImages(content: unknown): MessageImage[] {
  if (!Array.isArray(content)) return [];
  const images: MessageImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type, data, mimeType } = block as Record<string, unknown>;
    if (type !== "image" || typeof data !== "string" || !data ||
        typeof mimeType !== "string") continue;
    const normalizedMime = mimeType.trim().toLowerCase();
    if (!/^(image\/(png|jpeg|gif|webp))$/.test(normalizedMime) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1 ||
        (data.endsWith("=") && data.length % 4 !== 0)) continue;
    images.push({ data, mimeType: normalizedMime });
  }
  return images;
}

/**
 * Pi appends these exact hints after normalizing prompt images. Hide only
 * trailing hints backed by image blocks; keep failures and ordinary user text.
 * This is a display transform, never a mutation of the RPC/history payload.
 */
export function stripPiImageDimensionNotes(text: string, imageCount: number): string {
  let visible = text;
  for (let index = 0; index < imageCount; index++) {
    const hint = visible.match(/\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]\s*$/);
    if (!hint || hint.index === undefined) break;
    if (hint.index > 0 && !/\s/.test(visible[hint.index - 1])) break;
    const prefix = visible.slice(0, hint.index);
    // A literal example in an unfinished fenced code block is not metadata.
    let fence: string | null = null;
    for (const line of prefix.split(/\r?\n/)) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (!marker) continue;
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (fence) break;
    visible = prefix.trimEnd();
  }
  return visible;
}
