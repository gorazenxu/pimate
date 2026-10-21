export type AgyHistoryBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type AgyHistoryMessage =
  | { role: "user" | "assistant"; content: AgyHistoryBlock[] }
  | { role: "toolResult"; toolName: string; toolCallId: string; content: string;
      isError?: boolean; details?: Record<string, unknown> };

/** Local observed turn, retained until the native transcript confirms it. */
export interface AgyHistoryOverlayTurn {
  ordinal: number;
  user: AgyHistoryMessage;
  assistant?: AgyHistoryMessage;
  completed: boolean;
}

function blockText(message: AgyHistoryMessage, type: "text" | "thinking"): string {
  if (!Array.isArray(message.content)) return "";
  return message.content.map(block => {
    if (block.type === "text" && type === "text") return block.text;
    if (block.type === "thinking" && type === "thinking") return block.thinking;
    return "";
  }).join("");
}

export function normalizeAgyUserText(text: string): string {
  const request = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return (request ? request[1] : text).trim();
}

/**
 * Merge by user-turn position AND content, not a global Set of message text.
 * Identical prompts in different turns are distinct. Overlay replies stay
 * beside their user message, even when newer native turns have already flushed.
 * All inputs are read-only; neither this function nor its callers write AGY logs.
 */
export function mergeAgyHistory(
  nativeMessages: AgyHistoryMessage[],
  overlays: AgyHistoryOverlayTurn[]
): { messages: AgyHistoryMessage[]; pendingTurns: AgyHistoryOverlayTurn[] } {
  if (overlays.length === 0) return { messages: [...nativeMessages], pendingTurns: [] };
  const messages: AgyHistoryMessage[] = [];
  const pendingTurns: AgyHistoryOverlayTurn[] = [];
  const byOrdinal = new Map(overlays.map(turn => [turn.ordinal, turn]));
  const matched = new Set<AgyHistoryOverlayTurn>();
  let ordinal = 0;
  for (let index = 0; index < nativeMessages.length;) {
    const first = nativeMessages[index];
    if (first.role !== "user") {
      messages.push(first);
      index++;
      continue;
    }
    ordinal++;
    let end = index + 1;
    while (end < nativeMessages.length && nativeMessages[end].role !== "user") end++;
    const nativeTurn = nativeMessages.slice(index, end);
    const overlay = byOrdinal.get(ordinal);
    const userMatches = overlay && normalizeAgyUserText(blockText(first, "text")) ===
      normalizeAgyUserText(blockText(overlay.user, "text"));
    if (!overlay || !userMatches) {
      messages.push(...nativeTurn);
      index = end;
      continue;
    }
    matched.add(overlay);
    let replyConfirmed = !overlay.assistant;
    if (overlay.assistant) {
      const text = blockText(overlay.assistant, "text").trim();
      const thinking = blockText(overlay.assistant, "thinking").trim();
      const nativeReplies = nativeTurn.filter(message => message.role === "assistant");
      replyConfirmed = text
        ? nativeReplies.some(message => blockText(message, "text").trim() === text) ||
          nativeReplies.map(message => blockText(message, "text")).join("").trim() === text
        : nativeReplies.some(message => blockText(message, "thinking").trim() === thinking);
      if (!replyConfirmed) {
        const last = nativeTurn[nativeTurn.length - 1];
        const partialText = last.role === "assistant" ? blockText(last, "text").trim() : "";
        if (text && partialText && text.startsWith(partialText) && Array.isArray(last.content)) {
          // A partially flushed final response is extended for display, not
          // appended a second time. Keep native thinking and tool-call blocks.
          nativeTurn[nativeTurn.length - 1] = {
            role: "assistant",
            content: [...last.content.filter(block => block.type !== "text"), { type: "text", text }],
          };
        } else {
          nativeTurn.push(overlay.assistant);
        }
      }
    }
    messages.push(...nativeTurn);
    if (!overlay.completed || !replyConfirmed) pendingTurns.push(overlay);
    index = end;
  }
  for (const overlay of overlays) {
    if (matched.has(overlay)) continue;
    messages.push(overlay.user);
    if (overlay.assistant) messages.push(overlay.assistant);
    pendingTurns.push(overlay);
  }
  return { messages, pendingTurns };
}
