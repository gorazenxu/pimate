export type PimateLanguage = "zh" | "en";

const EN_TEXT = {
  conversationNotReady: "This conversation is switching or not ready yet. Please try again shortly.",
  unknownError: "Unknown error",
  piExtensionError: "Pi extension error: {error}",
  steerNoText: "This message has no text to redirect.",
  steerTooltip: "Interrupt the current response and redirect using this message",
  steerButton: "Steer",
  forkPromptTooltip: "Fork from this prompt",
  forkPromptUnavailable: "This prompt cannot be forked yet",
  forkPromptNotSaved: "This prompt is not saved to the session yet, so it cannot be forked",
  sessionTreeTitle: "🌿 Forkable history nodes",
  sessionTreeDescription: "Select a history node to create a new conversation branch from it.",
  sessionTreeLoading: "Loading session history...",
  sessionTreeLoadFailed: "Could not load forkable history nodes.",
  sessionTreeEmpty: "There are no forkable history nodes in this session.",
  forkFromHere: "Fork from this point",
  forking: "Forking...",
  forkFailed: "Fork failed: {error}",
  forkNodesFailed: "Failed to load history nodes: {error}",
  sessionSwitched: "The session changed. Please select a history node again.",
  piClientNotReady: "Pi Agent is not ready yet.",
  bashImagesIgnored: "Built-in Pimate commands do not use attached images.",
  exportMessagesFailed: "Could not load messages for the current session.",
  exportNoMessages: "There are no messages to export in the current session.",
  exportTitle: "Pimate conversation — {date}",
  exportedAt: "Exported at: {time}",
  exportUserRole: "👤 User",
  exportAssistantRole: "🤖 Pi Agent",
  exportThinking: "Thinking",
  exportToolCall: "Tool call",
  exportNoteSuccess: "Note exported: {fileName}",
  exportNoteFailure: "Failed to export note: {error}",
} as const;

type PimateUiTextKey = keyof typeof EN_TEXT;

const ZH_TEXT: Record<PimateUiTextKey, string> = {
  conversationNotReady: "当前对话正在切换或尚未就绪，请稍后再发送",
  unknownError: "未知错误",
  piExtensionError: "Pi 扩展错误: {error}",
  steerNoText: "这条消息没有可调整的文字",
  steerTooltip: "中断当前回复并按此消息调整",
  steerButton: "调整方向",
  forkPromptTooltip: "Fork 从此提问分支",
  forkPromptUnavailable: "该提问暂不能 Fork",
  forkPromptNotSaved: "该提问尚未写入会话，暂不能 Fork",
  sessionTreeTitle: "🌿 可 Fork 的历史节点",
  sessionTreeDescription: "选择一个历史节点，即可从该节点创建新的对话分支。",
  sessionTreeLoading: "加载会话节点数据中...",
  sessionTreeLoadFailed: "未能获取可 Fork 的历史节点。",
  sessionTreeEmpty: "当前会话没有可 Fork 的历史节点。",
  forkFromHere: "Fork 从此分支",
  forking: "正在 Fork...",
  forkFailed: "Fork 失败: {error}",
  forkNodesFailed: "获取节点失败: {error}",
  sessionSwitched: "当前会话已切换，请重新选择历史节点",
  piClientNotReady: "Pi Agent 客户端尚未就绪",
  bashImagesIgnored: "Pimate 内建命令不会使用附加图片",
  exportMessagesFailed: "无法获取当前会话消息记录",
  exportNoMessages: "当前会话暂无可导出的消息",
  exportTitle: "Pimate 对话记录 — {date}",
  exportedAt: "导出时间: {time}",
  exportUserRole: "👤 用户",
  exportAssistantRole: "🤖 Pi Agent",
  exportThinking: "思考过程",
  exportToolCall: "工具调用",
  exportNoteSuccess: "已导出笔记: {fileName}",
  exportNoteFailure: "导出笔记失败: {error}",
};

export const PIMATE_UI_TEXT_KEYS = Object.keys(EN_TEXT) as PimateUiTextKey[];

export function getPimateUiText(
  language: PimateLanguage,
  key: PimateUiTextKey,
  values: Readonly<Record<string, string | number>> = {}
): string {
  let text = language === "zh" ? ZH_TEXT[key] : EN_TEXT[key];
  for (const [name, value] of Object.entries(values)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
