/**
 * @file Zapis/odczyt konfiguracji per domena w chrome.storage.local.
 * Klucz: `config:<domain>`. Osobny klucz `bridge:settings` trzyma ustawienia API
 * frameworka/cloud. `ai:settings` trzyma local/dev connector AI (provider + osobny klucz/model
 * dla KAŻDEGO providera, żeby przełączanie Codex<->Claude nie kasowało drugiego klucza) tylko
 * dla trybu lokalnego; w Cloud mode AI idzie przez backend i nie wymaga klucza LLM w Chrome.
 */

const CONFIG_PREFIX = "config:";
const BRIDGE_SETTINGS_KEY = "bridge:settings";
const AI_SETTINGS_KEY = "ai:settings";
const LEGACY_OPENAI_SETTINGS_KEY = "openai:settings"; // stary format sprzed multi-providera — patrz loadAiSettings
const DEFAULT_BRIDGE_SETTINGS = {
  mode: "local",
  localBaseUrl: "http://127.0.0.1:8765",
  cloudBaseUrl: "http://127.0.0.1:8766",
  cloudUserId: "dev-user",
};
const DEFAULT_AI_SETTINGS = {
  provider: "openai", // "openai" (Codex) | "anthropic" (Claude)
  openaiApiKey: "",
  openaiModel: "",
  anthropicApiKey: "",
  anthropicModel: "",
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

/**
 * @returns {Promise<{provider: "openai"|"anthropic", openaiApiKey: string, openaiModel: string, anthropicApiKey: string, anthropicModel: string}>}
 */
export async function loadAiSettings() {
  const result = await chrome.storage.local.get([AI_SETTINGS_KEY, LEGACY_OPENAI_SETTINGS_KEY]);
  const saved = result[AI_SETTINGS_KEY];
  if (saved) return { ...DEFAULT_AI_SETTINGS, ...saved };

  // Migracja jednorazowa: user mógł już mieć zapisany klucz sprzed dodania wyboru providera
  // (Codex/Claude) — zamiast go zgubić, wczytujemy go jako klucz OpenAI (tak działało wcześniej).
  const legacy = result[LEGACY_OPENAI_SETTINGS_KEY];
  if (legacy?.apiKey) {
    return { ...DEFAULT_AI_SETTINGS, provider: "openai", openaiApiKey: legacy.apiKey, openaiModel: legacy.model || "" };
  }
  return { ...DEFAULT_AI_SETTINGS };
}

/** @param {{provider: string, openaiApiKey: string, openaiModel: string, anthropicApiKey: string, anthropicModel: string}} settings */
export async function saveAiSettings(settings) {
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: settings });
}
