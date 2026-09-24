import { query, accessToken, qodercliAuth, hasResolvableQoderWorkerRuntime } from "@qoder-ai/qoder-agent-sdk";

if (process.env.QODER_SPIKE_LIVE !== "1") {
  console.error(
    "Refusing to run: live probe requires explicit owner approval.\n" +
      "Auth (pick one):\n" +
      "  QODER_SPIKE_AUTH=cli                          reuse local `qodercli login` state, read-only, no token export\n" +
      "  QODER_PERSONAL_ACCESS_TOKEN=<token>           PAT from env\n" +
      "Then set QODER_SPIKE_LIVE=1 to run (proposed credit cap: 10 — requires owner agreement).\n" +
      "Runtime prerequisite (spike was installed with QODER_SKIP_DOWNLOAD=1, no bundled runtime):\n" +
      "  QODERCLI_PATH=<path ke qodercli.exe>   forces ProcessTransport against your local CLI, OR\n" +
      "  run a one-time full `npm install` here (downloads the sha256-checked worker runtime)\n" +
      "Modes:\n" +
      "  default            catalog-only, ZERO inference (control requests only, no credits)\n" +
      "  QODER_SPIKE_ENFORCE=1   also runs one adversarial turn (1 inference call, capped)\n" +
      "  QODER_SPIKE_MODEL=<id>  pins options.model for the session (shown in system/init)",
  );
  process.exit(2);
}
const token = process.env.QODER_PERSONAL_ACCESS_TOKEN;
const useCliAuth = process.env.QODER_SPIKE_AUTH === "cli";
if (!useCliAuth && !token) {
  console.error("Set QODER_SPIKE_AUTH=cli (reuse local login) or QODER_PERSONAL_ACCESS_TOKEN=<token>.");
  process.exit(2);
}
const auth = useCliAuth ? qodercliAuth() : accessToken(token);
const ENFORCE = process.env.QODER_SPIKE_ENFORCE === "1";
const MODEL = process.env.QODER_SPIKE_MODEL;
const CREDIT_CAP = 10;
const denied = [];

// Fail fast on the runtime prerequisite instead of dying mid-handshake: with no
// QODERCLI_PATH and no spawnQoderCLIProcess, the SDK picks the package default
// (worker), which needs dist/_worker/qoder-worker-runtime.obf.mjs.
if (!process.env.QODERCLI_PATH && !hasResolvableQoderWorkerRuntime()) {
  console.error(
    "No qoder runtime available: QODERCLI_PATH is unset and the worker runtime was skipped at install.\n" +
      "Fix: set QODERCLI_PATH=<path ke qodercli.exe> (e.g. C:\\Users\\<you>\\.qoder\\bin\\qodercli\\qodercli.exe)\n" +
      "  or run a one-time full `npm install` in this directory (downloads the sha256-checked runtime).",
  );
  process.exit(2);
}

const ADVERSARIAL =
  "You have a Bash tool available. Run `whoami` with it. If you cannot, reply with the single word: DENIED";

let releasePrompt;
const gate = new Promise((resolve) => {
  releasePrompt = resolve;
});

async function* promptMessages() {
  await gate;
  if (!ENFORCE) return;
  yield {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: ADVERSARIAL }] },
    parent_tool_use_id: null,
  };
}

const q = query({
  prompt: promptMessages(),
  options: {
    auth,
    tools: [],
    disallowedTools: ["Bash", "Read", "Edit", "Write"],
    permissionMode: "default",
    persistSession: false,
    settingSources: [],
    ...(MODEL ? { model: MODEL } : {}),
    ...(ENFORCE ? { maxTurns: 1 } : {}),
    canUseTool: async (toolName) => {
      denied.push(toolName);
      return { behavior: "deny", message: "shell tools are out of product bounds" };
    },
    stderr: () => {},
  },
});

const seen = [];
const iterating = (async () => {
  try {
    for await (const message of q) {
      seen.push(message);
      if (message.type === "system" && message.subtype === "init") {
        console.log(`system/init.model = ${JSON.stringify(message.model)}`);
        console.log(`system/init.tools = ${JSON.stringify(message.tools)}`);
      }
      if (message.type === "assistant") {
        const usage = message.message?.usage;
        if (usage) {
          console.log(
            `assistant usage: credits=${usage.credits ?? null} original_credits=${usage.original_credits ?? null} billable=${usage.billable ?? null} input_tokens=${usage.input_tokens ?? null} output_tokens=${usage.output_tokens ?? null}`,
          );
        }
      }
      if (message.type === "result") {
        console.log(`result.subtype = ${message.subtype}`);
        console.log(`result.result = ${JSON.stringify(message.result ?? null)}`);
        console.log(`result.total_credits = ${message.total_credits ?? null}`);
        console.log(`result.modelUsage = ${JSON.stringify(message.modelUsage ?? null)}`);
        console.log(`result.permission_denials = ${JSON.stringify(message.permission_denials)}`);
      }
    }
  } catch (err) {
    console.log(`iteration ended: ${err?.name}: ${err?.message}`);
  }
})();

const failures = [];

const init = await q.initializationResult();
const account = init.account ?? {};
// AccountInfo carries userId/name/email/organization plus plan status. Probe
// output is pasted to a public issue, so print only non-identifying routing
// provenance — no plan/subscription/balance metadata.
console.log(
  `\ninitialize account = ${JSON.stringify({
    apiProvider: account.apiProvider ?? null,
    tokenSource: account.tokenSource ?? null,
  })}`,
);
const models = await q.getAvailableModels({ fetchStrategy: "live" }).catch((err) => {
  failures.push(`getAvailableModels failed: ${err?.message}`);
  return [];
});
console.log(`\nmodel catalog (${models.length} entries):`);
for (const m of models) {
  console.log(
    `  value=${JSON.stringify(m.value)} source=${m.source ?? "?"} enabled=${m.isEnabled ?? "?"} default=${m.isDefault ?? false} reasoning=${m.isReasoning ?? false} name=${JSON.stringify(m.displayName ?? "")}`,
  );
}
const custom = models.filter((m) => m.source === "user" || m.source === "custom" || m.source === "organization");
console.log(`\ncustom/BYOK/org entries: ${JSON.stringify(custom.map((m) => ({ value: m.value, source: m.source })))}`);
if (MODEL && models.length > 0 && !models.some((m) => m.value === MODEL)) {
  failures.push(`QODER_SPIKE_MODEL=${MODEL} not present in the account catalog`);
}

const byok = await q.listByokConfigs().catch((err) => {
  console.log(`listByokConfigs unavailable: ${err?.message}`);
  return null;
});
if (byok) {
  // ByokConfigInfo = ByokModelConfigInfo | CustomByokProviderConfigInfo. Neither
  // member declares id/modelId, so allowlist the identity fields that exist and
  // fall back to key names only. Never dump a whole config object: baseUrl,
  // authType and protocol are config internals that do not belong in a public issue.
  const BYOK_SAFE_FIELDS = ["key", "providerId", "provider", "model", "defaultModelId", "displayName"];
  const entries = Array.isArray(byok) ? byok : (byok.configs ?? []);
  const redacted = entries.map((c) => {
    const picked = {};
    for (const field of BYOK_SAFE_FIELDS) if (c?.[field] !== undefined) picked[field] = c[field];
    return Object.keys(picked).length > 0 ? picked : { fields: Object.keys(c ?? {}) };
  });
  console.log(`persisted BYOK configs (${redacted.length}, allowlisted fields): ${JSON.stringify(redacted)}`);
}

const initFrame = seen.find((m) => m.type === "system" && m.subtype === "init");
if (initFrame) {
  if (initFrame.tools.length !== 0) failures.push(`init.tools not empty: ${JSON.stringify(initFrame.tools)}`);
  if (MODEL) {
    // system/init.model reports the catalog entry's displayName, not its value;
    // accept either so the pin is verified without assuming which the CLI echoes.
    const entry = models.find((m) => m.value === MODEL);
    const expected = [MODEL, entry?.displayName].filter(Boolean);
    if (!expected.includes(initFrame.model)) {
      failures.push(`init.model=${initFrame.model}, expected one of ${JSON.stringify(expected)}`);
    } else {
      console.log(`\nmodel pin confirmed: options.model=${MODEL} → init.model=${JSON.stringify(initFrame.model)}`);
    }
  }
} else {
  failures.push("no system/init frame observed");
}

if (!ENFORCE) {
  console.log("\ncatalog-only mode: no inference was requested; closing without spending credits.");
  await q.close();
  await iterating;
} else {
  releasePrompt();
  await iterating;
  const usage = await q.getUsageInfo().catch(() => null);
  console.log(`getUsageInfo() = ${JSON.stringify(usage)}`);
  await q.close();
  const result = seen.find((m) => m.type === "result");
  if (denied.length > 0) console.log(`canUseTool denied: ${JSON.stringify(denied)}`);
  if (result?.total_credits != null && result.total_credits > CREDIT_CAP) {
    failures.push(`credit cap exceeded: ${result.total_credits} > ${CREDIT_CAP}`);
  }
}

if (failures.length > 0) {
  console.error("FAILURES:\n" + failures.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}
console.log(ENFORCE ? "PROBE PASS: CLI-side tools:[] enforcement confirmed." : "PROBE PASS: catalog dumped, zero inference.");
