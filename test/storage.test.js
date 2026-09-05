import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBridgeSettings, saveBridgeSettings, loadAiSettings, saveAiSettings } from "../lib/storage.js";

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

test("loadAiSettings zwraca domyślny stan (provider openai, wszystko puste) gdy nic nie zapisano", async () => {
  installChromeStorage();

  const settings = await loadAiSettings();

  assert.equal(settings.provider, "openai");
  assert.equal(settings.openaiApiKey, "");
  assert.equal(settings.openaiModel, "");
  assert.equal(settings.anthropicApiKey, "");
  assert.equal(settings.anthropicModel, "");
});

test("loadAiSettings migruje stary klucz openai:settings (sprzed multi-providera) na openaiApiKey/openaiModel", async () => {
  installChromeStorage({ "openai:settings": { apiKey: "sk-legacy", model: "gpt-5.6-sol" } });

  const settings = await loadAiSettings();

  assert.equal(settings.provider, "openai");
  assert.equal(settings.openaiApiKey, "sk-legacy");
  assert.equal(settings.openaiModel, "gpt-5.6-sol");
});

test("saveAiSettings/loadAiSettings zachowują OBA klucze niezależnie przy przełączaniu providera", async () => {
  installChromeStorage();

  await saveAiSettings({ provider: "openai", openaiApiKey: "sk-openai", openaiModel: "", anthropicApiKey: "", anthropicModel: "" });
  await saveAiSettings({ provider: "anthropic", openaiApiKey: "sk-openai", openaiModel: "", anthropicApiKey: "sk-ant", anthropicModel: "claude-sonnet-5" });

  const settings = await loadAiSettings();
  assert.equal(settings.provider, "anthropic");
  assert.equal(settings.openaiApiKey, "sk-openai"); // klucz OpenAI przetrwał przełączenie na Claude
  assert.equal(settings.anthropicApiKey, "sk-ant");
  assert.equal(settings.anthropicModel, "claude-sonnet-5");
});

test("loadAiSettings ignoruje legacy klucz, jeśli nowy ai:settings już istnieje", async () => {
  installChromeStorage({
    "openai:settings": { apiKey: "sk-legacy", model: "old" },
    "ai:settings": { provider: "anthropic", openaiApiKey: "", openaiModel: "", anthropicApiKey: "sk-ant", anthropicModel: "" },
  });

  const settings = await loadAiSettings();
  assert.equal(settings.provider, "anthropic");
  assert.equal(settings.anthropicApiKey, "sk-ant");
  assert.equal(settings.openaiApiKey, "");
});
