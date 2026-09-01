/**
 * @file Cienki klient REST do lokalnego bridge'a FastAPI i cloud API. Rozszerzenie NIE
 * wykonuje ETL — wysyła tylko konfigurację i steruje backendem przez te endpointy.
 */

class BridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(baseUrl, path, options = {}) {
  const { fetchImpl = fetch, headers = {}, serviceName = "API", ...fetchOptions } = options;
  let res;
  try {
    const mergedHeaders = {
      "Content-Type": "application/json",
      ...headers,
      ...(fetchOptions.headers || {}),
    };
    res = await fetchImpl(baseUrl.replace(/\/$/, "") + path, {
      ...fetchOptions,
      headers: mergedHeaders,
    });
  } catch (err) {
    throw new BridgeError(`Nie można połączyć z ${serviceName} pod ${baseUrl} — czy usługa jest uruchomiona? (${err.message})`, 0);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new BridgeError(data?.detail || `${serviceName} zwróciło błąd HTTP ${res.status}`, res.status);
  }
  return data;
}

export function createBridgeClient(baseUrl, fetchImpl = fetch, defaults = {}) {
  const requestDefaults = {
    fetchImpl,
    headers: defaults.headers || {},
    serviceName: defaults.serviceName || "API",
  };
  return {
    health: () => request(baseUrl, "/health", requestDefaults),
    me: () => request(baseUrl, "/me", requestDefaults),
    billingPlans: () => request(baseUrl, "/billing/plans", requestDefaults),
    billingStatus: () => request(baseUrl, "/billing/status", requestDefaults),
    aiCapabilities: () => request(baseUrl, "/ai/capabilities", requestDefaults),
    suggestFields: (payload) =>
      request(baseUrl, "/ai/suggest-fields", {
        ...requestDefaults,
        method: "POST",
        body: JSON.stringify(payload),
      }),
    normalizeProducts: (payload) =>
      request(baseUrl, "/ai/normalize-products", {
        ...requestDefaults,
        method: "POST",
        body: JSON.stringify(payload),
      }),
    checkoutSession: (plan) =>
      request(baseUrl, "/billing/checkout-session", {
        ...requestDefaults,
        method: "POST",
        body: JSON.stringify({ plan }),
      }),
    createProject: (payload) => request(baseUrl, "/projects", { ...requestDefaults, method: "POST", body: JSON.stringify(payload) }),
    pushConfig: (projectId, config) =>
      request(baseUrl, `/projects/${encodeURIComponent(projectId)}/config`, { ...requestDefaults, method: "POST", body: JSON.stringify(config) }),
    generateAdapter: (projectId) =>
      request(baseUrl, `/projects/${encodeURIComponent(projectId)}/generate-adapter`, { ...requestDefaults, method: "POST" }),
    run: (projectId, exportFormats) =>
      request(baseUrl, `/projects/${encodeURIComponent(projectId)}/run`, {
        ...requestDefaults,
        method: "POST",
        body: JSON.stringify({ export_formats: exportFormats }),
      }),
    startJob: (projectId, exportFormats) =>
      request(baseUrl, `/projects/${encodeURIComponent(projectId)}/jobs`, {
        ...requestDefaults,
        method: "POST",
        body: JSON.stringify({ export_formats: exportFormats }),
      }),
    status: (projectId) => request(baseUrl, `/projects/${encodeURIComponent(projectId)}/status`, requestDefaults),
    outputs: (projectId) => request(baseUrl, `/projects/${encodeURIComponent(projectId)}/outputs`, requestDefaults),
    job: (jobId) => request(baseUrl, `/jobs/${encodeURIComponent(jobId)}`, requestDefaults),
    jobLogs: (jobId) => request(baseUrl, `/jobs/${encodeURIComponent(jobId)}/logs`, requestDefaults),
    jobOutputs: (jobId) => request(baseUrl, `/jobs/${encodeURIComponent(jobId)}/outputs`, requestDefaults),
    listJobs: (projectId = "") => {
      const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
      return request(baseUrl, `/jobs${query}`, requestDefaults);
    },
    listProjects: () => request(baseUrl, "/projects", requestDefaults),
  };
}

export { BridgeError };
