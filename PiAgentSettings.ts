import { App, PluginSettingTab, Setting, Notice, Modal, requestUrl } from "obsidian";
import type PiAgentPlugin from "./main";
import { PI_AGENT_VIEW_TYPE } from "./PiAgentView";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";

// OpenAI Codex (ChatGPT) device-code flow constants, reverse-engineered from
// @earendil-works/pi-ai/dist/utils/oauth/openai-codex.js
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const OPENAI_CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const OPENAI_CODEX_TIMEOUT_SECONDS = 15 * 60;

// ─── Pi 内置 Provider 清单 ────────────────────────────────────────────────
// 与 @earendil-works/pi-ai 的 env-api-keys.ts 对齐。Pimate 设置页据此区分
// 「内置（配 key 即用）」与「自定义（来自 models.json）」两类 provider。
// 完整列表见 Pi 文档 providers.md；此处只列常用项，未列出的内置 provider
// 仍可通过环境变量直接使用。
interface BuiltinProvider {
  id: string;
  name: string;
  envVar: string;
  oauth?: boolean;        // true = 走订阅/OAuth，不填 API Key
  authJsonKey?: string;   // auth.json 里的字段名（多数等于 id，少数不同）
}

const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  // ─ 国际主流 ─
  { id: "anthropic",     name: "Anthropic (Claude)",        envVar: "ANTHROPIC_API_KEY",   authJsonKey: "anthropic" },
  { id: "openai-codex",  name: "OpenAI (ChatGPT 订阅)",      envVar: "",                    oauth: true, authJsonKey: "openai-codex" },
  { id: "openai",        name: "OpenAI (API Key)",           envVar: "OPENAI_API_KEY",      authJsonKey: "openai" },
  { id: "google",        name: "Google (Gemini)",            envVar: "GEMINI_API_KEY",      authJsonKey: "google" },
  { id: "groq",          name: "Groq",                       envVar: "GROQ_API_KEY",        authJsonKey: "groq" },
  { id: "xai",           name: "xAI (Grok)",                 envVar: "XAI_API_KEY",         authJsonKey: "xai" },
  { id: "openrouter",    name: "OpenRouter",                 envVar: "OPENROUTER_API_KEY",  authJsonKey: "openrouter" },
  { id: "mistral",       name: "Mistral",                    envVar: "MISTRAL_API_KEY",     authJsonKey: "mistral" },
  { id: "together",      name: "Together AI",                envVar: "TOGETHER_API_KEY",    authJsonKey: "together" },
  { id: "fireworks",     name: "Fireworks",                  envVar: "FIREWORKS_API_KEY",   authJsonKey: "fireworks" },
  { id: "nvidia",        name: "NVIDIA NIM",                 envVar: "NVIDIA_API_KEY",      authJsonKey: "nvidia" },
  // ─ 国内 / 中文场景 ─
  { id: "deepseek",      name: "DeepSeek",                   envVar: "DEEPSEEK_API_KEY",    authJsonKey: "deepseek" },
  { id: "zai",           name: "智谱 Z.AI (GLM)",            envVar: "ZAI_API_KEY",         authJsonKey: "zai" },
  { id: "zai-coding-cn", name: "智谱 Coding Plan (国内)",    envVar: "ZAI_CODING_CN_API_KEY", authJsonKey: "zai-coding-cn" },
  { id: "minimax",       name: "MiniMax (国际)",             envVar: "MINIMAX_API_KEY",     authJsonKey: "minimax" },
  { id: "minimax-cn",    name: "MiniMax (国内)",             envVar: "MINIMAX_CN_API_KEY",  authJsonKey: "minimax-cn" },
  { id: "moonshotai",    name: "月之暗面 Kimi (国际)",        envVar: "MOONSHOT_API_KEY",    authJsonKey: "moonshotai" },
  { id: "moonshotai-cn", name: "月之暗面 Kimi (国内)",        envVar: "MOONSHOT_API_KEY",    authJsonKey: "moonshotai-cn" },
  { id: "xiaomi",        name: "小米 MiMo",                  envVar: "XIAOMI_API_KEY",      authJsonKey: "xiaomi" },
  { id: "kimi-coding",   name: "Kimi For Coding",            envVar: "KIMI_API_KEY",        authJsonKey: "kimi-coding" },
];

export interface PersistedSessionTab {
  label: string;
  sessionFile?: string;
  sessionId?: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export interface PiAgentSettings {
  piPath: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  apiKey: string;
  autoScroll: boolean;
  showThinking: boolean;
  smartReviewEnabled: boolean;
  smartReviewMaxContinues: number;
  maxHistoryDisplay: number;
  sessionTabs: PersistedSessionTab[];
  activeSessionFile: string;
  systemPrompt: string;
  snippets: string[];
  language: "zh" | "en";
  maxTabs: number;
  streamingRenderMode: "auto" | "pretty" | "fast";
  sessionTitles: Record<string, string>;
  // (Hotkey for file-explorer selection was removed: it relied on internal
  // Obsidian APIs. Multi-select is now triggered via right-click only.)
}

export const DEFAULT_SETTINGS: PiAgentSettings = {
  piPath: "pi",
  provider: "",
  modelId: "",
  thinkingLevel: "",
  apiKey: "",
  autoScroll: true,
  showThinking: true,
  smartReviewEnabled: false,
  smartReviewMaxContinues: 3,
  maxHistoryDisplay: 100,
  sessionTabs: [],
  activeSessionFile: "",
  systemPrompt: "",
  snippets: [],
  language: "zh",
  maxTabs: 3,
  streamingRenderMode: "pretty",
  sessionTitles: {},
  // (addExplorerSelectionHotkey removed — right-click now handles multi-select)
};

export interface DiscoveredSkill {
  name: string;
  description: string;
  disabled: boolean;
  filePath: string;
  scope: "global" | "project";
}

export class PiAgentSettingTab extends PluginSettingTab {
  plugin: PiAgentPlugin;
  temporaryProviders: string[] = [];
  // 刚添加（未提交 key）的内置 provider id，display() 后用
  // `data-just-added` 定位那一行的 key input，避免「猜最后一个 input」的
  // 误跳焦点问题（自定义 provider 区里的 input 也匹配 input[type=password]）。
  justAddedBuiltinId: string | null = null;

  constructor(app: App, plugin: PiAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 辅助方法：获取 auth.json 的绝对路径
  private getAuthJsonPath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, ".pi", "agent", "auth.json");
  }

  // 辅助方法：获取 models.json 的绝对路径（自定义 provider 定义）
  private getModelsJsonPath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, ".pi", "agent", "models.json");
  }

  // 辅助方法：读取 models.json 的 providers 部分
  // 返回 { providers: Record<string, any> }；文件不存在或格式错返回空对象
  private readModelsJson(): Record<string, any> {
    const filePath = this.getModelsJsonPath();
    if (!fs.existsSync(filePath)) return {};
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) || {};
      return (data.providers && typeof data.providers === "object") ? data.providers : {};
    } catch (e) {
      console.error("读取 models.json 失败:", e);
      return {};
    }
  }

  // 辅助方法：安全写入 models.json（保留原有顶层字段，只替换 providers）
  private writeModelsJson(providers: Record<string, any>): void {
    const filePath = this.getModelsJsonPath();
    let data: Record<string, any> = {};
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        data = JSON.parse(content) || {};
      } catch (e) {
        console.error("解析已有 models.json 失败，将重置配置:", e);
      }
    }
    data.providers = providers;
    try {
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.error("写入 models.json 失败:", e);
    }
  }

  // 辅助方法：判断某 provider id 是否为 Pi 内置
  private isBuiltinProvider(id: string): boolean {
    return BUILTIN_PROVIDERS.some(p => p.id === id);
  }

  // 辅助方法：取内置 provider 的展示信息
  private getBuiltinProvider(id: string): BuiltinProvider | undefined {
    return BUILTIN_PROVIDERS.find(p => p.id === id);
  }

  // 辅助方法：以 UTF-8 编码读取对应厂商的 API Key
  private readApiKey(provider: string): string {
    const filePath = this.getAuthJsonPath();
    if (!fs.existsSync(filePath)) {
      return "";
    }
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content);
      if (data && data[provider]) {
        const item = data[provider];
        if (item.type === "oauth") {
          return "[OAuth 已授权 / OAuth Authorized]";
        }
        return item.key || "";
      }
    } catch (e) {
      console.error("读取 auth.json 失败:", e);
    }
    return "";
  }

  // 辅助方法：以 UTF-8 编码将对应厂商的 API Key 写入 auth.json
  private writeApiKey(provider: string, apiKey: string): void {
    // 保护已授权 of OAuth 状态不被冲刷
    if (apiKey === "[OAuth 已授权 / OAuth Authorized]") {
      return;
    }

    const filePath = this.getAuthJsonPath();
    let data: Record<string, any> = {};

    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        data = JSON.parse(content) || {};
      } catch (e) {
        console.error("解析已有 auth.json 失败，将重置配置:", e);
      }
    }

    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      delete data[provider];
    } else {
      data[provider] = {
        type: "api_key",
        key: trimmedKey
      };
    }

    try {
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.error("写入 auth.json 失败:", e);
    }
  }

  // 获取全局 skills 物理路径
  private getGlobalSkillsDir(): string {
    return path.join(os.homedir(), ".pi", "agent", "skills");
  }

  // 获取本地 Vault 各个项目级技能路径列表
  private getProjectSkillsDirs(): string[] {
    const adapter = this.app.vault.adapter as any;
    const basePath = adapter.basePath || "";
    if (!basePath) return [];
    return [
      path.join(basePath, ".pi", "agent", "skills"),
      path.join(basePath, "skills"),
      path.join(basePath, ".agents", "skills")
    ];
  }

  // 解析单个技能文件的 frontmatter
  private parseSkillFile(filePath: string): { name: string; description: string; disabled: boolean } | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let name = path.basename(path.dirname(filePath));
      let description = "";
      let disabled = false;

      if (match) {
        const yamlStr = match[1];
        const lines = yamlStr.split("\n");
        for (const line of lines) {
          const parts = line.split(":");
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const val = parts.slice(1).join(":").trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
            if (key === "name") {
               name = val;
            } else if (key === "description") {
               description = val;
            } else if (key === "disable-model-invocation") {
               disabled = val === "true";
            }
          }
        }
      }
      return { name, description, disabled };
    } catch (e) {
      console.error("解析 skill 文件失败:", filePath, e);
      return null;
    }
  }

  // 外科手术式修改或删除前言属性
  private toggleSkill(filePath: string, disableModelInvocation: boolean): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const key = "disable-model-invocation";
      const hasFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.test(content);
      let updated = content;

      if (hasFrontmatter) {
        const alreadySet = new RegExp(`^${key}\\s*:.*\\r?\\n`, "m").test(content);
        if (disableModelInvocation && !alreadySet) {
          updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
        } else if (!disableModelInvocation && alreadySet) {
          updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
        }
      } else {
        if (disableModelInvocation) {
          updated = `---\n${key}: true\n---\n${content}`;
        }
      }
      fs.writeFileSync(filePath, updated, "utf-8");
    } catch (e) {
      console.error("更新 skill 启用状态失败:", filePath, e);
    }
  }

  // 扫描所有技能目录并合并去重
  private scanSkills(): DiscoveredSkill[] {
    const list: DiscoveredSkill[] = [];

    // 1. 扫描全局
    const globalDir = this.getGlobalSkillsDir();
    if (fs.existsSync(globalDir)) {
      try {
        const items = fs.readdirSync(globalDir);
        for (const item of items) {
          const subDir = path.join(globalDir, item);
          if (fs.statSync(subDir).isDirectory()) {
            for (const filename of ["SKILL.md", "skill.md"]) {
              const filePath = path.join(subDir, filename);
              const parsed = this.parseSkillFile(filePath);
              if (parsed) {
                list.push({ ...parsed, filePath, scope: "global" });
                break;
              }
            }
          }
        }
      } catch (e) {
        console.error("扫描全局 skills 目录失败:", e);
      }
    }

    // 2. 扫描本地项目
    const projectDirs = this.getProjectSkillsDirs();
    for (const pDir of projectDirs) {
      if (fs.existsSync(pDir)) {
        try {
          const items = fs.readdirSync(pDir);
          for (const item of items) {
            const subDir = path.join(pDir, item);
            if (fs.statSync(subDir).isDirectory()) {
              for (const filename of ["SKILL.md", "skill.md"]) {
                const filePath = path.join(subDir, filename);
                const parsed = this.parseSkillFile(filePath);
                if (parsed) {
                  if (!list.some(s => s.filePath === filePath)) {
                    list.push({ ...parsed, filePath, scope: "project" });
                  }
                  break;
                }
              }
            }
          }
        } catch (e) {
          console.error("扫描项目 skills 目录失败:", pDir, e);
        }
      }
    }
    return list;
  }

  // 异步命令执行安装技能
  private installSkill(pkgName: string, scope: "global" | "project", callback: (err: string | null, output: string) => void): void {
    const adapter = this.app.vault.adapter as any;
    const basePath = adapter.basePath || "";
    const isGlobal = scope === "global";
    const cmd = `npx skills add ${pkgName.trim()} -y --agent pi${isGlobal ? " -g" : ""}`;
    const fullCmd = os.platform() === "win32" ? `chcp 65001 >nul && ${cmd}` : cmd;

    exec(fullCmd, { cwd: basePath || undefined }, (error, stdout, stderr) => {
      if (error) {
        callback(stderr.trim() || error.message || "安装失败", stdout + stderr);
      } else {
        callback(null, stdout);
      }
    });
  }

  // 异步在线/本地查询技能
  private async searchSkills(query: string): Promise<any[]> {
    const limit = 30;
    const url = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    try {
      const res = await requestUrl(url);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const data = res.json;
      return (data.skills ?? []).map((s: any) => {
        const name = s.name?.trim();
        const source = s.source?.trim();
        const slug = s.id?.trim();
        const pkg = `${source || slug}@${name}`;
        return {
          package: pkg,
          installs: s.installs || 0,
          url: slug ? `https://skills.sh/${slug}` : ""
        };
      });
    } catch (e) {
      console.warn("skills.sh search failed, falling back to local search:", e);
      return new Promise((resolve) => {
        const isWin = process.platform === "win32";
        const baseCmd = `npx skills find ${query.trim()}`;
        const cmd = isWin ? `chcp 65001 >nul && ${baseCmd}` : baseCmd;
        exec(cmd, { timeout: 15000 }, (err: any, stdout: string, stderr: string) => {
          const raw = stdout + stderr;
          const ansiEscape = String.fromCharCode(27);
          const clean = raw.replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "g"), "");
          const results: any[] = [];
          const lines = clean.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const pkgMatch = line.match(/^([\w.-]+\/[\w.@:-]+)\s+([\d.,]+[KMB]?\s+installs)$/);
            if (pkgMatch) {
              const urlLine = lines[i + 1]?.trim().replace(/^└\s*/, "");
              results.push({
                package: pkgMatch[1],
                installs: pkgMatch[2],
                url: urlLine?.startsWith("https://") ? urlLine : "",
              });
            }
          }
          resolve(results);
        });
      });
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const isZh = this.plugin.settings.language === "zh";

    new Setting(containerEl)
      .setName(isZh ? "Pimate 设置" : "Pimate Settings")
      .setHeading();

    // Language selector
    new Setting(containerEl)
      .setName(isZh ? "语言 (Language)" : "Language (语言)")
      .setDesc(isZh ? "选择设置界面的显示语言。" : "Choose the display language for the settings interface.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh", "简体中文 (Chinese)")
          .addOption("en", "English")
          .setValue(this.plugin.settings.language)
          .onChange(async (value: string) => {
            this.plugin.settings.language = value as "zh" | "en";
            await this.plugin.saveSettings();
            this.display(); // 即时刷新设置页面
          })
      );

    // File-explorer multi-select is now handled via right-click context menu
    // (right-click on file / folder → "Send to Pimate" or "Add N items to Pimate context"),
    // plus the More menu → "附加文件管理器选中项" / "Attach file explorer selection".
    // Multi-select reading uses Obsidian's internal selection/fileItems on a
    // best-effort basis (no menu interception), so it is more robust than
    // patching Obsidian's built-in multi-select context menu.

    // Pi executable path
    new Setting(containerEl)
      .setName(isZh ? "Pi 可执行路径" : "Pi executable path")
      .setDesc(
        isZh
          ? "Pi 命令的路径。默认使用 'pi'，会从系统的 PATH 环境变量中查找。"
          : "Path to the pi command. Default is 'pi', which will be searched from the system PATH."
      )
      .addText((text) =>
        text
          .setPlaceholder("pi")
          .setValue(this.plugin.settings.piPath)
          .onChange(async (value) => {
            this.plugin.settings.piPath = value || "pi";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "默认模型配置 (Default Model Configuration)" : "Default Model Configuration")
      .setHeading();

    // 预设模型映射表，当选择 provider 时可以关联更新 modelId 的 placeholder 和推荐的默认值
    const providerDefaults: Record<string, { model: string; desc: string; placeholder: string }> = {
      "anthropic": {
        model: "claude-3-5-sonnet-latest",
        desc: isZh ? "推荐: claude-3-5-sonnet-latest, claude-3-5-haiku-latest" : "Recommended: claude-3-5-sonnet-latest, claude-3-5-haiku-latest",
        placeholder: "claude-3-5-sonnet-latest"
      },
      "openai-codex": {
        model: "gpt-4o",
        desc: isZh ? "推荐: gpt-4o, gpt-4o-mini, o1, o3-mini" : "Recommended: gpt-4o, gpt-4o-mini, o1, o3-mini",
        placeholder: "gpt-4o"
      },
      "deepseek": {
        model: "deepseek-chat",
        desc: isZh ? "推荐: deepseek-chat, deepseek-reasoner" : "Recommended: deepseek-chat, deepseek-reasoner",
        placeholder: "deepseek-chat"
      },
      "minimax": {
        model: "MiniMax-M2.7",
        desc: isZh
          ? "内置 MiniMax-M2.7 / M2.7-highspeed。如需 M3，在 ~/.pi/agent/models.json 添加。"
          : "Built-in MiniMax-M2.7 / M2.7-highspeed. Add MiniMax-M3 via ~/.pi/agent/models.json.",
        placeholder: "MiniMax-M2.7"
      },
      "minimax-cn": {
        model: "MiniMax-M2.7",
        desc: isZh
          ? "内置 MiniMax-M2.7 / M2.7-highspeed。已通过 models.json 添加 MiniMax-M3（100 万上下文，支持图像）。"
          : "Built-in MiniMax-M2.7 / M2.7-highspeed. MiniMax-M3 (1M context, image support) added via models.json.",
        placeholder: "MiniMax-M2.7"
      },
      "siliconflow": {
        model: "deepseek-ai/DeepSeek-V3",
        desc: isZh ? "推荐: deepseek-ai/DeepSeek-V3, deepseek-ai/DeepSeek-R1" : "Recommended: deepseek-ai/DeepSeek-V3, deepseek-ai/DeepSeek-R1",
        placeholder: "deepseek-ai/DeepSeek-V3"
      },
      "google": {
        model: "gemini-2.5-flash",
        desc: isZh ? "推荐: gemini-2.5-flash, gemini-2.5-pro" : "Recommended: gemini-2.5-flash, gemini-2.5-pro",
        placeholder: "gemini-2.5-flash"
      },
      "zhipu": {
        model: "glm-5.2",
        desc: isZh
          ? "推荐: glm-5.2（Z.ai 旗舰, 1M 上下文）。GLM Coding Plan 套餐须走专属端点 https://open.bigmodel.cn/api/coding/paas/v4 —— 通用端点 /api/paas/v4 不抵扣套餐、按量扣费（会报 429 余额不足）。"
          : "Recommended: glm-5.2 (Z.ai flagship, 1M context). GLM Coding Plan MUST use https://open.bigmodel.cn/api/coding/paas/v4 — the generic /api/paas/v4 bypasses the plan and bills per-token (causes 429 balance errors).",
        placeholder: "glm-5.2"
      }
    };

    new Setting(containerEl)
      .setName(isZh ? "默认服务商 (Default Provider)" : "Default Provider")
      .setDesc(isZh ? "选择聊天时默认启用的模型服务商。" : "Choose the default model provider for chat sessions.")
      .addDropdown((dropdown) => {
        // 动态构建：内置 provider 清单 + models.json 自定义 provider
        const customProv = this.readModelsJson();
        const providers: { id: string; name: string }[] = [];
        // 内置（按清单顺序）
        for (const p of BUILTIN_PROVIDERS) {
          providers.push({ id: p.id, name: p.name });
        }
        // 自定义（models.json 里不在内置清单的）
        for (const id of Object.keys(customProv)) {
          if (!this.isBuiltinProvider(id)) {
            const prov = customProv[id];
            const modelCount = Array.isArray(prov?.models) ? prov.models.length : 0;
            providers.push({ id, name: `${id} (自定义/${modelCount}模型)` });
          }
        }

        for (const p of providers) {
          const key = this.readApiKey(p.id);
          const nameWithStatus = key ? `${p.name} [已配置 / Active]` : p.name;
          dropdown.addOption(p.id, nameWithStatus);
        }

        dropdown.setValue(this.plugin.settings.provider || "anthropic")
          .onChange(async (value) => {
            this.plugin.settings.provider = value;
            // 联动更新模型ID默认值
            const def = providerDefaults[value];
            if (def) {
              this.plugin.settings.modelId = def.model;
            }
            await this.plugin.saveSettings();
            
            // 实时刷新设置页，以展示新 provider 的 Placeholder 和模型 ID 值
            this.display();

            // 联动更新聊天视图 — 走 View 统一的 Pi 权威同步入口，
            // 让设置页修改的默认 provider/model 也通过 getState() 兜底。
            const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
            for (const leaf of leaves) {
              const view = leaf.view as any;
              if (view) {
                if (typeof view.updateActiveTabModel === "function") {
                  try {
                    await view.updateActiveTabModel(value, this.plugin.settings.modelId);
                  } catch (err) {
                    // Pi 拒绝了模型切换时，保持设置已写入但 UI 状态由
                    // view 内部同步入口统一刷新；此处仅记录错误。
                    console.warn("[pimate] updateActiveTabModel failed in settings:", err);
                  }
                } else if (view.client && typeof view.client.setModel === "function") {
                  // 兜底：旧版本 view 仍直接调用底层 RPC。
                  await view.client.setModel(value, this.plugin.settings.modelId);
                  if (typeof view.updateModelDisplay === "function") {
                    view.updateModelDisplay(value, this.plugin.settings.modelId);
                  }
                }
              }
            }
          });
      });

    const currentProvider = this.plugin.settings.provider || "anthropic";
    const defaultInfo = providerDefaults[currentProvider] || { model: "", desc: "", placeholder: "" };

    new Setting(containerEl)
      .setName(isZh ? "默认模型 ID (Default Model ID)" : "Default Model ID")
      .setDesc(defaultInfo.desc || (isZh ? "当前服务商的模型 ID" : "Model ID for current provider"))
      .addText((text) =>
        text
          .setPlaceholder(defaultInfo.placeholder)
          .setValue(this.plugin.settings.modelId || "")
          .onChange(async (value) => {
            const trimmed = value.trim();
            this.plugin.settings.modelId = trimmed;
            await this.plugin.saveSettings();

            // 联动更新聊天视图 — 走 View 统一的 Pi 权威同步入口。
            const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
            for (const leaf of leaves) {
              const view = leaf.view as any;
              if (view) {
                if (typeof view.updateActiveTabModel === "function") {
                  try {
                    await view.updateActiveTabModel(this.plugin.settings.provider, trimmed);
                  } catch (err) {
                    console.warn("[pimate] updateActiveTabModel failed in settings:", err);
                  }
                } else if (view.client && typeof view.client.setModel === "function") {
                  await view.client.setModel(this.plugin.settings.provider, trimmed);
                  if (typeof view.updateModelDisplay === "function") {
                    view.updateModelDisplay(this.plugin.settings.provider, trimmed);
                  }
                }
              }
            }
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "默认思考强度 (Default Effort Level)" : "Default Effort Level")
      .setDesc(isZh ? "作为新 Tab 的默认偏好；当前模型实际支持哪些档位，以聊天页 Effort 弹窗和 Pi 生效结果为准。" : "Default preference for new tabs. The chat Effort popup and Pi's effective state determine which levels the current model actually supports.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("", isZh ? "默认 (Pi Default)" : "Pi Default")
          .addOption("off", isZh ? "关闭 (Off)" : "Off")
          .addOption("minimal", isZh ? "最低 (Minimal)" : "Minimal")
          .addOption("low", isZh ? "较低 (Low)" : "Low")
          .addOption("medium", isZh ? "中等 (Medium)" : "Medium")
          .addOption("high", isZh ? "较高 (High)" : "High")
          .addOption("xhigh", isZh ? "极高 (X-High)" : "X-High")
          .addOption("max", isZh ? "极限 (Max)" : "Max")
          .setValue(this.plugin.settings.thinkingLevel || "")
          .onChange(async (value) => {
            this.plugin.settings.thinkingLevel = value;
            await this.plugin.saveSettings();

            // 联动更新聊天视图 — 走 View 统一的 Pi 权威同步入口。
            const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
            for (const leaf of leaves) {
              const view = leaf.view as any;
              if (view) {
                if (typeof view.updateActiveTabThinkingLevel === "function") {
                  try {
                    await view.updateActiveTabThinkingLevel(value);
                  } catch (err) {
                    console.warn("[pimate] updateActiveTabThinkingLevel failed in settings:", err);
                  }
                } else if (view.client && typeof view.client.setThinkingLevel === "function") {
                  await view.client.setThinkingLevel(value);
                  if (view.footerEffortCurrent) {
                    view.footerEffortCurrent.setText(view.getThinkingLevelLabel(value));
                  }
                }
              }
            }
          })
      );



    new Setting(containerEl)
      .setName(isZh ? "大模型凭证配置 (LLM Credentials)" : "LLM Credentials")
      .setHeading();

    // 读取 auth.json 的当前内容
    const authPath = this.getAuthJsonPath();
    let authData: Record<string, any> = {};
    if (fs.existsSync(authPath)) {
      try {
        const content = fs.readFileSync(authPath, "utf-8");
        authData = JSON.parse(content) || {};
      } catch (e) {
        console.error("读取 auth.json 失败:", e);
      }
    }

    // 读取 models.json 的自定义 provider
    const customProviders = this.readModelsJson();

    // 已配好凭证的 provider id（auth.json 里有 key 或 oauth）
    const configuredIds = Object.keys(authData).filter(id => {
      const item = authData[id];
      return item && (item.type === "oauth" || (item.key && item.key.trim()));
    });

    // ─── 栏 1：内置 Provider（配 key 即用）───────────────────────────────
    new Setting(containerEl)
      .setName(isZh ? "内置 Provider（配 key 即用）" : "Built-in Providers (key only)")
      .setDesc(isZh
        ? "这些服务商 Pi 原生支持，填入 API Key 或完成 OAuth 即可使用。未列出的内置 provider 也可通过环境变量配置。"
        : "Pi natively supports these providers — just add an API Key or complete OAuth. Other built-in providers can also be used via environment variables.")
      .setHeading();

    // 决定要显示哪些内置 provider：已配置的 + 临时添加的，并集
    const builtinIdsToShow = Array.from(new Set([
      ...BUILTIN_PROVIDERS.map(p => p.id).filter(id => configuredIds.includes(id)),
      ...this.temporaryProviders.filter(id => this.isBuiltinProvider(id))
    ]));

    if (builtinIdsToShow.length === 0) {
      containerEl.createEl("p", {
        text: isZh ? "尚未配置任何内置 provider。在下方选择一个添加。" : "No built-in provider configured yet. Add one below.",
        cls: "setting-item-description"
      });
    } else {
      // 按内置清单顺序渲染
      for (const p of BUILTIN_PROVIDERS) {
        if (!builtinIdsToShow.includes(p.id)) continue;
        this.renderBuiltinCredentialRow(containerEl, p, authData, authPath, isZh);
      }
      // 临时添加但不在内置清单里的（理论上不该有，容错）
      for (const id of builtinIdsToShow) {
        if (this.isBuiltinProvider(id)) continue;
        // 极少数情况：temporaryProviders 里混入了未知 id，按自定义样式渲染
      }
    }

    // "+ 添加内置 provider" 下拉：从内置清单里选未显示的
    const unconfiguredBuiltin = BUILTIN_PROVIDERS.filter(p => !builtinIdsToShow.includes(p.id));
    if (unconfiguredBuiltin.length > 0) {
      let selectedBuiltinAdd = unconfiguredBuiltin[0].id;
      new Setting(containerEl)
        .setName(isZh ? "+ 添加内置 Provider" : "+ Add Built-in Provider")
        .setDesc(isZh ? "选择一个未配置的内置服务商并点击添加。" : "Select an unconfigured built-in provider to add.")
        .addDropdown(dropdown => {
          for (const p of unconfiguredBuiltin) {
            dropdown.addOption(p.id, p.name);
          }
          dropdown.setValue(selectedBuiltinAdd).onChange(val => { selectedBuiltinAdd = val; });
        })
        .addButton(btn => {
          btn.setButtonText(isZh ? "添加" : "Add").setCta().onClick(() => {
            this.temporaryProviders.push(selectedBuiltinAdd);
            // 记录刚添加的 id，renderBuiltinCredentialRow 会给该行
            // settingEl 上加 data-just-added 属性
            this.justAddedBuiltinId = selectedBuiltinAdd;
            this.display();
            window.setTimeout(() => {
              const target = containerEl.querySelector(
                "[data-just-added='true'] input[type='password']"
              ) as HTMLInputElement | null;
              if (target) {
                target.focus();
              } else {
                // 兑底：fall back 到该 setting 里的 input（防止某些 provider
                // 不产生 password input，如 OAuth）
                const anyInput = containerEl.querySelector(
                  "[data-just-added='true'] input"
                ) as HTMLInputElement | null;
                if (anyInput) anyInput.focus();
              }
              this.justAddedBuiltinId = null;
            }, 50);
          });
        });
    }

    // ─── 栏 2：自定义 Provider（来自 models.json）─────────────────────────
    new Setting(containerEl)
      .setName(isZh ? "自定义 Provider（来自 models.json）" : "Custom Providers (models.json)")
      .setDesc(isZh
        ? "这些服务商在 ~/.pi/agent/models.json 中定义（如硅基流动、火山引擎等 Pi 不内置的服务）。点击“添加”可使用向导生成配置。"
        : "Defined in ~/.pi/agent/models.json (e.g. SiliconFlow, Volcengine — providers Pi doesn't ship built-in). Use the wizard to add one.")
      .setHeading();

    const customIds = Object.keys(customProviders).filter(id => !this.isBuiltinProvider(id));
    // 也显示已配 key 但未在内置清单里的（可能是用户手动加的自定义 provider）
    const extraConfigured = configuredIds.filter(id => !this.isBuiltinProvider(id) && !customIds.includes(id));
    const allCustomIds = Array.from(new Set([...customIds, ...extraConfigured, ...this.temporaryProviders.filter(id => !this.isBuiltinProvider(id))]));

    if (allCustomIds.length === 0) {
      containerEl.createEl("p", {
        text: isZh ? "暂无自定义 provider。点击下方按钮使用向导添加。" : "No custom providers yet. Use the button below to add one via wizard.",
        cls: "setting-item-description"
      });
    } else {
      for (const id of allCustomIds) {
        this.renderCustomProviderRow(containerEl, id, customProviders, authData, isZh);
      }
    }

    // "+ 添加自定义 provider" 按钮 → 打开向导
    new Setting(containerEl)
      .setName(isZh ? "+ 添加自定义 Provider（向导）" : "+ Add Custom Provider (Wizard)")
      .setDesc(isZh
        ? "打开向导填表生成 models.json 配置，适配硅基流动/火山引擎/OpenAI 兼容端点等。"
        : "Open a wizard to generate models.json config for SiliconFlow/Volcengine/OpenAI-compatible endpoints.")
      .addButton(btn => {
        btn.setButtonText(isZh ? "打开向导" : "Open Wizard").setCta().onClick(() => {
          new CustomProviderWizardModal(this.app, isZh, async (config) => {
            this.applyCustomProviderConfig(config, isZh);
          }).open();
        });
      });

    // ─── 默认服务商下拉已在上文动态化：内置 ∪ 自定义 ──────────────────

    new Setting(containerEl)
      .setName(isZh ? "提示词默认设置" : "Prompt Defaults")
      .setHeading();

    new Setting(containerEl)
      .setName(isZh ? "系统提示词" : "System prompt")
      .setDesc(
        isZh
          ? "每次普通对话前自动附加的固定要求，例如中文写作风格、语气、工作流规则。"
          : "Optional instruction prepended to each normal Pimate prompt."
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(
            isZh
              ? "例如：你是我的 Obsidian 写作助手，输出中文，风格克制、直接，不要营销感。"
              : "e.g. You are my helpful Obsidian assistant. Keep answers direct and clear."
          )
          .setValue(this.plugin.settings.systemPrompt || "")
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
        text.inputEl.addClass("pi-agent-textarea-full-width");
      });

    new Setting(containerEl)
      .setName(isZh ? "常用指令片段" : "Snippets")
      .setDesc(
        isZh
          ? "一行一个。支持 标题::提示词 或 分组/标题::提示词，以及变量 {{selection}}, {{current_file}}, {{current_title}}, {{date}}。"
          : "One per line with optional names, groups, and variables. Supports Title::Prompt or Group/Title::Prompt."
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(
            isZh
              ? "改写/克制::请把 {{selection}} 改得更克制，不要营销感\n总结/三点::请总结成 3 个要点\n压缩到 300 字"
              : "Rewrite/Concise::Please rewrite {{selection}} to be more concise\nSummarize/Keypoints::Summarize into 3 key points"
          )
          .setValue((this.plugin.settings.snippets || []).join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.snippets = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
        text.inputEl.addClass("pi-agent-textarea-full-width");
      });

    // UI Options
    new Setting(containerEl)
      .setName(isZh ? "显示选项" : "Display Options")
      .setHeading();



    new Setting(containerEl)
      .setName(isZh ? "自动滚动" : "Auto-scroll")
      .setDesc(
        isZh
          ? "有新内容时自动滚动到底部。"
          : "Automatically scroll to bottom when new content arrives."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoScroll)
          .onChange(async (value) => {
            this.plugin.settings.autoScroll = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "流式渲染模式" : "Streaming render mode")
      .setDesc(
        isZh
          ? "Auto 推荐：短输出保持原来的 Markdown 美观流式，长输出自动切换为极速模式以减少卡顿。"
          : "Auto recommended: pretty Markdown streaming for short output, fast plain streaming for long output."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", isZh ? "自动 Auto（推荐）" : "Auto (recommended)")
          .addOption("pretty", isZh ? "美观 Pretty（原版体验）" : "Pretty (original feel)")
          .addOption("fast", isZh ? "极速 Fast（长输出最快）" : "Fast (best for long output)")
          .setValue(this.plugin.settings.streamingRenderMode || "auto")
          .onChange(async (value) => {
            this.plugin.settings.streamingRenderMode = value as "auto" | "pretty" | "fast";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "显示思考过程" : "Show thinking")
      .setDesc(
        isZh
          ? "在聊天中显示模型 thinking/reasoning 块。"
          : "Display model thinking/reasoning blocks in the chat."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showThinking !== false)
          .onChange(async (value) => {
            this.plugin.settings.showThinking = value;
            await this.plugin.saveSettings();
            for (const leaf of this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)) {
              void (leaf.view as any)?.refreshThinkingVisibility?.();
            }
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "智能审核" : "Smart review")
      .setDesc(
        isZh
          ? "开启后，Agent 会在长任务中自检结果并尝试优化后再输出。"
          : "When enabled, the agent self-checks long tasks and improves the result before replying."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.smartReviewEnabled === true)
          .onChange(async (value) => {
            this.plugin.settings.smartReviewEnabled = value;
            await this.plugin.saveSettings();
            for (const leaf of this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)) {
              void (leaf.view as any)?.refreshSmartReviewToggle?.();
            }
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "智能审核最大自动继续次数" : "Smart review max auto-continue")
      .setDesc(
        isZh
          ? "开关开启时，Agent 结束后插件最多自动继续的次数。范围 1-10。"
          : "When smart review is on, max auto-continue turns after the agent ends. Range 1-10."
      )
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.plugin.settings.smartReviewMaxContinues ?? 3))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1 && num <= 10) {
              this.plugin.settings.smartReviewMaxContinues = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "最大历史显示数量" : "Max history display")
      .setDesc(
        isZh
          ? "聊天区最多显示多少条消息，旧消息会隐藏。"
          : "Maximum number of messages to show in chat; older messages are hidden."
      )
      .addSlider((slider) =>
        slider
          .setLimits(10, 500, 10)
          .setValue(this.plugin.settings.maxHistoryDisplay)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxHistoryDisplay = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "最大会话卡数量" : "Max session tabs")
      .setDesc(
        isZh
          ? "固定展示在顶部的会话卡 (Tab 1, 2, 3) 数量。修改后立即重构顶栏。"
          : "The number of static tabs (1, 2, 3, etc.) displayed in the header."
      )
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.plugin.settings.maxTabs ?? 3))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0 && num <= 20) {
              this.plugin.settings.maxTabs = num;
              await this.plugin.saveSettings();
              const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
              if (leaves.length > 0) {
                const view = leaves[0].view as any;
                if (view && typeof view.setupStaticTabs === "function") {
                  await view.setupStaticTabs();
                }
              }
            }
          })
      );

    // ─── 技能管理 (Skills Management) ───────────────────────────────────
    new Setting(containerEl)
      .setName(isZh ? "技能管理 (Skills Management)" : "Skills Management")
      .setHeading();

    const skills = this.scanSkills();
    const projectSkills = skills.filter(s => s.scope === "project");
    const globalSkills = skills.filter(s => s.scope === "global");

    if (skills.length === 0) {
      containerEl.createEl("p", {
        text: isZh ? "当前未检测到任何技能扩展 (如 SKILL.md)。可以使用下方输入框安装新技能。" : "No skills detected. You can install new skills below.",
        cls: "setting-item-description"
      });
    } else {
      if (projectSkills.length > 0) {
        new Setting(containerEl)
          .setName(isZh ? "项目本地技能 (Project Skills)" : "Project Skills")
          .setHeading();
        for (const skill of projectSkills) {
          this.createSkillSetting(containerEl, skill, isZh);
        }
      }

      if (globalSkills.length > 0) {
        new Setting(containerEl)
          .setName(isZh ? "全局安装技能 (Global Skills)" : "Global Skills")
          .setHeading();
        for (const skill of globalSkills) {
          this.createSkillSetting(containerEl, skill, isZh);
        }
      }
    }

    // 安装新技能
    let installPkgName = "";
    let installScope: "global" | "project" = "project";

    new Setting(containerEl)
      .setName(isZh ? "+ 安装新技能" : "+ Install New Skill")
      .setDesc(isZh ? "输入 skills.sh 技能包名，选择安装位置并点击安装。" : "Enter package name from skills.sh, select scope and click install.")
      .addText(text => {
        text.setPlaceholder("e.g. brave-search")
          .onChange(val => {
            installPkgName = val.trim();
          });
      })
      .addDropdown(dropdown => {
        dropdown.addOption("project", isZh ? "项目本地 (Project)" : "Project")
          .addOption("global", isZh ? "全局 (Global)" : "Global")
          .setValue(installScope)
          .onChange((val: string) => {
            installScope = val as "global" | "project";
          });
      })
      .addButton(btn => {
        btn.setButtonText(isZh ? "安装" : "Install")
          .setCta()
          .onClick(() => {
            if (!installPkgName) {
              new Notice(isZh ? "请输入技能包名！" : "Please enter package name!");
              return;
            }

            btn.setDisabled(true);
            btn.setButtonText(isZh ? "正在安装..." : "Installing...");
            new Notice(isZh ? `开始安装技能 ${installPkgName}...` : `Starting installation of ${installPkgName}...`);

            this.installSkill(installPkgName, installScope, (err, output) => {
              btn.setDisabled(false);
              btn.setButtonText(isZh ? "安装" : "Install");

              if (err) {
                new Notice(isZh ? `安装失败：${err}` : `Installation failed: ${err}`);
                console.error("技能安装失败：", err, output);
              } else {
                new Notice(isZh ? `技能 ${installPkgName} 安装成功！` : `Skill ${installPkgName} installed successfully!`);
                this.display(); // 刷新渲染
              }
            });
          });
      });
  }

  // 渲染单个内置 provider 的凭证行（复用原有 key 输入/OAuth/断开逻辑）
  private renderBuiltinCredentialRow(
    containerEl: HTMLElement,
    p: BuiltinProvider,
    authData: Record<string, any>,
    authPath: string,
    isZh: boolean
  ): void {
    const id = p.id;
    const item = authData[id];
    const isOauth = item && item.type === "oauth";
    const isConfigured = !!(item && (item.type === "oauth" || (item.key && item.key.trim())));

    const setting = new Setting(containerEl)
      .setName(p.name)
      .setDesc(isOauth
        ? (isZh ? "OAuth 已授权 / Connected" : "OAuth Authorized")
        : (isConfigured
          ? (isZh ? `API 密钥已配置 / Connected${p.envVar ? "  ·  环境变量 " + p.envVar : ""}` : `API Key configured${p.envVar ? "  ·  env " + p.envVar : ""}`)
          : (isZh ? `等待配置 API 密钥${p.envVar ? "  ·  环境变量 " + p.envVar : ""}` : `Awaiting API Key${p.envVar ? "  ·  env " + p.envVar : ""}`)));

    // 如果是刚被点击「添加」的 provider，标记该行以便 display() 后定位
    if (this.justAddedBuiltinId === id) {
      setting.settingEl.dataset.justAdded = "true";
    }

    if (isOauth) {
      setting.addButton(btn => {
        btn.setButtonText(isZh ? "断开连接" : "Disconnect");
        btn.buttonEl.addClass("mod-warning");
        btn.onClick(() => {
          void (async () => {
            delete authData[id];
            fs.writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
            this.temporaryProviders = this.temporaryProviders.filter(pId => pId !== id);
            this.display();
            const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
            for (const leaf of leaves) {
              const view = leaf.view as any;
              if (view && view.client) await view.client.restart();
            }
          })().catch((err: unknown) => {
            console.error("[pimate] disconnect provider failed", err);
            new Notice(err instanceof Error ? err.message : String(err));
          });
        });
      });
      return;
    }

    // OAuth 类型（openai-codex）提供 Device Code 登录按钮
    if (p.oauth && id === "openai-codex") {
      setting.addButton(btn => {
        btn.setButtonText(isZh ? "Device Code 登录" : "Device Code Login").setCta().onClick(() => {
          void this.startOpenAICodexDeviceCodeLogin().catch((err: unknown) => {
            console.error("[pimate] device-code login failed", err);
            new Notice(err instanceof Error ? err.message : String(err));
          });
        });
      });
    }

    // 普通 API Key 输入框
    setting.addText(text => {
      let tempValue = "";
      text.setPlaceholder(isConfigured ? (isZh ? "输入新密钥以替换..." : "Enter new key to replace...") : "sk-...")
          .onChange((val) => { tempValue = val.trim(); });
      text.inputEl.type = "password";
      text.inputEl.addClass("pi-agent-input-api-key");

      const saveValue = async () => {
        if (tempValue) {
          this.writeApiKey(id, tempValue);
          this.temporaryProviders = this.temporaryProviders.filter(pId => pId !== id);
          this.display();
          const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
          for (const leaf of leaves) {
            const view = leaf.view as any;
            if (view && view.client) await view.client.restart();
          }
        }
      };
      text.inputEl.addEventListener("blur", () => void saveValue());
      text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); void saveValue(); }
      });
    });

    setting.addButton(btn => {
      btn.setButtonText(isZh ? "断开连接" : "Disconnect");
      btn.buttonEl.addClass("mod-warning");
      btn.onClick(() => {
        void (async () => {
          delete authData[id];
          fs.writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
          this.temporaryProviders = this.temporaryProviders.filter(pId => pId !== id);
          this.display();
          const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
          for (const leaf of leaves) {
            const view = leaf.view as any;
            if (view && view.client) await view.client.restart();
          }
        })().catch((err: unknown) => {
          console.error("[pimate] disconnect provider failed", err);
          new Notice(err instanceof Error ? err.message : String(err));
        });
      });
    });
  }

  // 渲染单个自定义 provider 的行（显示模型数量+列表+删除）
  private renderCustomProviderRow(
    containerEl: HTMLElement,
    id: string,
    customProviders: Record<string, any>,
    authData: Record<string, any>,
    isZh: boolean
  ): void {
    const prov = customProviders[id] || {};
    const models: any[] = Array.isArray(prov.models) ? prov.models : [];
    const modelCount = models.length;
    const baseUrl = prov.baseUrl || "";
    const apiType = prov.api || "";
    const hasKey = !!(authData[id] && authData[id].key);

    const descParts: string[] = [];
    if (baseUrl) descParts.push(baseUrl);
    if (apiType) descParts.push(`api: ${apiType}`);
    descParts.push(isZh ? `${modelCount} 个模型` : `${modelCount} model${modelCount === 1 ? "" : "s"}`);
    descParts.push(hasKey ? (isZh ? "key 已配置" : "key set") : (isZh ? "⚠ 未配 key" : "⚠ no key"));

    const setting = new Setting(containerEl)
      .setName(id + (hasKey ? "" : " ⚠"))
      .setDesc(descParts.join("  ·  "));

    // 如果有模型，额外展开模型列表
    if (modelCount > 0) {
      const modelListEl = setting.descEl.createEl("div", { cls: "pi-agent-custom-model-list" });
      for (const m of models) {
        const mid = typeof m === "string" ? m : (m.id || "");
        const mname = typeof m === "object" && m.name ? m.name : "";
        const item = modelListEl.createEl("div", { cls: "pi-agent-custom-model-item" });
        item.createEl("span", { cls: "pi-agent-custom-model-id", text: mid });
        if (mname && mname !== mid) {
          item.createEl("span", { cls: "pi-agent-custom-model-name", text: mname });
        }
        if (typeof m === "object" && m.reasoning) {
          item.createEl("span", { cls: "pi-agent-custom-model-tag", text: isZh ? "推理" : "reasoning" });
        }
      }
    }

    // API Key 输入（写入 auth.json）
    setting.addText(text => {
      let tempValue = "";
      text.setPlaceholder(hasKey ? (isZh ? "输入新密钥以替换..." : "Enter new key to replace...") : "sk-...")
          .onChange((val) => { tempValue = val.trim(); });
      text.inputEl.type = "password";
      text.inputEl.addClass("pi-agent-input-api-key");
      const saveValue = async () => {
        if (tempValue) {
          this.writeApiKey(id, tempValue);
          this.display();
          const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
          for (const leaf of leaves) {
            const view = leaf.view as any;
            if (view && view.client) await view.client.restart();
          }
        }
      };
      text.inputEl.addEventListener("blur", () => void saveValue());
      text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); void saveValue(); }
      });
    });

    // 删除按钮（从 models.json 和 auth.json 同时删除）
    setting.addButton(btn => {
      btn.setButtonText(isZh ? "删除" : "Delete");
      btn.buttonEl.addClass("mod-warning");
      btn.onClick(() => {
        const confirmed = window.confirm(isZh
          ? `确定删除自定义 provider “${id}”？\n将从 models.json 和 auth.json 中移除该 provider。`
          : `Delete custom provider "${id}"?\nIt will be removed from both models.json and auth.json.`);
        if (!confirmed) return;
        void (async () => {
          const providers = this.readModelsJson();
          delete providers[id];
          this.writeModelsJson(providers);
          // 同步删 auth.json
          const aPath = this.getAuthJsonPath();
          if (fs.existsSync(aPath)) {
            try {
              const a = JSON.parse(fs.readFileSync(aPath, "utf-8")) || {};
              delete a[id];
              fs.writeFileSync(aPath, JSON.stringify(a, null, 2), "utf-8");
            } catch (e) { console.error("清理 auth.json 失败:", e); }
          }
          this.temporaryProviders = this.temporaryProviders.filter(pId => pId !== id);
          this.display();
          const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
          for (const leaf of leaves) {
            const view = leaf.view as any;
            if (view && view.client) await view.client.restart();
          }
        })().catch((err: unknown) => {
          console.error("[pimate] delete custom provider failed", err);
          new Notice(err instanceof Error ? err.message : String(err));
        });
      });
    });
  }

  // 应用向导生成的自定义 provider 配置（写入 models.json + auth.json）
  private applyCustomProviderConfig(config: CustomProviderConfig, isZh: boolean): void {
    const providers = this.readModelsJson();

    // 构造 provider 对象
    const prov: Record<string, any> = {
      baseUrl: config.baseUrl.trim(),
      api: config.apiType,
    };
    // API Key：写入 auth.json，models.json 里用 $ENV 占位或直接写 key
    const apiKey = config.apiKey.trim();
    if (apiKey) {
      // 直接把 key 写进 models.json（最简单可靠，跟 siliconflow 现状一致）
      prov.apiKey = apiKey;
      // 同时写 auth.json 以便 UI 显示已配置
      this.writeApiKey(config.providerId, apiKey);
    }
    // compat 选项
    if (config.supportsDeveloperRole === false) {
      prov.compat = { ...(prov.compat || {}), supportsDeveloperRole: false };
    }
    // 模型列表
    prov.models = config.models.filter(m => m.id.trim());

    providers[config.providerId] = prov;
    this.writeModelsJson(providers);

    new Notice(isZh
      ? `已添加自定义 provider “${config.providerId}”到 models.json。重启 Pimate 生效。`
      : `Custom provider "${config.providerId}" added to models.json. Restart Pimate to apply.`);

    this.display();

    // 联动重启聊天视图
    const leaves = this.app.workspace.getLeavesOfType("pimate-chat-view");
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view && view.client) {
        void view.client.restart().catch((e: unknown) => console.error("[pimate] restart failed", e));
      }
    }
  }

  // 辅助渲染单个技能项目
  private createSkillSetting(containerEl: HTMLElement, skill: DiscoveredSkill, isZh: boolean): void {
    const homeDir = os.homedir();
    let displayPath = skill.filePath;

    if (displayPath.startsWith(homeDir)) {
      displayPath = "~" + displayPath.slice(homeDir.length);
    }

    const adapter = this.app.vault.adapter as any;
    const basePath = adapter.basePath || "";
    if (basePath && displayPath.startsWith(basePath)) {
      displayPath = "." + displayPath.slice(basePath.length);
    }

    const desc = `${skill.description || (isZh ? "无描述" : "No description")}\n(${displayPath})`;

    new Setting(containerEl)
      .setName(skill.name)
      .setDesc(desc)
      .addToggle(toggle => {
        toggle.setValue(!skill.disabled)
          .onChange(async (val) => {
            this.toggleSkill(skill.filePath, !val);
            new Notice(isZh ? `技能已${val ? "启用" : "禁用"}` : `Skill ${val ? "enabled" : "disabled"}`);
          });
      });
  }

  // ─── Device Code Login (OpenAI Codex) ────────────────────────────────
  //
  // We invoke AuthStorage.login() directly from the @earendil-works/pi-coding-agent
  // package. We never go through the Pi RPC (no `oauth_login` RPC exists).
  //
  // The flow:
  //  1. Open the device-code modal (with Cancel button).
  //  2. Start AuthStorage.login("openai-codex", { onDeviceCode, onProgress, ... })
  //     which resolves once the user finishes in the browser.
  //  3. When the modal receives the device code info, it shows the code +
  //     "Open browser" + "Copy code" actions.
  //  4. On success, persist the credentials are written to ~/.pi/agent/auth.json
  //     and Pimate auto-restarts the chat client's child process so the new
  //     token is picked up immediately.

  private async startOpenAICodexDeviceCodeLogin(): Promise<void> {
    const isZh = this.plugin.settings.language === "zh";
    const modal = new OpenAICodexDeviceCodeModal(this.app);
    modal.open();
    const controller = new AbortController();
    modal.onCancelSignal = () => controller.abort();

    try {
      // 1) Request user code
      modal.setProgress(
        isZh ? "正在请求 device code..." : "Requesting device code..."
      );
      const device = await this.requestOpenAICodexUserCode(controller.signal);
      modal.setDeviceCode({
        userCode: device.userCode,
        verificationUri: OPENAI_CODEX_VERIFICATION_URI,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: OPENAI_CODEX_TIMEOUT_SECONDS,
      });

      // 2) Poll for authorization_code
      modal.setProgress(
        isZh ? "等待你在浏览器中完成授权..." : "Waiting for browser authorization..."
      );
      const { authorizationCode, codeVerifier } = await this.pollOpenAICodexDeviceAuth(
        device,
        controller.signal,
        (message) => modal.setProgress(message)
      );

      // 3) Exchange authorization code for tokens
      modal.setProgress(
        isZh ? "交换 access token..." : "Exchanging authorization code for tokens..."
      );
      const tokens = await this.exchangeOpenAICodexAuthorizationCode(
        authorizationCode,
        codeVerifier,
        controller.signal
      );

      // 4) Persist to ~/.pi/agent/auth.json
      this.writeApiKey("openai-codex", JSON.stringify({
        type: "oauth",
        refresh: tokens.refresh,
        access: tokens.access,
        expires: tokens.expires,
      }));

      modal.closeWithSuccess();
      new Notice(
        isZh ? "OpenAI Codex 订阅登录成功！" : "OpenAI Codex subscription connected!"
      );

      // Refresh settings to show new "已配置" status
      this.display();

      // Restart the chat client's Pi child process so the new token is used
      const leaves = this.app.workspace.getLeavesOfType(
        PI_AGENT_VIEW_TYPE as any
      );
      for (const leaf of leaves) {
        const view = (leaf as any).view;
        if (view && view.client) {
          try {
            await view.client.restart();
          } catch (err) {
            console.error(
              "[pimate] failed to restart client after OAuth login",
              err
            );
          }
        }
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      if (!controller.signal.aborted) {
        new Notice(
          isZh ? `登录失败：${message}` : `Login failed: ${message}`,
          8000
        );
      }
      modal.closeWithError(message);
    }
  }

  private async requestOpenAICodexUserCode(
    signal: AbortSignal
  ): Promise<{
    deviceAuthId: string;
    userCode: string;
    intervalSeconds: number;
  }> {
    if (signal.aborted) throw new Error("Login cancelled");
    const response = await requestUrl({
      url: OPENAI_CODEX_DEVICE_USER_CODE_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 404) {
        throw new Error(
          "OpenAI Codex device code login is not enabled. Please try again later."
        );
      }
      throw new Error(
        `OpenAI Codex device code request failed: ${response.status} ${response.text}`
      );
    }
    const json = response.json as Record<string, unknown>;
    const deviceAuthId = json.device_auth_id as string | undefined;
    const userCode = json.user_code as string | undefined;
    const rawInterval = json.interval;
    const intervalSeconds =
      typeof rawInterval === "string"
        ? Number(rawInterval.trim())
        : (rawInterval as number);
    if (
      !deviceAuthId ||
      !userCode ||
      typeof intervalSeconds !== "number" ||
      !Number.isFinite(intervalSeconds) ||
      intervalSeconds < 0
    ) {
      throw new Error(
        `Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`
      );
    }
    return { deviceAuthId, userCode, intervalSeconds };
  }

  private async pollOpenAICodexDeviceAuth(
    device: { deviceAuthId: string; userCode: string; intervalSeconds: number },
    signal: AbortSignal,
    onProgress: (message: string) => void
  ): Promise<{ authorizationCode: string; codeVerifier: string }> {
    const MINIMUM_INTERVAL_MS = 1000;
    const SLOW_DOWN_INCREMENT_MS = 5000;
    const deadline = Date.now() + OPENAI_CODEX_TIMEOUT_SECONDS * 1000;
    let intervalMs = Math.max(
      MINIMUM_INTERVAL_MS,
      Math.floor((device.intervalSeconds || 5) * 1000)
    );
    let attempt = 0;

    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new Error("Login cancelled");
      }

      attempt++;
      onProgress(
        `Polling… attempt ${attempt} (${Math.round((Date.now() - (deadline - OPENAI_CODEX_TIMEOUT_SECONDS * 1000)) / 1000)}s)`
      );

      let pollResult: {
        status: "complete" | "pending" | "slow_down" | "failed";
        value?: { authorizationCode: string; codeVerifier: string };
        message?: string;
      };

      try {
        const response = await requestUrl({
          url: OPENAI_CODEX_DEVICE_TOKEN_URL,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_auth_id: device.deviceAuthId,
            user_code: device.userCode,
          }),
          throw: false,
        });

        if (response.status >= 200 && response.status < 300) {
          const json = response.json as Record<string, unknown>;
          const authorizationCode = json.authorization_code as
            | string
            | undefined;
          const codeVerifier = json.code_verifier as string | undefined;
          if (!authorizationCode || !codeVerifier) {
            pollResult = {
              status: "failed",
              message: `Invalid OpenAI Codex device auth response: ${JSON.stringify(json)}`,
            };
          } else {
            pollResult = {
              status: "complete",
              value: { authorizationCode, codeVerifier },
            };
          }
        } else if (response.status === 403 || response.status === 404) {
          // Auth server says: still pending (no body needed)
          pollResult = { status: "pending" };
        } else {
          const responseBody = response.text || "";
          let errorCode: string | undefined;
          try {
            const parsed = JSON.parse(responseBody);
            const errField = parsed?.error;
            errorCode =
              typeof errField === "object"
                ? (errField as any)?.code
                : (errField as string | undefined);
          } catch {
            // body not JSON
          }
          if (errorCode === "deviceauth_authorization_pending") {
            pollResult = { status: "pending" };
          } else if (errorCode === "slow_down") {
            pollResult = { status: "slow_down" };
          } else {
            pollResult = {
              status: "failed",
              message: `OpenAI Codex device auth failed (${response.status}): ${responseBody}`,
            };
          }
        }
      } catch (err) {
        if (signal.aborted) throw new Error("Login cancelled");
        // Network blip — treat as pending and back off slightly
        pollResult = { status: "pending" };
        console.warn("[pimate] device code poll network error", err);
      }

      if (pollResult.status === "complete") {
        return pollResult.value!;
      }
      if (pollResult.status === "failed") {
        throw new Error(pollResult.message || "Login failed");
      }
      if (pollResult.status === "slow_down") {
        // RFC 8628 section 3.5: extend interval by 5s, capped at MINIMUM_INTERVAL_MS
        intervalMs = Math.max(
          MINIMUM_INTERVAL_MS,
          intervalMs + SLOW_DOWN_INCREMENT_MS
        );
        onProgress(
          `Server asked us to slow down. Next poll in ${Math.round(intervalMs / 1000)}s.`
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await this.sleep(Math.min(intervalMs, remainingMs), signal);
    }
    throw new Error("OpenAI Codex device code timed out");
  }

  private async exchangeOpenAICodexAuthorizationCode(
    authorizationCode: string,
    codeVerifier: string,
    signal: AbortSignal
  ): Promise<{ access: string; refresh: string; expires: number }> {
    if (signal.aborted) throw new Error("Login cancelled");
    const response = await requestUrl({
      url: OPENAI_CODEX_TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
      }).toString(),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `OpenAI Codex token exchange failed: ${response.status} ${response.text}`
      );
    }
    const json = response.json as Record<string, unknown>;
    const access = json.access_token as string | undefined;
    const refresh = json.refresh_token as string | undefined;
    const expiresIn = json.expires_in as number | undefined;
    if (!access || !refresh || typeof expiresIn !== "number") {
      throw new Error(
        `OpenAI Codex token exchange response missing fields: ${JSON.stringify(
          json
        )}`
      );
    }
    return {
      access,
      refresh,
      expires: Date.now() + expiresIn * 1000,
    };
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Login cancelled"));
        return;
      }
      const t = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        window.clearTimeout(t);
        reject(new Error("Login cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ─── 自定义 Provider 向导 ────────────────────────────────────────────────────

interface CustomProviderConfig {
  providerId: string;       // 如 "siliconflow"
  displayName?: string;     // 如 "硅基流动"（可选，仅提示用）
  baseUrl: string;          // 如 "https://api.siliconflow.cn/v1"
  apiType: string;          // openai-completions / anthropic-messages / ...
  apiKey: string;           // 可为空
  supportsDeveloperRole?: boolean;  // 默认 true；false 时添加 compat
  models: { id: string; name?: string; reasoning?: boolean }[];
}

class CustomProviderWizardModal extends Modal {
  private isZh: boolean;
  private onSubmit: (config: CustomProviderConfig) => void;

  // 表单字段
  private idInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private baseUrlInput!: HTMLInputElement;
  private apiTypeSelect!: HTMLSelectElement;
  private apiKeyInput!: HTMLInputElement;
  private devRoleCheckbox!: HTMLInputElement;
  private modelsTextarea!: HTMLTextAreaElement;

  constructor(app: App, isZh: boolean, onSubmit: (config: CustomProviderConfig) => void) {
    super(app);
    this.isZh = isZh;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-wizard-modal");
    this.titleEl.setText(this.isZh ? "添加自定义 Provider" : "Add Custom Provider");

    const t = (zh: string, en: string) => (this.isZh ? zh : en);

    // 说明
    contentEl.createEl("p", {
      text: t(
        "填写以下字段生成 ~/.pi/agent/models.json 配置。适用于硅基流动、火山引擎、OpenAI 兼容端点等 Pi 不内置的服务商。",
        "Fill in the fields below to generate ~/.pi/agent/models.json config. For providers Pi doesn't ship built-in (SiliconFlow, Volcengine, OpenAI-compatible endpoints, etc.)."
      ),
      cls: "setting-item-description"
    });

    // Provider ID
    this.addField(t("Provider ID", "Provider ID"), t("如 siliconflow（英文标识符）", "e.g. siliconflow"), "text", "siliconflow", el => this.idInput = el as HTMLInputElement);

    // 显示名（可选）
    this.addField(t("显示名（可选）", "Display name (optional)"), t("如 硅基流动", "e.g. SiliconFlow"), "text", "", el => this.nameInput = el as HTMLInputElement);

    // Base URL
    this.addField(t("Base URL", "Base URL"), t("如 https://api.siliconflow.cn/v1", "e.g. https://api.siliconflow.cn/v1"), "text", "https://api.siliconflow.cn/v1", el => this.baseUrlInput = el as HTMLInputElement);

    // API 协议
    const apiRow = contentEl.createDiv({ cls: "pi-agent-wizard-field" });
    apiRow.createEl("label", { text: t("API 协议", "API protocol"), cls: "pi-agent-wizard-label" });
    this.apiTypeSelect = apiRow.createEl("select", { cls: "dropdown pi-agent-wizard-select" });
    const apiTypes = [
      { id: "openai-completions", name: t("OpenAI Chat Completions（最常用）", "OpenAI Chat Completions (most common)") },
      { id: "anthropic-messages", name: t("Anthropic Messages", "Anthropic Messages") },
      { id: "openai-responses", name: "OpenAI Responses" },
      { id: "google-generative-ai", name: "Google Generative AI" },
    ];
    for (const at of apiTypes) this.apiTypeSelect.createEl("option", { value: at.id, text: at.name });
    this.apiTypeSelect.value = "openai-completions";
    apiRow.createEl("div", { text: t("大多数 OpenAI 兼容服务选第一项。", "Most OpenAI-compatible services use the first option."), cls: "setting-item-description" });

    // API Key
    this.addField(t("API Key", "API Key"), t("可留空，稍后在列表里填。", "Optional; can fill in later in the list."), "password", "", el => this.apiKeyInput = el as HTMLInputElement);

    // compat: supportsDeveloperRole
    const compatRow = contentEl.createDiv({ cls: "pi-agent-wizard-field" });
    this.devRoleCheckbox = compatRow.createEl("input", { type: "checkbox" });
    this.devRoleCheckbox.checked = true;
    compatRow.createEl("label", {
      text: t("支持 developer role", "Supports developer role"),
      cls: "pi-agent-wizard-label"
    });
    compatRow.createEl("div", {
      text: t(
        "若服务商不认 OpenAI 的 developer role（如硅基流动会报 400），取消勾选此项。默认勾选。",
        "Uncheck if the provider rejects OpenAI's developer role (e.g. SiliconFlow returns 400). Checked by default."
      ),
      cls: "setting-item-description"
    });

    // 模型列表
    const modelRow = contentEl.createDiv({ cls: "pi-agent-wizard-field" });
    modelRow.createEl("label", {
      text: t("模型列表（每行一个）", "Models (one per line)"),
      cls: "pi-agent-wizard-label"
    });
    this.modelsTextarea = modelRow.createEl("textarea", { cls: "pi-agent-wizard-textarea" });
    this.modelsTextarea.rows = 5;
    this.modelsTextarea.placeholder = t(
      "deepseek-ai/DeepSeek-V4-Flash\nzai-org/GLM-5.2 | GLM-5.2\ndeepseek-ai/DeepSeek-V4-Pro | DeepSeek V4 Pro | reasoning",
      "deepseek-ai/DeepSeek-V4-Flash\nzai-org/GLM-5.2 | GLM-5.2\ndeepseek-ai/DeepSeek-V4-Pro | DeepSeek V4 Pro | reasoning"
    );
    modelRow.createEl("div", {
      text: t(
        "格式：模型ID  或  模型ID | 显示名  或  模型ID | 显示名 | reasoning",
        "Format: model-id  or  model-id | display name  or  model-id | display name | reasoning"
      ),
      cls: "setting-item-description"
    });

    // 按钮
    const btnRow = contentEl.createDiv({ cls: "pi-agent-wizard-buttons" });
    const cancelBtn = btnRow.createEl("button", { text: t("取消", "Cancel") });
    cancelBtn.onclick = () => this.close();
    const submitBtn = btnRow.createEl("button", { text: t("生成配置", "Generate"), cls: "mod-cta" });
    submitBtn.onclick = () => this.handleSubmit();
  }

  private addField(
    label: string,
    placeholder: string,
    type: string,
    defaultValue: string,
    register: (el: HTMLInputElement) => void
  ): void {
    const row = this.contentEl.createDiv({ cls: "pi-agent-wizard-field" });
    row.createEl("label", { text: label, cls: "pi-agent-wizard-label" });
    const input = row.createEl("input", { type, cls: "text-input pi-agent-wizard-input" });
    input.placeholder = placeholder;
    input.value = defaultValue;
    register(input);
  }

  private handleSubmit(): void {
    const id = this.idInput.value.trim();
    const baseUrl = this.baseUrlInput.value.trim();
    const apiType = this.apiTypeSelect.value;
    const apiKey = this.apiKeyInput.value.trim();
    const supportsDeveloperRole = this.devRoleCheckbox.checked;
    const displayName = this.nameInput.value.trim();

    if (!id) {
      new Notice(this.isZh ? "Provider ID 不能为空" : "Provider ID is required");
      this.idInput.focus();
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      new Notice(this.isZh ? "Provider ID 只能含字母数字、下划线、连字符" : "Provider ID may only contain letters, digits, _ and -");
      this.idInput.focus();
      return;
    }
    if (!baseUrl) {
      new Notice(this.isZh ? "Base URL 不能为空" : "Base URL is required");
      this.baseUrlInput.focus();
      return;
    }

    // 解析模型列表
    const models: { id: string; name?: string; reasoning?: boolean }[] = [];
    const lines = this.modelsTextarea.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split("|").map(s => s.trim());
      const mid = parts[0];
      if (!mid) continue;
      const m: { id: string; name?: string; reasoning?: boolean } = { id: mid };
      if (parts[1]) m.name = parts[1];
      if (parts.includes("reasoning") || parts.includes("推理")) m.reasoning = true;
      models.push(m);
    }
    if (models.length === 0) {
      new Notice(this.isZh ? "至少需要一个模型" : "At least one model is required");
      this.modelsTextarea.focus();
      return;
    }

    this.onSubmit({
      providerId: id,
      displayName: displayName || undefined,
      baseUrl,
      apiType,
      apiKey,
      supportsDeveloperRole,
      models
    });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class OpenAICodexDeviceCodeModal extends Modal {
  private statusEl!: HTMLElement;
  private codeEl!: HTMLElement;
  private linkEl!: HTMLElement;
  private openBtn!: HTMLButtonElement;
  private copyBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private instructionsEl!: HTMLElement;
  private state: "waiting" | "code" | "browser" | "success" | "error" | "cancelled" =
    "waiting";
  public onCancelSignal: (() => void) | null = null;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-device-code-modal");
    this.titleEl.setText("OpenAI Codex · Device Code");

    this.statusEl = contentEl.createDiv({ cls: "pi-agent-device-code-status" });
    this.statusEl.setText("Requesting device code…");

    this.codeEl = contentEl.createDiv({ cls: "pi-agent-device-code-code" });
    this.codeEl.setText("— — — —");
    this.codeEl.addClass("pi-agent-hidden");

    this.linkEl = contentEl.createEl("a", {
      cls: "pi-agent-device-code-link",
      text: "",
    });
    this.linkEl.setAttribute("target", "_blank");
    this.linkEl.setAttribute("rel", "noopener noreferrer");
    this.linkEl.addClass("pi-agent-hidden");

    this.instructionsEl = contentEl.createDiv({ cls: "pi-agent-device-code-instructions" });
    this.instructionsEl.addClass("pi-agent-hidden");

    const buttonRow = contentEl.createDiv({ cls: "pi-agent-device-code-buttons" });

    this.openBtn = buttonRow.createEl("button", {
      text: "Open verification page",
      cls: "mod-cta",
    });
    this.openBtn.addClass("pi-agent-hidden");
    this.openBtn.onclick = () => {
      if (!this.linkEl.getAttribute("href")) return;
      const url = this.linkEl.getAttribute("href") || "";
      void this.openExternal(url).catch((err: unknown) => {
        console.error("[pimate] open external failed", err);
      });
    };

    this.copyBtn = buttonRow.createEl("button", { text: "Copy code" });
    this.copyBtn.addClass("pi-agent-hidden");
    this.copyBtn.onclick = () => {
      const code = this.codeEl.textContent || "";
      if (!code || code === "— — — —") return;
      void navigator.clipboard.writeText(code).then(() => {
        this.copyBtn.setText("Copied ✓");
        window.setTimeout(() => this.copyBtn.setText("Copy code"), 1500);
      }).catch((err: unknown) => {
        console.error("[pimate] clipboard write failed", err);
      });
    };

    this.cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    this.cancelBtn.onclick = () => {
      this.cancel();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }

  setDeviceCode(info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void {
    this.state = "code";
    this.statusEl.setText(
      "Open the verification page in your browser and enter the code below:"
    );
    this.codeEl.setText(info.userCode);
    this.codeEl.removeClass("pi-agent-hidden");

    this.linkEl.setText(info.verificationUri);
    this.linkEl.setAttribute("href", info.verificationUri);
    this.linkEl.removeClass("pi-agent-hidden");

    this.openBtn.removeClass("pi-agent-hidden");
    this.copyBtn.removeClass("pi-agent-hidden");

    const minutes = info.expiresInSeconds
      ? Math.round(info.expiresInSeconds / 60)
      : null;
    this.instructionsEl.setText(
      minutes
        ? `Code expires in about ${minutes} minute${minutes === 1 ? "" : "s"}.`
        : "Code expires after a few minutes — finish quickly."
    );
    this.instructionsEl.removeClass("pi-agent-hidden");
  }

  setBrowserAuthUrl(url: string, instructions?: string): void {
    this.state = "browser";
    this.statusEl.setText(
      instructions || "A browser-based login URL is available. Open it to continue:"
    );
    this.linkEl.setText(url);
    this.linkEl.setAttribute("href", url);
    this.linkEl.removeClass("pi-agent-hidden");
    this.openBtn.removeClass("pi-agent-hidden");
  }

  setProgress(message: string): void {
    if (this.state === "success" || this.state === "error" || this.state === "cancelled") {
      return;
    }
    this.statusEl.setText(message);
  }

  closeWithSuccess(): void {
    this.state = "success";
    this.statusEl.setText("✓ Connected. Loading credentials…");
    this.openBtn.addClass("pi-agent-hidden");
    this.copyBtn.addClass("pi-agent-hidden");
    this.cancelBtn.setText("Close");
  }

  closeWithError(message: string): void {
    this.state = "error";
    this.statusEl.setText(`✗ ${message || "Login failed"}`);
    this.openBtn.addClass("pi-agent-hidden");
    this.copyBtn.addClass("pi-agent-hidden");
    this.cancelBtn.setText("Close");
  }

  private cancel(): void {
    if (this.state === "success" || this.state === "error" || this.state === "cancelled") {
      this.close();
      return;
    }
    this.state = "cancelled";
    this.statusEl.setText("Cancelling…");
    this.openBtn.addClass("pi-agent-hidden");
    this.copyBtn.addClass("pi-agent-hidden");
    this.cancelBtn.setText("Close");
    this.onCancelSignal?.();
    this.close();
  }

  private async openExternal(url: string): Promise<void> {
    let opened = false;
    try {
      // electron.remote is deprecated; prefer Electron shell when available
      const electron = (window as any).require?.("electron");
      if (electron?.shell?.openExternal) {
        await electron.shell.openExternal(url);
        opened = true;
      }
    } catch (err) {
      console.warn("[pimate] electron shell.openExternal failed, fallback", err);
    }
    if (!opened) {
      try {
        const a = activeDocument.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.click();
      } catch (err) {
        console.error("[pimate] fallback anchor click failed", err);
      }
    }
  }
}
