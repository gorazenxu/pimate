import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  entryPoints: [`${root}AgyAgentClient.ts`],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const compiled = new Module(`${root}agy-models-effort-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle.outputFiles[0].text, `${root}agy-models-effort-test.cjs`);
const {
  AgyAgentClient,
  buildAgyModelMeta,
  buildAgyThinkingLevelMap,
  clampAgyEffortForModel,
  formatAgyModelDisplayName,
  getAgyModelEffortLevels,
  groupAgyModelsByFamily,
  isAgyFixedEffortModel,
  parseAgyModelEffortSuffix,
  parseAgyModelsOutput,
  pickAgyTitleModel,
  resolveAgyFamilyVariant,
  resolveAgyOrchestratorAlias,
  resolveAgySpawn,
} = compiled.exports;

const SAMPLE_AGY_MODELS_STDOUT = [
  "\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-high              Gemini 4 Neon (High)",
  "gemini-4-neon-xhigh             Gemini 4 Neon (XHigh)",
  "gemini-4-neon-medium            Gemini 4 Neon (Medium)",
  "gemini-4-neon-low               Gemini 4 Neon (Low)",
  "gemini-4-argon-medium           Gemini 4 Argon (Medium)",
  "gemini-4-argon-high             Gemini 4 Argon (High)",
  "gemini-4-argon-low              Gemini 4 Argon (Low)",
  "gemini-pro-orchestrator-neon    Orchestrator (Neon)",
  "gpt-oss-120b-medium             GPT-OSS 120B (Medium)",
].join("\n");

test("parseAgyModelsOutput strips spinner prefixes and derives per-family effort maps", () => {
  const models = parseAgyModelsOutput(SAMPLE_AGY_MODELS_STDOUT);
  const byId = new Map(models.map((m) => [m.id, m]));

  assert.ok(byId.has("gemini-4-neon-high"), "first model ID must not include spinner prefix");
  assert.equal(byId.get("gemini-4-neon-high").name, "Gemini 4 Neon (High)");

  assert.deepEqual(byId.get("gemini-4-neon-xhigh").thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  });
  assert.deepEqual(byId.get("gemini-4-argon-medium").thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
  });
  assert.deepEqual(byId.get("gpt-oss-120b-medium").thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: "medium",
    high: null,
  });
  assert.equal(byId.get("gemini-pro-orchestrator-neon").reasoning, false);
  assert.deepEqual(byId.get("gemini-pro-orchestrator-neon").thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
  });
});

test("Windows CRLF and spinner frames preserve model rows", () => {
  const output = "⠋ Fetching models\r\u280b Fetching models\rgemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\r\n";
  assert.deepEqual(parseAgyModelsOutput(output).map(m => m.id), ["gemini-3.8-flash-high", "gpt-oss-120b-medium"]);
});

test("without a verified catalog model IDs are never fabricated", () => {
  assert.deepEqual(clampAgyEffortForModel("custom-model", "high", []), { modelId: "custom-model", effort: "high" });
  assert.deepEqual(clampAgyEffortForModel("custom-model-low", "high", []), { modelId: "custom-model-low", effort: "low" });
  assert.deepEqual(clampAgyEffortForModel("gpt-oss-120b-medium", "high", []), { modelId: "gpt-oss-120b-medium", effort: "medium" });
});

test("parseAgyModelEffortSuffix recognizes xhigh and max suffixes", () => {
  assert.deepEqual(parseAgyModelEffortSuffix("gemini-4-neon-xhigh"), {
    baseId: "gemini-4-neon",
    effort: "xhigh",
  });
  assert.deepEqual(parseAgyModelEffortSuffix("custom-model-max"), {
    baseId: "custom-model",
    effort: "max",
  });
  assert.equal(parseAgyModelEffortSuffix("gemini-pro-orchestrator-neon"), null);
  assert.equal(isAgyFixedEffortModel("gemini-pro-orchestrator-neon"), true);
  assert.equal(isAgyFixedEffortModel("gemini-4-neon-xhigh"), false);
  assert.deepEqual(buildAgyThinkingLevelMap(["low", "medium", "high", "xhigh"]), {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  });
});

test("resolveLaunchSelection never emits conflicting --effort for -xhigh or Orchestrator", async () => {
  const originalGetModels = AgyAgentClient.getAvailableModels;
  AgyAgentClient.getAvailableModels = async () => parseAgyModelsOutput(SAMPLE_AGY_MODELS_STDOUT);
  try {
    const neonClient = new AgyAgentClient({
      modelId: "gemini-4-neon-xhigh",
      effort: "medium",
      trackUsage: false,
    });
    const neonLaunch = await neonClient.resolveLaunchSelection();
    assert.equal(neonLaunch.effortArg, undefined);
    assert.equal(neonLaunch.modelId, "gemini-4-neon-medium");
    assert.equal(neonLaunch.effectiveEffort, "medium");

    // Explicit setModel to -xhigh aligns currentEffort to xhigh so launch keeps -xhigh.
    await neonClient.setModel("antigravity", "gemini-4-neon-xhigh");
    const explicitXhighLaunch = await neonClient.resolveLaunchSelection();
    assert.equal(explicitXhighLaunch.effortArg, undefined);
    assert.equal(explicitXhighLaunch.modelId, "gemini-4-neon-xhigh");
    assert.equal(explicitXhighLaunch.effectiveEffort, "xhigh");

    // Orchestrator must never receive --effort and rejects setThinkingLevel.
    const orchClient = new AgyAgentClient({
      modelId: "gemini-pro-orchestrator-neon",
      effort: "high",
      trackUsage: false,
    });
    const orchLaunch = await orchClient.resolveLaunchSelection();
    assert.equal(orchLaunch.effortArg, undefined);
    assert.equal(orchLaunch.modelId, "gemini-pro-orchestrator-neon");
    assert.equal(orchLaunch.effectiveEffort, "");
    const orchEffortRes = await orchClient.setThinkingLevel("high");
    assert.equal(orchEffortRes.success, false);

    // Unsupported Pi-only levels (off / minimal) are rejected for AGY.
    const offRes = await neonClient.setThinkingLevel("off");
    assert.equal(offRes.success, false);
    const minimalRes = await neonClient.setThinkingLevel("minimal");
    assert.equal(minimalRes.success, false);
  } finally {
    AgyAgentClient.getAvailableModels = originalGetModels;
  }
});

test("groupAgyModelsByFamily deduplicates effort variants and resolves preferred effort", () => {
  const models = parseAgyModelsOutput(SAMPLE_AGY_MODELS_STDOUT);
  const families = groupAgyModelsByFamily(models);
  assert.deepEqual(
    families.map((f) => [f.baseId, f.name, f.levels]),
    [
      ["gemini-4-neon", "Gemini 4 Neon", ["low", "medium", "high", "xhigh"]],
      ["gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
      ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)", []],
      ["gpt-oss-120b", "GPT-OSS 120B", ["medium"]],
    ]
  );

  const neon = families[0];
  const argon = families[1];
  const orch = families[2];
  assert.equal(resolveAgyFamilyVariant(neon, "xhigh"), "gemini-4-neon-xhigh");
  assert.equal(resolveAgyFamilyVariant(argon, "xhigh"), "gemini-4-argon-high");
  assert.equal(resolveAgyFamilyVariant(argon, "medium"), "gemini-4-argon-medium");
  assert.equal(resolveAgyFamilyVariant(orch, "high"), "gemini-pro-orchestrator-neon");

  assert.equal(formatAgyModelDisplayName("gemini-4-neon-xhigh", models), "Gemini 4 Neon");
  assert.equal(formatAgyModelDisplayName("gemini-4-argon-medium", models), "Gemini 4 Argon");
  assert.equal(formatAgyModelDisplayName("gemini-pro-orchestrator-neon", models), "Orchestrator (Neon)");
  assert.equal(formatAgyModelDisplayName("gemini-4-hydrogen-xhigh"), "Gemini 4 Hydrogen");

  assert.deepEqual(getAgyModelEffortLevels("gemini-4-neon", models), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(getAgyModelEffortLevels("gemini-4-argon", models), ["low", "medium", "high"]);
  assert.deepEqual(getAgyModelEffortLevels("gpt-oss-120b", models), ["medium"]);
  assert.deepEqual(getAgyModelEffortLevels("gemini-pro-orchestrator-neon", models), []);

  assert.deepEqual(clampAgyEffortForModel("gemini-4-argon", "xhigh", models), {
    modelId: "gemini-4-argon-high",
    effort: "high",
  });
  assert.deepEqual(clampAgyEffortForModel("gpt-oss-120b", "high", models), {
    modelId: "gpt-oss-120b-medium",
    effort: "medium",
  });
  assert.deepEqual(clampAgyEffortForModel("gemini-pro-orchestrator-neon", "high", models), {
    modelId: "gemini-pro-orchestrator-neon",
    effort: "",
  });
  assert.equal(buildAgyModelMeta("gemini-pro-orchestrator-neon", models).reasoning, false);
});

test("unsuffixed models never receive an unsupported leftover effort", async () => {
  const client = new AgyAgentClient({ modelId: "claude-sonnet-4-6", effort: "xhigh", trackUsage: false });
  const launch = await client.resolveLaunchSelection();
  assert.equal(launch.modelId, "claude-sonnet-4-6");
  assert.equal(launch.effortArg, "high");
});

test("Orchestrator cross-plan aliases display cleanly and resolve at launch", async () => {
  assert.equal(formatAgyModelDisplayName("gemini-pro-orchestrator-argon"), "Orchestrator (Argon)");
  assert.equal(formatAgyModelDisplayName("gemini-pro-orchestrator-g1-pro"), "Orchestrator (Argon)");
  assert.equal(formatAgyModelDisplayName("gemini-pro-orchestrator-carbon"), "Orchestrator (Carbon)");
  assert.equal(formatAgyModelDisplayName("gemini-pro-orchestrator"), "Orchestrator");

  const ultraModels = parseAgyModelsOutput([
    "gemini-pro-orchestrator-neon   Orchestrator (Neon)",
    "gemini-pro-orchestrator        Orchestrator (Carbon)",
    "gemini-pro-orchestrator-argon  Orchestrator (Argon)",
  ].join("\n"));
  const proModels = parseAgyModelsOutput([
    "gemini-pro-orchestrator-neon    Orchestrator (Neon)",
    "gemini-pro-orchestrator-g1-pro  Orchestrator (Argon)",
  ].join("\n"));

  assert.equal(resolveAgyOrchestratorAlias("gemini-pro-orchestrator-g1-pro", ultraModels), "gemini-pro-orchestrator-argon");
  assert.equal(resolveAgyOrchestratorAlias("gemini-pro-orchestrator-argon", proModels), "gemini-pro-orchestrator-g1-pro");
  assert.equal(resolveAgyOrchestratorAlias("gemini-pro-orchestrator-carbon", ultraModels), "gemini-pro-orchestrator");

  const originalGetModels = AgyAgentClient.getAvailableModels;
  AgyAgentClient.clearModelsCache();
  AgyAgentClient.getAvailableModels = async () => ultraModels;
  try {
    const client = new AgyAgentClient({
      modelId: "gemini-pro-orchestrator-g1-pro",
      effort: "high",
      trackUsage: false,
    });
    const launch = await client.resolveLaunchSelection();
    assert.equal(launch.modelId, "gemini-pro-orchestrator-argon");
    assert.equal(launch.effortArg, undefined);
  } finally {
    AgyAgentClient.getAvailableModels = originalGetModels;
    AgyAgentClient.clearModelsCache();
  }
});

test("resolveAgySpawn on win32 avoids .cmd shims and locates .exe", () => {
  const winOptions = {
    platform: "win32",
    pathValue: "C:\\Users\\demo\\bin;C:\\Program Files\\agy",
    localAppData: "C:\\Users\\demo\\AppData\\Local",
    userProfile: "C:\\Users\\demo",
    exists: (p) =>
      p === "C:\\Users\\demo\\bin\\agy.cmd" ||
      p === "C:\\Users\\demo\\AppData\\Local\\Programs\\agy\\agy.exe",
  };
  assert.deepEqual(resolveAgySpawn("agy", winOptions), {
    cmd: "C:\\Users\\demo\\AppData\\Local\\Programs\\agy\\agy.exe",
    scriptArgs: [],
  });
  assert.deepEqual(
    resolveAgySpawn("C:\\tools\\agy.cmd", {
      platform: "win32",
      exists: (p) => p === "C:\\tools\\agy.cmd" || p === "C:\\tools\\agy.exe",
    }),
    { cmd: "C:\\tools\\agy.exe", scriptArgs: [] }
  );
  assert.equal(
    resolveAgySpawn("C:\\tools\\agy.cmd", { platform: "win32", exists: () => false }).cmd.endsWith(".cmd"),
    false
  );
});

test("pickAgyTitleModel prefers lightweight flash/hydrogen models and avoids Orchestrator", () => {
  const models = parseAgyModelsOutput(SAMPLE_AGY_MODELS_STDOUT);
  assert.deepEqual(pickAgyTitleModel(models, "gemini-pro-orchestrator-neon", "high"), {
    modelId: "gemini-4-neon-low",
    effort: "low",
  });

  const withFlash = parseAgyModelsOutput([
    SAMPLE_AGY_MODELS_STDOUT,
    "gemini-3.8-flash-low   Gemini 3.8 Flash (Low)",
    "gemini-3.8-flash-high  Gemini 3.8 Flash (High)",
  ].join("\n"));
  assert.deepEqual(pickAgyTitleModel(withFlash, "gemini-pro-orchestrator-neon", "high"), {
    modelId: "gemini-3.8-flash-low",
    effort: "low",
  });

  // Never fabricate unverified IDs when cache is empty.
  assert.deepEqual(pickAgyTitleModel(null, "custom-model", "high"), {
    modelId: "custom-model",
    effort: "high",
  });
});

test("getAvailableModels coalesces concurrent probes, caches for TTL, and supports clearModelsCache", async () => {
  let execCalls = 0;
  const fakeBundle = await build({
    entryPoints: [`${root}AgyAgentClient.ts`],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["child_process"],
    logLevel: "silent",
  });
  const mod = new Module(`${root}agy-models-cache-test.cjs`);
  mod.paths = Module._nodeModulePaths(root);
  const origRequire = mod.require.bind(mod);
  mod.require = (name) => {
    if (name !== "child_process") return origRequire(name);
    const cp = origRequire("child_process");
    return {
      ...cp,
      execFile: (_cmd, args, _opts, cb) => {
        execCalls++;
        setTimeout(() => {
          if (args.includes("--version")) cb(null, "1.5.15\n", "");
          else cb(null, "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n", "");
        }, 10);
      },
    };
  };
  mod._compile(fakeBundle.outputFiles[0].text, `${root}agy-models-cache-test.cjs`);
  const { AgyAgentClient: IsolatedClient } = mod.exports;

  const [a, b, status] = await Promise.all([
    IsolatedClient.getAvailableModels("agy"),
    IsolatedClient.getAvailableModels("agy"),
    IsolatedClient.checkAuthStatus("agy"),
  ]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(status.authenticated, true);
  // 1 `agy models` call shared across all three + 1 `agy --version` call.
  assert.equal(execCalls, 2);

  // Subsequent call hits 30s TTL cache.
  const c = await IsolatedClient.getAvailableModels("agy");
  assert.equal(c.length, 1);
  assert.equal(execCalls, 2);

  // clearModelsCache invalidates cache for the next call.
  IsolatedClient.clearModelsCache();
  await IsolatedClient.getAvailableModels("agy");
  assert.equal(execCalls, 3);
});
