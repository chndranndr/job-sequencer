import test from "node:test";
import assert from "node:assert/strict";
import { buildServer, startServer } from "../src/server/app.js";

test("Fastify health route returns a smoke response", async () => {
  const app = await buildServer();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, service: "personal-job-search" });
  await app.close();
});

test("server listens only on loopback", async () => {
  const app = await startServer(0);
  try {
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.equal((address as { address: string }).address, "127.0.0.1");
  } finally {
    await app.close();
  }
});
