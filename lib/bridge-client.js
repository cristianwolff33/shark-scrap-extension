/**
 * @file Cienki klient REST do lokalnego mostu FastAPI (bridge/). Rozszerzenie NIE wykonuje
 * ETL — wysyła tylko konfigurację i steruje istniejącym Scraper Client przez te endpointy.
 */

class BridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(baseUrl, path, options = {}) {
  let res;
  try {
    res = await fetch(baseUrl.replace(/\/$/, "") + path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (err) {
    throw new BridgeError(`Nie można połączyć z bridgem pod ${baseUrl} — czy bridge jest uruchomiony? (${err.message})`, 0);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new BridgeError(data?.detail || `Bridge zwrócił błąd HTTP ${res.status}`, res.status);
  }
  return data;
}

export function createBridgeClient(baseUrl) {
  return {
    health: () => request(baseUrl, "/health"),
    createProject: (payload) => request(baseUrl, "/projects", { method: "POST", body: JSON.stringify(payload) }),
    pushConfig: (projectId, config) =>
      request(baseUrl, `/projects/${encodeURIComponent(projectId)}/config`, { method: "POST", body: JSON.stringify(config) }),
    generateAdapter: (projectId) =>
      request(baseUrl, `/projects/${encodeURIComponent(projectId)}/generate-adapter`, { method: "POST" }),
    run: (projectId, exportFormats) =>
      request(baseUrl, `/projects/${encodeURIComponent(projectId)}/run`, {
        method: "POST",
        body: JSON.stringify({ export_formats: exportFormats }),
      }),
    status: (projectId) => request(baseUrl, `/projects/${encodeURIComponent(projectId)}/status`),
    outputs: (projectId) => request(baseUrl, `/projects/${encodeURIComponent(projectId)}/outputs`),
    listProjects: () => request(baseUrl, "/projects"),
    // Fallback AI (OpenAI) NIE idzie już przez bridge — woła się bezpośrednio z przeglądarki,
    // patrz lib/openai-client.js + lib/storage.js (loadOpenAiSettings/saveOpenAiSettings).
  };
}

export { BridgeError };
