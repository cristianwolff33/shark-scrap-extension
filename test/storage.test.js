import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBridgeSettings, saveBridgeSettings } from "../lib/storage.js";

function installChromeStorage(initial = {}) {
  const data = { ...initial };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (key === null) return { ...data };
          if (typeof key === "string") return { [key]: data[key] };
          if (Array.isArray(key)) return Object.fromEntries(key.map((name) => [name, data[name]]));
          return Object.fromEntries(Object.entries(key).map(([name, fallback]) => [name, data[name] ?? fallback]));
        },
        async set(values) {
          Object.assign(data, values);
        },
        async remove(key) {
          delete data[key];
        },
      },
    },
  };
  return data;
}

test("loadBridgeSettings zwraca domyślny local/cloud runtime", async () => {
  installChromeStorage();

  const settings = await loadBridgeSettings();

  assert.equal(settings.mode, "local");
  assert.equal(settings.baseUrl, "http://127.0.0.1:8765");
  assert.equal(settings.localBaseUrl, "http://127.0.0.1:8765");
  assert.equal(settings.cloudBaseUrl, "http://127.0.0.1:8766");
  assert.equal(settings.cloudUserId, "dev-user");
});

test("loadBridgeSettings zachowuje kompatybilność ze starym baseUrl", async () => {
  installChromeStorage({ "bridge:settings": { baseUrl: "http://localhost:9000" } });

  const settings = await loadBridgeSettings();

  assert.equal(settings.mode, "local");
  assert.equal(settings.baseUrl, "http://localhost:9000");
  assert.equal(settings.localBaseUrl, "http://localhost:9000");
});

test("saveBridgeSettings zapisuje osobny cloud runtime", async () => {
  const data = installChromeStorage();

  await saveBridgeSettings({
    mode: "cloud",
    cloudBaseUrl: "http://localhost:8766",
    cloudUserId: "alice",
  });

  assert.equal(data["bridge:settings"].mode, "cloud");
  assert.equal(data["bridge:settings"].baseUrl, "http://localhost:8766");
  assert.equal(data["bridge:settings"].localBaseUrl, "http://127.0.0.1:8765");
  assert.equal(data["bridge:settings"].cloudBaseUrl, "http://localhost:8766");
  assert.equal(data["bridge:settings"].cloudUserId, "alice");
});
