const EXCLUDED_CONTEXT_PATH_SEGMENTS = new Set([
  ".obsidian",
  ".trash",
  ".git",
  "node_modules",
]);

const EXCLUDED_CONTEXT_FILENAMES = new Set([".ds_store", "thumbs.db"]);

// These are formats that Pi/AGY can commonly inspect as text, documents,
// spreadsheets, slides, PDFs, or images when the user attaches them from the
// current vault. Binary media and archives stay out of the @ picker until we
// have a dedicated extraction/preview path for them.
const CONTEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "java",
  "go",
  "rs",
  "sh",
  "bash",
  "zsh",
  "sql",
  "log",
  "srt",
  "vtt",
  "doc",
  "docx",
  "odt",
  "rtf",
  "xls",
  "xlsx",
  "ods",
  "ppt",
  "pptx",
  "odp",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
]);

const SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx", "ods"]);
const SLIDE_EXTENSIONS = new Set(["ppt", "pptx", "odp"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "odt", "rtf"]);
const CODE_EXTENSIONS = new Set([
  "css",
  "html",
  "htm",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "java",
  "go",
  "rs",
  "sh",
  "bash",
  "zsh",
  "sql",
  "xml",
]);

/** Return a normalized lower-case extension without the leading dot. */
export function getVaultFileExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Whether a vault-relative path is safe and useful for the @ context picker.
 * This is deliberately a pure path/extension check; vault enumeration stays
 * in the view and remains scoped to the active vault.
 */
export function isVaultContextFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/")) return false;

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const fileName = lowerSegments[lowerSegments.length - 1];

  if (EXCLUDED_CONTEXT_FILENAMES.has(fileName)) return false;
  if (lowerSegments.some((segment) => EXCLUDED_CONTEXT_PATH_SEGMENTS.has(segment))) {
    return false;
  }

  return CONTEXT_EXTENSIONS.has(getVaultFileExtension(normalized));
}

/** A compact label used beside a file name in attachment pickers. */
export function getVaultFileTypeLabel(extension: string): string {
  const ext = extension.replace(/^\./, "").toLowerCase();
  if (ext === "pdf") return "PDF";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (SPREADSHEET_EXTENSIONS.has(ext)) return "table";
  if (SLIDE_EXTENSIONS.has(ext)) return "slides";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (["md", "markdown", "txt", "json", "jsonl", "yaml", "yml", "log", "srt", "vtt"].includes(ext)) {
    return "text";
  }
  return ext ? ext.toUpperCase() : "file";
}

/** Return the same small icon everywhere a vault file is shown as context. */
export function getVaultFileIcon(extension: string): string {
  const ext = extension.replace(/^\./, "").toLowerCase();
  if (ext === "pdf") return "📄";
  if (IMAGE_EXTENSIONS.has(ext)) return "🖼";
  if (SPREADSHEET_EXTENSIONS.has(ext)) return "📊";
  if (SLIDE_EXTENSIONS.has(ext)) return "📽️";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "📑";
  if (CODE_EXTENSIONS.has(ext)) return "💻";
  if (["md", "markdown", "txt", "json", "jsonl", "yaml", "yml", "log", "srt", "vtt"].includes(ext)) {
    return "📝";
  }
  return "📎";
}
