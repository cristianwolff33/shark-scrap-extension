/**
 * @file Klient BEZPOŚREDNIO do Claude/Anthropic — analogiczny do lib/openai-client.js (te same
 * publiczne funkcje: suggestFields/generateAdapterRows), ale dla Messages API, którego kształt
 * requestu/response różni się od OpenAI Chat Completions:
 *  - system prompt to osobne pole `system`, nie wiadomość w `messages`,
 *  - `max_tokens` jest WYMAGANE,
 *  - nie ma `response_format: json_schema` — niezawodny, ustrukturyzowany JSON wymusza się przez
 *    "tool use" z `tool_choice` wskazującym konkretne narzędzie (patrz *_TOOL niżej), zamiast
 *    prosić model o "zwróć JSON" w wolnym tekście.
 *
 * WAŻNE (bezpieczeństwo/CORS): domyślnie przeglądarka nie może wołać api.anthropic.com wprost —
 * Anthropic wymaga nagłówka `anthropic-dangerous-direct-browser-access: true`, żeby jawnie
 * zaakceptować użycie klucza bezpośrednio z klienta przeglądarkowego. To ten sam kompromis
 * bezpieczeństwa, jaki już zaakceptowaliśmy dla OpenAI w tym trybie local/dev — klucz zostaje
 * WYŁĄCZNIE w chrome.storage.local usera, nigdy nie trafia do żadnego backendu tej wtyczki.
 *
 * Prompty i spłaszczanie produktów są WSPÓLNE z OpenAI — patrz lib/ai-shared.js.
 */

import {
  SUGGEST_FIELDS_SYSTEM_PROMPT,
  ADAPTER_ROW_SYSTEM_PROMPT,
  ADAPTER_ROW_FIELDS,
  cleanHtml,
  buildSuggestFieldsUserPrompt,
  buildAdapterRowsUserPrompt,
} from "./ai-shared.js";

export const DEFAULT_MODEL = "claude-sonnet-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;

export { cleanHtml };
export const SYSTEM_PROMPT = SUGGEST_FIELDS_SYSTEM_PROMPT;

const SUGGEST_FIELDS_TOOL = {
  name: "field_suggestions",
  description: "Zwraca listę sugestii selektorów CSS dla brakujących pól produktowych.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            found: { type: "boolean" },
            selector: { type: "string" },
            attr: { type: "string" },
            multiple: { type: "boolean" },
            value: { type: ["string", "null"] },
          },
          required: ["field", "found", "selector", "attr", "multiple", "value"],
        },
      },
    },
    required: ["suggestions"],
  },
};

const ADAPTER_ROWS_TOOL = {
  name: "adapter_rows",
  description: "Zwraca finalne wiersze eksportu produktowego w strukturze Adapter Request.",
  input_schema: {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: Object.fromEntries(
            ADAPTER_ROW_FIELDS.map((field) => [field, { type: field === "index" ? "number" : "string" }])
          ),
          required: ADAPTER_ROW_FIELDS,
        },
      },
    },
    required: ["rows"],
  },
};

/** Buduje ciało zapytania POST /v1/messages z wymuszonym tool use `field_suggestions`. */
export function buildRequestBody(html, url, fields, model = DEFAULT_MODEL) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: SUGGEST_FIELDS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildSuggestFieldsUserPrompt(html, url, fields) }],
    tools: [SUGGEST_FIELDS_TOOL],
    tool_choice: { type: "tool", name: "field_suggestions" },
  };
}

export function buildAdapterRowsRequestBody(products, model = DEFAULT_MODEL) {
  return {
    model: model || DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    system: ADAPTER_ROW_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildAdapterRowsUserPrompt(products) }],
    tools: [ADAPTER_ROWS_TOOL],
    tool_choice: { type: "tool", name: "adapter_rows" },
  };
}

/** Wyciąga `.input` bloku `tool_use` o danej nazwie z odpowiedzi Messages API. */
function extractToolInput(responseJson, toolName) {
  const blocks = Array.isArray(responseJson?.content) ? responseJson.content : [];
  const toolBlock = blocks.find((block) => block?.type === "tool_use" && block?.name === toolName);
  return toolBlock ? toolBlock.input : null;
}

/** Czysta funkcja — testowalna bez sieci. */
export function parseSuggestions(responseJson) {
  const input = extractToolInput(responseJson, "field_suggestions");
  if (!input) {
    throw new Error("Claude nie zwróciło poprawnej odpowiedzi (brak bloku tool_use „field_suggestions”).");
  }
  return Array.isArray(input.suggestions) ? input.suggestions : [];
}

/** Czysta funkcja — testowalna bez sieci. */
export function parseAdapterRows(responseJson) {
  const input = extractToolInput(responseJson, "adapter_rows");
  if (!input) {
    throw new Error("Claude nie zwróciło poprawnej odpowiedzi dla finalnych wierszy (brak tool_use „adapter_rows”).");
  }
  return Array.isArray(input.rows) ? input.rows : [];
}

function authHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

async function postMessage(apiKey, body, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(ENDPOINT, { method: "POST", headers: authHeaders(apiKey), body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Nie można połączyć się z Claude/Anthropic (${err.message || err}).`);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const detail = data?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`Claude zwróciło błąd: ${detail}`);
  }
  if (!data) {
    throw new Error("Claude zwróciło pustą/niepoprawną odpowiedź.");
  }
  return data;
}

/**
 * Woła Claude bezpośrednio z przeglądarki (fetch, bez pośredniczącego serwera).
 * @param {{apiKey:string, model?:string, html:string, url:string, fields:string[], fetchImpl?:Function}} opts
 * @returns {Promise<{suggestions: any[], model: string}>}
 */
export async function suggestFields({ apiKey, model, html, url, fields, fetchImpl }) {
  const effectiveModel = model || DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error("Brak klucza Claude (Anthropic) API — ustaw go w ustawieniach wtyczki (sekcja „AI connector”).");
  }
  if (!fields || fields.length === 0) {
    return { suggestions: [], model: effectiveModel };
  }

  const data = await postMessage(apiKey, buildRequestBody(html, url, fields, effectiveModel), fetchImpl);
  return { suggestions: parseSuggestions(data), model: effectiveModel };
}

export async function generateAdapterRows({ apiKey, model, products, fetchImpl }) {
  const effectiveModel = model || DEFAULT_MODEL;
  if (!apiKey) throw new Error("Brak klucza Claude (Anthropic) API.");
  if (!products || products.length === 0) return { rows: [], model: effectiveModel };

  const data = await postMessage(apiKey, buildAdapterRowsRequestBody(products, effectiveModel), fetchImpl);
  return { rows: parseAdapterRows(data), model: effectiveModel };
}
