/**
 * @file Zapis/odczyt konfiguracji per domena w chrome.storage.local.
 * Klucz: `config:<domain>`. Osobny klucz `bridge:settings` trzyma URL bridge'a
 * (tryb zaawansowany), `openai:settings` trzyma klucz API OpenAI + model (fallback AI w
 * prostym trybie, patrz lib/openai-client.js — klucz NIGDY nie opuszcza chrome.storage.local
 * poza samym wywołaniem do api.openai.com).
 */

const CONFIG_PREFIX = "config:";
const BRIDGE_SETTINGS_KEY = "bridge:settings";
const OPENAI_SETTINGS_KEY = "openai:settings";

/** @param {string} domain @returns {Promise<import('./schema.js').ScraperConfig|null>} */
export async function loadConfig(domain) {
  const key = CONFIG_PREFIX + domain;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? null;
}

/** @param {import('./schema.js').ScraperConfig} config */
export async function saveConfig(config) {
  const key = CONFIG_PREFIX + config.domain;
  await chrome.storage.local.set({ [key]: config });
}

export async function listConfigs() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(CONFIG_PREFIX))
    .map(([, value]) => value);
}

export async function deleteConfig(domain) {
  await chrome.storage.local.remove(CONFIG_PREFIX + domain);
}

/** @returns {Promise<{baseUrl: string}>} */
export async function loadBridgeSettings() {
  const result = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
  return result[BRIDGE_SETTINGS_KEY] ?? { baseUrl: "http://127.0.0.1:8765" };
}

/** @param {{baseUrl: string}} settings */
export async function saveBridgeSettings(settings) {
  await chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: settings });
}

/** @returns {Promise<{apiKey: string, model: string}>} */
export async function loadOpenAiSettings() {
  const result = await chrome.storage.local.get(OPENAI_SETTINGS_KEY);
  return result[OPENAI_SETTINGS_KEY] ?? { apiKey: "", model: "" };
}

/** @param {{apiKey: string, model: string}} settings */
export async function saveOpenAiSettings(settings) {
  await chrome.storage.local.set({ [OPENAI_SETTINGS_KEY]: settings });
}
