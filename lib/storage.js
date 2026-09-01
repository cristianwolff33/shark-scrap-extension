/**
 * @file Zapis/odczyt konfiguracji per domena w chrome.storage.local.
 * Klucz: `config:<domain>`. Osobny klucz `bridge:settings` trzyma ustawienia API
 * frameworka/cloud, `openai:settings` trzyma klucz API OpenAI + model (fallback AI w
 * prostym trybie, patrz lib/openai-client.js — klucz NIGDY nie opuszcza chrome.storage.local
 * poza samym wywołaniem do api.openai.com).
 */

const CONFIG_PREFIX = "config:";
const BRIDGE_SETTINGS_KEY = "bridge:settings";
const OPENAI_SETTINGS_KEY = "openai:settings";
const DEFAULT_BRIDGE_SETTINGS = {
  mode: "local",
  localBaseUrl: "http://127.0.0.1:8765",
  cloudBaseUrl: "http://127.0.0.1:8766",
  cloudUserId: "dev-user",
};

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

/** @returns {Promise<{mode: string, baseUrl: string, localBaseUrl: string, cloudBaseUrl: string, cloudUserId: string}>} */
export async function loadBridgeSettings() {
  const result = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
  const saved = result[BRIDGE_SETTINGS_KEY] ?? {};
  const mode = saved.mode === "cloud" ? "cloud" : "local";
  const localBaseUrl = saved.localBaseUrl || saved.baseUrl || DEFAULT_BRIDGE_SETTINGS.localBaseUrl;
  const cloudBaseUrl = saved.cloudBaseUrl || DEFAULT_BRIDGE_SETTINGS.cloudBaseUrl;
  return {
    ...DEFAULT_BRIDGE_SETTINGS,
    ...saved,
    mode,
    localBaseUrl,
    cloudBaseUrl,
    cloudUserId: saved.cloudUserId || DEFAULT_BRIDGE_SETTINGS.cloudUserId,
    baseUrl: mode === "cloud" ? cloudBaseUrl : localBaseUrl,
  };
}

/** @param {{mode?: string, baseUrl?: string, localBaseUrl?: string, cloudBaseUrl?: string, cloudUserId?: string}} settings */
export async function saveBridgeSettings(settings) {
  const current = await loadBridgeSettings();
  const next = { ...current, ...settings };
  next.mode = next.mode === "cloud" ? "cloud" : "local";
  if (settings.baseUrl && !settings.localBaseUrl && next.mode === "local") {
    next.localBaseUrl = settings.baseUrl;
  }
  next.baseUrl = next.mode === "cloud" ? next.cloudBaseUrl : next.localBaseUrl;
  await chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: next });
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
