import { query, accessToken } from "@qoder-ai/qoder-agent-sdk";

if (process.env.QODER_SPIKE_LIVE !== "1") {
  console.error(
    "Refusing to run: live probe requires explicit owner approval.\n" +
      "Set QODER_SPIKE_LIVE=1 and QODER_PERSONAL_ACCESS_TOKEN=<token> (credit cap agreed: 10 credits) to run.",
  );
  process.exit(2);
}
const token = process.env.QODER_PERSONAL_ACCESS_TOKEN;
if (!token) {
  console.error("QODER_PERSONAL_ACCESS_TOKEN is not set.");
  process.exit(2);
}

const CREDIT_CAP = 10;
const denied = [];

const q = query({
  prompt:
    "You have a Bash tool available. Run `whoami` with it. If you cannot, reply with the single word: DENIED",
  options: {
    auth: accessToken(token),
    tools: [],
    disallowedTools: ["Bash", "Read", "Edit", "Write"],
    permissionMode: "default",
    persistSession: false,
    settingSources: [],
    maxTurns: 1,
    canUseTool: async (toolName) => {
      denied.push(toolName);
      return { behavior: "deny", message: "shell tools are out of product bounds" };
    },
    stderr: () => {},
  },
});

let initTools = null;
let finalResult = null;
for await (const message of q) {
  if (message.type === "system" && message.subtype === "init") {
    initTools = message.tools;
    console.log(`system/init.tools = ${JSON.stringify(initTools)}`);
    console.log(`system/init.mcp_servers = ${JSON.stringify(message.mcp_servers)}`);
  }
  if (message.type === "result") {
    finalResult = message;
    console.log(`result.subtype = ${message.subtype}`);
    console.log(`result.result = ${JSON.stringify(message.result ?? null)}`);
    console.log(`result.total_credits = ${message.total_credits ?? null}`);
    console.log(`result.permission_denials = ${JSON.stringify(message.permission_denials)}`);
  }
}

const usage = await q.getUsageInfo().catch(() => null);
console.log(`getUsageInfo() = ${JSON.stringify(usage)}`);
await q.close();

const failures = [];
if (initTools === null) failures.push("no system/init frame observed");
else if (initTools.length !== 0) failures.push(`init.tools not empty: ${JSON.stringify(initTools)}`);
if (denied.length > 0) console.log(`canUseTool denied: ${JSON.stringify(denied)}`);
if (finalResult?.total_credits != null && finalResult.total_credits > CREDIT_CAP) {
  failures.push(`credit cap exceeded: ${finalResult.total_credits} > ${CREDIT_CAP}`);
}

if (failures.length > 0) {
  console.error("FAILURES:\n" + failures.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}
console.log("PROBE PASS: CLI-side tools:[] enforcement confirmed with empty init.tools.");
