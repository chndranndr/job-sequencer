import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { projectPromptContext } from "../src/server/context.js";
import { runStructured } from "../src/server/structured.js";

const OutputSchema = z.object({ value: z.string().min(1) }).strict();

function queuedExecutor(outputs: string[], prompts: string[]) {
  return async (prompt: string) => {
    prompts.push(prompt);
    const output = outputs.shift();
    if (output === undefined) throw new Error("missing structured-output fixture");
    return output;
  };
}

test("valid JSON succeeds on the first structured attempt", async () => {
  const prompts: string[] = [];
  const result = await runStructured({
    prompt: "Return a value.",
    schema: OutputSchema,
    execute: queuedExecutor(['{"value":"ok"}'], prompts),
  });

  assert.deepEqual(result, { value: "ok" });
  assert.equal(prompts.length, 1);
});

test("JSON wrapped in model prose is extracted before validation", async () => {
  const result = await runStructured({
    prompt: "Return JSON.",
    schema: OutputSchema,
    execute: async () => 'Here is the payload:\n{"value":"extracted"}\nThanks.',
  });
  assert.deepEqual(result, { value: "extracted" });
});

test("prose wrapping on the first attempt still repairs when the extract is invalid", async () => {
  const prompts: string[] = [];
  const result = await runStructured({
    prompt: "Return a value.",
    schema: OutputSchema,
    execute: queuedExecutor(["Sure:\n{\"other\":\"wrong\"}\n", '{"value":"repaired"}'], prompts),
  });
  assert.deepEqual(result, { value: "repaired" });
  assert.equal(prompts.length, 2);
});

test("malformed JSON triggers a repair attempt with the prior output", async () => {
  const prompts: string[] = [];
  const result = await runStructured({
    prompt: "Return a value.",
    schema: OutputSchema,
    execute: queuedExecutor(["not JSON", '{"value":"repaired"}'], prompts),
  });

  assert.deepEqual(result, { value: "repaired" });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /prior output failed validation/i);
  assert.match(prompts[1]!, /not JSON/);
});

test("schema errors are included in the repair context", async () => {
  const prompts: string[] = [];
  await runStructured({
    prompt: "Return a value.",
    schema: OutputSchema,
    execute: queuedExecutor(['{"other":"wrong"}', '{"value":"fixed"}'], prompts),
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /value/i);
});

test("business validation errors trigger a repair attempt", async () => {
  const prompts: string[] = [];
  const result = await runStructured({
    prompt: "Return an accepted value.",
    schema: OutputSchema,
    execute: queuedExecutor(['{"value":"rejected"}', '{"value":"accepted"}'], prompts),
    validateBusiness: (value) => {
      if (value.value !== "accepted") throw new Error("business rule rejected value");
    },
  });

  assert.deepEqual(result, { value: "accepted" });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /business rule rejected value/);
});

test("provider errors are rethrown without a pointless repair", async () => {
  const providerError = new Error("provider unavailable");
  let calls = 0;

  await assert.rejects(
    () => runStructured({
      prompt: "Return JSON.",
      schema: OutputSchema,
      execute: async () => {
        calls += 1;
        throw providerError;
      },
    }),
    (error: unknown) => error === providerError,
  );
  assert.equal(calls, 1);
});

test("the default attempt ceiling returns a clear structured-output failure", async () => {
  let calls = 0;

  await assert.rejects(
    () => runStructured({
      prompt: "Return JSON.",
      schema: OutputSchema,
      execute: async () => {
        calls += 1;
        return "still invalid";
      },
    }),
    /Structured output failed after 2 attempts/,
  );
  assert.equal(calls, 2);
});

test("prompt context projection is deterministic and bounds nested fields", () => {
  const context = {
    external: { posting: "x".repeat(45_000) },
    profile: "profile",
    generated: { prior: "y".repeat(45_000) },
  };

  const first = projectPromptContext(context);
  const second = projectPromptContext(context);

  assert.deepEqual(first, second);
  assert.ok(JSON.stringify(first).length < JSON.stringify(context).length);
  assert.match(JSON.stringify(first), /\[truncated\]/);
});
