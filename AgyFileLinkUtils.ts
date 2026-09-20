import { fileURLToPath } from "url";
import { isAbsolute, relative, resolve, sep } from "path";

/**
 * Convert an absolute local file URL emitted by AGY into an Obsidian
 * wikilink, without exposing the host path in the rendered answer.
 *
 * AGY may emit either `[label](file:///...)` or put the destination on the
 * next line. Only paths inside the active Vault are made into links. Other
 * local file URLs are reduced to their label (or a short placeholder) so a
 * response cannot leak an unrelated host path into the UI.
 */
export function normalizeAgyFileLinks(markdown: string, vaultBasePath: string): string {
  if (!markdown || !vaultBasePath) return markdown;

  const vaultRoot = resolve(vaultBasePath);
  const codeBlocks: string[] = [];
  const codeBlockPrefix = "@@PIMATE_AGY_FILE_CODE_BLOCK_";
  const protectedMarkdown = markdown.replace(/\x60{3}[\s\S]*?\x60{3}/g, (block) => {
    const key = codeBlockPrefix + codeBlocks.length + "@@";
    codeBlocks.push(block);
    return key;
  });

  const withLabeledLinks = protectedMarkdown.replace(
    /\[([^\]\r\n]+)\][ \t]*(?:\r?\n[ \t]*)?\([ \t]*(?:<)?(file:\/\/[^\s<>)]+)(?:>)?[ \t]*\)/g,
    (_match, label: string, uri: string) => {
      const vaultPath = toVaultRelativePath(uri, vaultRoot);
      return vaultPath
        ? toObsidianWikilink(vaultPath, label)
        : label.trim() || "[local file link hidden]";
    }
  );

  // Also handle a bare file URL if AGY emits one without a Markdown label.
  const normalized = withLabeledLinks.replace(
    /file:\/\/[^\s<>)]+/g,
    (uri: string) => {
      const vaultPath = toVaultRelativePath(uri, vaultRoot);
      return vaultPath ? toObsidianWikilink(vaultPath) : "[local file link hidden]";
    }
  );

  return normalized.replace(
    new RegExp(codeBlockPrefix + "(\\d+)@@", "g"),
    (_match, index) => codeBlocks[Number(index)] || ""
  );
}

function toVaultRelativePath(uri: string, vaultRoot: string): string | null {
  try {
    const absolutePath = resolve(fileURLToPath(uri));
    const relativePath = relative(vaultRoot, absolutePath);
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    ) {
      return null;
    }
    return relativePath.split(sep).join("/");
  } catch {
    return null;
  }
}

function toObsidianWikilink(vaultPath: string, label?: string): string {
  const safePath = vaultPath.replace(/\|/g, "\\|");
  const safeLabel = label?.trim().replace(/\|/g, "｜");
  return safeLabel ? `[[${safePath}|${safeLabel}]]` : `[[${safePath}]]`;
}
