import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeError, createBridgeClient } from "../lib/bridge-client.js";

test("createBridgeClient woła nowe endpointy jobów", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, url, method: opts.method || "GET" }),
    };
  };
  const client = createBridgeClient("http://127.0.0.1:8765/", fetchImpl);

  await client.startJob("sklep test", ["csv", "excel"]);
  await client.job("job/1");
  await client.jobLogs("job/1");
  await client.jobOutputs("job/1");
  await client.listJobs("sklep test");

  assert.equal(calls[0].url, "http://127.0.0.1:8765/projects/sklep%20test/jobs");
  assert.equal(calls[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { export_formats: ["csv", "excel"] });
  assert.equal(calls[1].url, "http://127.0.0.1:8765/jobs/job%2F1");
  assert.equal(calls[2].url, "http://127.0.0.1:8765/jobs/job%2F1/logs");
  assert.equal(calls[3].url, "http://127.0.0.1:8765/jobs/job%2F1/outputs");
  assert.equal(calls[4].url, "http://127.0.0.1:8765/jobs?project_id=sklep%20test");
});

test("createBridgeClient zachowuje stare endpointy bridge'a", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const client = createBridgeClient("http://localhost:8765", fetchImpl);

  await client.health();
  await client.createProject({ domain: "sklep.pl" });
  await client.pushConfig("sklep_pl", { domain: "sklep.pl" });
  await client.generateAdapter("sklep_pl");
  await client.run("sklep_pl", ["csv"]);
  await client.status("sklep_pl");
  await client.outputs("sklep_pl");
  await client.listProjects();

  assert.equal(calls[0].url, "http://localhost:8765/health");
  assert.equal(calls[1].url, "http://localhost:8765/projects");
  assert.equal(calls[2].url, "http://localhost:8765/projects/sklep_pl/config");
  assert.equal(calls[3].url, "http://localhost:8765/projects/sklep_pl/generate-adapter");
  assert.equal(calls[4].url, "http://localhost:8765/projects/sklep_pl/run");
  assert.equal(calls[5].url, "http://localhost:8765/projects/sklep_pl/status");
  assert.equal(calls[6].url, "http://localhost:8765/projects/sklep_pl/outputs");
  assert.equal(calls[7].url, "http://localhost:8765/projects");
});

test("createBridgeClient obsługuje cloud auth i billing endpointy", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const client = createBridgeClient("http://127.0.0.1:8766", fetchImpl, {
    headers: { "X-Shark-User-Id": "alice" },
    serviceName: "cloud API",
  });

  await client.me();
  await client.billingPlans();
  await client.billingStatus();
  await client.aiCapabilities();
  await client.suggestFields({ html: "<h1>Produkt</h1>", url: "https://x.pl/p/1", fields: ["product_name"] });
  await client.normalizeProducts({ products: [{ url: "https://x.pl/p/1", fields: {} }] });
  await client.checkoutSession("pro");

  assert.equal(calls[0].url, "http://127.0.0.1:8766/me");
  assert.equal(calls[1].url, "http://127.0.0.1:8766/billing/plans");
  assert.equal(calls[2].url, "http://127.0.0.1:8766/billing/status");
  assert.equal(calls[3].url, "http://127.0.0.1:8766/ai/capabilities");
  assert.equal(calls[4].url, "http://127.0.0.1:8766/ai/suggest-fields");
  assert.equal(calls[4].opts.method, "POST");
  assert.deepEqual(JSON.parse(calls[4].opts.body), { html: "<h1>Produkt</h1>", url: "https://x.pl/p/1", fields: ["product_name"] });
  assert.equal(calls[5].url, "http://127.0.0.1:8766/ai/normalize-products");
  assert.equal(calls[5].opts.method, "POST");
  assert.deepEqual(JSON.parse(calls[5].opts.body), { products: [{ url: "https://x.pl/p/1", fields: {} }] });
  assert.equal(calls[6].url, "http://127.0.0.1:8766/billing/checkout-session");
  assert.equal(calls[6].opts.method, "POST");
  assert.deepEqual(JSON.parse(calls[6].opts.body), { plan: "pro" });
  for (const call of calls) {
    assert.equal(call.opts.headers["X-Shark-User-Id"], "alice");
    assert.equal(call.opts.headers["Content-Type"], "application/json");
  }
});

test("createBridgeClient zgłasza czytelny błąd z bridge'a", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ detail: "Projekt nie ma konfiguracji" }),
  });
  const client = createBridgeClient("http://localhost:8765", fetchImpl);

  await assert.rejects(
    () => client.startJob("sklep", ["csv"]),
    (err) => err instanceof BridgeError && err.status === 400 && /konfiguracji/.test(err.message)
  );
});
