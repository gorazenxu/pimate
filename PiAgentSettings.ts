import { App, PluginSettingTab, Setting, Notice, Modal } from "obsidian";
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
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
const OPENAI_CODEX_TIMEOUT_SECONDS = 15 * 60;

export interface PersistedSessionTab {
  label: string;
  sessionFile?: string;
  sessionId?: string;
}

export interface PiAgentSettings {
  piPath: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  apiKey: string;
  autoScroll: boolean;
  showThinking: boolean;
  maxHistoryDisplay: number;
  safeMode: boolean;
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
  showThinking: false,
  maxHistoryDisplay: 100,
  safeMode: false,
  sessionTabs: [],
  activeSessionFile: "",
  systemPrompt: "",
  snippets: [],
  language: "zh",
  maxTabs: 3,
  streamingRenderMode: "auto",
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

  constructor(app: App, plugin: PiAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 辅助方法：获取 auth.json 的绝对路径
  private getAuthJsonPath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, ".pi", "agent", "auth.json");
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
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
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
          const clean = raw.replace(/\x1B\[[0-9;]*m/g, "");
          const results: any[] = [];
          const lines = clean.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const pkgMatch = line.match(/^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs)$/);
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

    containerEl.createEl("h2", { text: isZh ? "Pisidian 设置" : "Pisidian Settings" });

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
    // (right-click on file / folder → "Send to Pisidian" or "Add N items to Pisidian context").
    // No hotkey, no internal API dependency.

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

    containerEl.createEl("h3", { text: isZh ? "默认模型配置 (Default Model Configuration)" : "Default Model Configuration" });

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
      "volcengine": {
        model: "",
        desc: isZh ? "需要填写你的火山引擎 Endpoint ID (例如 ep-2026xxxx-xxxx)" : "Need to specify your Volcengine Endpoint ID (e.g. ep-2026xxxx-xxxx)",
        placeholder: "ep-..."
      },
      "google": {
        model: "gemini-2.5-flash",
        desc: isZh ? "推荐: gemini-2.5-flash, gemini-2.5-pro" : "Recommended: gemini-2.5-flash, gemini-2.5-pro",
        placeholder: "gemini-2.5-flash"
      }
    };

    new Setting(containerEl)
      .setName(isZh ? "默认服务商 (Default Provider)" : "Default Provider")
      .setDesc(isZh ? "选择聊天时默认启用的模型服务商。" : "Choose the default model provider for chat sessions.")
      .addDropdown((dropdown) => {
        const providers = [
          { id: "anthropic", name: "Anthropic (Claude)" },
          { id: "openai-codex", name: "OpenAI (GPT / Codex)" },
          { id: "deepseek", name: "DeepSeek" },
          { id: "minimax", name: "MiniMax (国际 / International)" },
          { id: "minimax-cn", name: "MiniMax (国内 / China)" },
          { id: "siliconflow", name: "硅基流动 (SiliconFlow)" },
          { id: "volcengine", name: "火山引擎 / 豆包 (Volcengine / Doubao)" },
          { id: "google", name: "Google (Gemini)" }
        ];

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

            // 联动更新聊天视图
            const leaves = this.app.workspace.getLeavesOfType("pisidian-chat-view");
            for (const leaf of leaves) {
              const view = leaf.view as any;
              if (view) {
                if (view.client && typeof view.client.setModel === "function") {
                  await view.client.setModel(value, this.plugin.settings.modelId);
                }
                if (typeof view.updateModelDisplay === "function") {
                  view.updateModelDisplay(value, this.plugin.settings.modelId);
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

            // 联动更新聊天视图
            const leaves = this.app.workspace.getLeavesOfType("pisidian-chat-view");
            for (const leaf of leaves) {
              const view = leaf.view as any;
              if (view) {
                if (view.client && typeof view.client.setModel === "function") {
                  await view.client.setModel(this.plugin.settings.provider, trimmed);
                }
                if (typeof view.updateModelDisplay === "function") {
                  view.updateModelDisplay(this.plugin.settings.provider, trimmed);
                }
              }
            }
          })
      );

    new Setting(containerEl)
      .setName(isZh ? "默认思考强度 (Default Effort Level)" : "Default Effort Level")
      .setDesc(isZh ? "支持推理模型（如 o1/o3-mini/DeepSeek R1）的思考时长或强度。" : "Configure reasoning effort level for reasoning models.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("", isZh ? "默认 (Pi Default)" : "Pi Default")
          .addOption("off", isZh ? "关闭 (Off)" : "Off")
          .addOption("minimal", isZh ? "最少 (Low (minimal))" : "Minimal (Low (minimal))")
          .addOption("low", isZh ? "低 (Low)" : "Low")
          .addOption("medium", isZh ? "中 (Medium)" : "Medium")
          .addOption("high", isZh ? "高 (High)" : "High")
          .addOption("xhigh", isZh ? "最高 (X-High)" : "X-High")
          .setValue(this.plugin.settings.thinkingLevel || "")
          .onChange(async (value) => {
            this.plugin.settings.thinkingLevel = value;
            await this.plugin.saveSettings();

            // 联动更新聊天视图
            const leaves = this.app.workspace.getLeavesOfType("pisidian-chat-view");
            for (const leaf of leaves) {
              const view = leaf.view as any;
              if (view) {
                if (view.client && typeof view.client.setThinkingLevel === "function") {
                  await view.client.setThinkingLevel(value);
                }
                if (view.footerEffortCurrent) {
                  view.footerEffortCurrent.setText(view.getThinkingLevelLabel(value));
                }
              }
            }
          })
      );



    containerEl.createEl("h3", { text: isZh ? "大模型凭证配置 (LLM Credentials)" : "LLM Credentials" });

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

    const allBuiltin = [
      { id: "anthropic", name: "Anthropic (Claude)" },
      { id: "openai-codex", name: "OpenAI (GPT / Codex)" },
      { id: "deepseek", name: "DeepSeek" },
      { id: "minimax", name: "MiniMax (国际 / International)" },
      { id: "minimax-cn", name: "MiniMax (国内 / China)" },
      { id: "siliconflow", name: "硅基流动 (SiliconFlow)" },
      { id: "volcengine", name: "火山引擎 / 豆包 (Volcengine / Doubao)" },
      { id: "google", name: "Google (Gemini)" }
    ];

    // 已配好的 ID
    const configuredIds = Object.keys(authData).filter(id => {
      const item = authData[id];
      return item && (item.type === "oauth" || (item.key && item.key.trim()));
    });

    // 合并并去重，得出要在列表中显示的所有项
    const displayProviders = Array.from(new Set([...configuredIds, ...this.temporaryProviders]));

    if (displayProviders.length === 0) {
      containerEl.createEl("p", {
        text: isZh ? "当前未配置任何大模型凭据。请在下方选择服务商进行添加。" : "No credentials configured. Add one below.",
        cls: "setting-item-description"
      });
    } else {
      for (const id of displayProviders) {
        const builtin = allBuiltin.find(p => p.id === id);
        const displayName = builtin ? builtin.name : id;
        const item = authData[id];
        const isOauth = item && item.type === "oauth";
        const isConfigured = configuredIds.includes(id);

        const setting = new Setting(containerEl)
          .setName(displayName)
          .setDesc(isOauth ? (isZh ? "OAuth 已授权 / Connected" : "OAuth Authorized") : (isConfigured ? (isZh ? "API 密钥已配置 / Connected" : "API Key configured") : (isZh ? "等待配置 API 密钥" : "Awaiting API Key")));

        if (isOauth) {
          // OAuth 只提供断开连接按钮
          setting.addButton(btn => {
            btn.setButtonText(isZh ? "断开连接" : "Disconnect")
               .setWarning()
               .onClick(async () => {
                 delete authData[id];
                 fs.writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
                 this.temporaryProviders = this.temporaryProviders.filter(pId => pId !== id);
                 this.display();
                 
                 // 联动更新聊天视图并物理重启子进程
                 const leaves = this.app.workspace.getLeavesOfType("pisidian-chat-view");
                 for (const leaf of leaves) {
                   const view = leaf.view as any;
                   if (view && view.client) {
                     await view.client.restart();
                   }
                 }
               });
          });
        } else {
          // 普通 API Key 提供密文输入框和断开连接按钮
          if (id === "openai-codex") {
            setting.addButton(btn => {
              btn.setButtonText(isZh ? "Device Code 登录" : "Device Code Login")
                 .setCta()
                 .onClick(() => this.startOpenAICodexDeviceCodeLogin());
            });
          }

          setting.addText(text => {
            let tempValue = "";
            text.setPlaceholder(isConfigured ? (isZh ? "输入新密钥以替换..." : "Enter new key to replace...") : "sk-...")
                .onChange((val) => {
                  tempValue = val.trim();
                });
            
            text.inputEl.type = "password";
            text.inputEl.style.width = "240px";
            
            // 监听失去焦点和按下回车，在此时才真正保存并刷新列表显示
            const saveValue = async () => {
              if (tempValue) {
                this.writeApiKey(id, tempValue);
                this.temporaryProviders = this.temporaryProviders.filter(pId => pId !== id);
                this.display();
                
                // 联动更新聊天视图
                const leaves = this.app.workspace.getLeavesOfType("pisidian-chat-view");
                for (const leaf of leaves) {
                  const view = leaf.view as any;
                  if (view && view.client) {
                    await view.client.restart();
                  }
                }
              }
            };
            
            text.inputEl.addEventListener("blur", saveValue);
            text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveValue();
              }
            });
          });

          setting.addButton(btn => {
            btn.setButtonText(isZh ? "断开连接" : "Disconnect")
               .setWarning()
               .onClick(async () => {
                 delete authData[id];
                 fs.writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
                 this.temporaryProviders = this.temporaryProviders.filter(pId => pId !== id);
                 this.display();

                 // 联动更新聊天视图
                 const leaves = this.app.workspace.getLeavesOfType("pisidian-chat-view");
                 for (const leaf of leaves) {
                   const view = leaf.view as any;
                   if (view && view.client) {
                     await view.client.restart();
                   }
                 }
               });
          });
        }
      }
    }

    // 渲染“添加服务商”部分
    // 找出未配置的内置服务商
    const unconfigured = allBuiltin.filter(p => !configuredIds.includes(p.id) && !this.temporaryProviders.includes(p.id));

    if (unconfigured.length > 0) {
      let selectedAddId = unconfigured[0].id;
      
      new Setting(containerEl)
        .setName(isZh ? "+ 添加服务商凭证" : "+ Add Provider Credentials")
        .setDesc(isZh ? "选择未配置的服务商并点击添加" : "Select an unconfigured provider to configure")
        .addDropdown(dropdown => {
          for (const p of unconfigured) {
            dropdown.addOption(p.id, p.name);
          }
          dropdown.setValue(selectedAddId)
                  .onChange(val => {
                    selectedAddId = val;
                  });
        })
        .addButton(btn => {
          btn.setButtonText(isZh ? "添加" : "Add")
             .setCta()
             .onClick(() => {
               this.temporaryProviders.push(selectedAddId);
               this.display();
               // 找到刚才添加的那个 input 元素并 focus！
               setTimeout(() => {
                 const inputs = containerEl.querySelectorAll("input[type='password']");
                 if (inputs.length > 0) {
                   const lastInput = inputs[inputs.length - 1] as HTMLInputElement;
                   lastInput.focus();
                 }
               }, 50);
             });
        });
    }

    containerEl.createEl("h3", { text: isZh ? "提示词默认设置" : "Prompt Defaults" });

    new Setting(containerEl)
      .setName(isZh ? "系统提示词" : "System prompt")
      .setDesc(
        isZh
          ? "每次普通对话前自动附加的固定要求，例如中文写作风格、语气、工作流规则。"
          : "Optional instruction prepended to each normal Pisidian prompt."
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
        text.inputEl.style.width = "100%";
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
        text.inputEl.style.width = "100%";
      });

    // UI Options
    containerEl.createEl("h3", { text: isZh ? "显示选项" : "Display Options" });



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
          .setValue(this.plugin.settings.showThinking)
          .onChange(async (value) => {
            this.plugin.settings.showThinking = value;
            await this.plugin.saveSettings();
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
              const leaves = this.app.workspace.getLeavesOfType("pisidian-chat-view");
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
    containerEl.createEl("h3", { text: isZh ? "技能管理 (Skills Management)" : "Skills Management" });

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
        containerEl.createEl("h4", { text: isZh ? "项目本地技能 (Project Skills)" : "Project Skills" });
        for (const skill of projectSkills) {
          this.createSkillSetting(containerEl, skill, isZh);
        }
      }

      if (globalSkills.length > 0) {
        containerEl.createEl("h4", { text: isZh ? "全局安装技能 (Global Skills)" : "Global Skills" });
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
          .onClick(async () => {
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
  //     and Pisidian auto-restarts the chat client's child process so the new
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
              "[pisidian] failed to restart client after OAuth login",
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
    const response = await fetch(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          "OpenAI Codex device code login is not enabled. Please try again later."
        );
      }
      const text = await response.text().catch(() => "");
      throw new Error(
        `OpenAI Codex device code request failed: ${response.status} ${text}`
      );
    }
    const json = (await response.json()) as Record<string, unknown>;
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
        const response = await fetch(OPENAI_CODEX_DEVICE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_auth_id: device.deviceAuthId,
            user_code: device.userCode,
          }),
          signal,
        });

        if (response.ok) {
          const json = (await response.json()) as Record<string, unknown>;
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
          const responseBody = await response.text().catch(() => "");
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
        console.warn("[pisidian] device code poll network error", err);
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
    const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
      }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OpenAI Codex token exchange failed: ${response.status} ${text}`
      );
    }
    const json = (await response.json()) as Record<string, unknown>;
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
    this.codeEl.style.display = "none";

    this.linkEl = contentEl.createEl("a", {
      cls: "pi-agent-device-code-link",
      text: "",
    });
    this.linkEl.setAttribute("target", "_blank");
    this.linkEl.setAttribute("rel", "noopener noreferrer");
    this.linkEl.style.display = "none";

    this.instructionsEl = contentEl.createDiv({ cls: "pi-agent-device-code-instructions" });
    this.instructionsEl.style.display = "none";

    const buttonRow = contentEl.createDiv({ cls: "pi-agent-device-code-buttons" });

    this.openBtn = buttonRow.createEl("button", {
      text: "Open verification page",
      cls: "mod-cta",
    });
    this.openBtn.style.display = "none";
    this.openBtn.onclick = async () => {
      if (!this.linkEl.getAttribute("href")) return;
      const url = this.linkEl.getAttribute("href") || "";
      await this.openExternal(url);
    };

    this.copyBtn = buttonRow.createEl("button", { text: "Copy code" });
    this.copyBtn.style.display = "none";
    this.copyBtn.onclick = async () => {
      const code = this.codeEl.textContent || "";
      if (!code || code === "— — — —") return;
      try {
        await navigator.clipboard.writeText(code);
        this.copyBtn.setText("Copied ✓");
        window.setTimeout(() => this.copyBtn.setText("Copy code"), 1500);
      } catch (err) {
        console.error("[pisidian] clipboard write failed", err);
      }
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
    this.codeEl.style.display = "";

    this.linkEl.setText(info.verificationUri);
    this.linkEl.setAttribute("href", info.verificationUri);
    this.linkEl.style.display = "";

    this.openBtn.style.display = "";
    this.copyBtn.style.display = "";

    const minutes = info.expiresInSeconds
      ? Math.round(info.expiresInSeconds / 60)
      : null;
    this.instructionsEl.setText(
      minutes
        ? `Code expires in about ${minutes} minute${minutes === 1 ? "" : "s"}.`
        : "Code expires after a few minutes — finish quickly."
    );
    this.instructionsEl.style.display = "";
  }

  setBrowserAuthUrl(url: string, instructions?: string): void {
    this.state = "browser";
    this.statusEl.setText(
      instructions || "A browser-based login URL is available. Open it to continue:"
    );
    this.linkEl.setText(url);
    this.linkEl.setAttribute("href", url);
    this.linkEl.style.display = "";
    this.openBtn.style.display = "";
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
    this.openBtn.style.display = "none";
    this.copyBtn.style.display = "none";
    this.cancelBtn.setText("Close");
  }

  closeWithError(message: string): void {
    this.state = "error";
    this.statusEl.setText(`✗ ${message || "Login failed"}`);
    this.openBtn.style.display = "none";
    this.copyBtn.style.display = "none";
    this.cancelBtn.setText("Close");
  }

  private cancel(): void {
    if (this.state === "success" || this.state === "error" || this.state === "cancelled") {
      this.close();
      return;
    }
    this.state = "cancelled";
    this.statusEl.setText("Cancelling…");
    this.openBtn.style.display = "none";
    this.copyBtn.style.display = "none";
    this.cancelBtn.setText("Close");
    this.onCancelSignal?.();
    this.close();
  }

  private async openExternal(url: string): Promise<void> {
    let opened = false;
    try {
      // electron.remote is deprecated; prefer require("electron") in main process
      const electron = (window as any).require?.("electron");
      if (electron?.shell?.openExternal) {
        await electron.shell.openExternal(url);
        opened = true;
      }
    } catch (err) {
      console.warn("[pisidian] electron shell.openExternal failed, fallback", err);
    }
    if (!opened) {
      try {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.click();
      } catch (err) {
        console.error("[pisidian] fallback anchor click failed", err);
      }
    }
  }
}
