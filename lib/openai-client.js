/**
 * @file Klient BEZPOŚREDNIO do OpenAI/Codex (surowe REST przez fetch, bez SDK — w content
 * scripcie/side panelu nie ma pip/node_modules) — fallback AI dla pól, których
 * jsonld/microdata/meta/dom NIE wykryły automatycznie podczas auto-skanu
 * (content/detector.js::scanCatalog). To jest ścieżka local/dev: klucz API i model są trzymane
 * w chrome.storage.local i wywołanie leci wprost z przeglądarki do api.openai.com. W trybie
 * Cloud extension używa backendowego AI API z lib/bridge-client.js, żeby nie trzymać klucza LLM
 * w Chrome. Analogiczny klient dla Claude/Anthropic: lib/anthropic-client.js (te dwa pliki mają
 * identyczne publiczne funkcje — suggestFields/generateAdapterRows — sidepanel/main.js i
 * content/detector.js wybierają, którego użyć, wg state.ai.provider).
 *
 * Prompty i spłaszczanie produktów są WSPÓLNE dla obu providerów — patrz lib/ai-shared.js. Tu
 * zostaje tylko to, co specyficzne dla wire-formatu OpenAI (Chat Completions + structured
 * outputs przez response_format: json_schema).
 *
 * Zasady identyczne jak w poprzedniej, bridge'owej wersji tej funkcji (bridge/ai_provider.py —
 * usunięty, patrz docs/EXTENSION_BRIDGE.md — cała logika przeniosła się tutaj):
 *  - Wywoływane najwyżej raz na skan (na próbce do 3 kart), NIE per-produkt — kontrola kosztu.
 *  - Dostaje tylko listę BRAKUJĄCYCH pól, nigdy nie nadpisuje już wykrytych przez
 *    jsonld/microdata/meta/dom/css.
 *  - Zwrócony selektor NIE jest tu w ogóle wykonywany — ten moduł tylko woła OpenAI i parsuje
 *    JSON. To content/detector.js weryfikuje `querySelector` na żywym DOM próbki i odrzuca
 *    sugestię, jeśli się nie da zweryfikować. Ta sama zasada co ".pyd — nie zgaduj, sprawdź
 *    rzeczywiste zachowanie", zastosowana do wyjścia modelu.
 *
 * Pure funkcje (cleanHtml/buildRequestBody/parseSuggestions) są testowalne w Node bez sieci
 * (patrz test/openai-client.test.js). `suggestFields()` jest jedyną częścią, która faktycznie
 * woła sieć — `fetchImpl` jest wstrzykiwalny (fake fetch w testach), dokładnie tak jak fake
 * klient OpenAI był wstrzykiwany w bridge/tests/test_ai_provider.py.
 */

import {
  SUGGEST_FIELDS_SYSTEM_PROMPT,
  ADAPTER_ROW_SYSTEM_PROMPT,
  ADAPTER_ROW_FIELDS,
  cleanHtml,
  buildSuggestFieldsUserPrompt,
  buildAdapterRowsUserPrompt,
} from "./ai-shared.js";

// Mocniejszy model do finalnej transformacji danych produktowych i opisów SEO.
export const DEFAULT_MODEL = "gpt-5.6-sol";
const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export { cleanHtml };
export const SYSTEM_PROMPT = SUGGEST_FIELDS_SYSTEM_PROMPT;

const RESPONSE_JSON_SCHEMA = {
  name: "ai_field_suggestions",
  strict: true,
  schema: {
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
          additionalProperties: false,
        },
      },
    },
    required: ["suggestions"],
    additionalProperties: false,
  },
};

/**
 * Buduje ciało zapytania POST /v1/chat/completions (structured outputs, response_format
 * json_schema). Czysta funkcja — testowalna bez sieci.
 */
export function buildRequestBody(html, url, fields, model = DEFAULT_MODEL) {
  return {
    model,
    messages: [
      { role: "system", content: SUGGEST_FIELDS_SYSTEM_PROMPT },
      { role: "user", content: buildSuggestFieldsUserPrompt(html, url, fields) },
    ],
    response_format: { type: "json_schema", json_schema: RESPONSE_JSON_SCHEMA },
  };
}

/**
 * Parsuje odpowiedź REST na listę sugestii — `choices[0].message.content` to STRING z JSON-em
 * (structured outputs w trybie REST, w przeciwieństwie do `.parsed` z Python SDK), więc trzeba
 * go ręcznie sparsować. Czysta funkcja — testowalna bez sieci.
 */
export function parseSuggestions(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI nie zwróciło poprawnej odpowiedzi (brak choices[0].message.content).");
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`OpenAI zwróciło niepoprawny JSON w treści odpowiedzi: ${err.message}`);
  }
  return Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
}

async function postChatCompletion(apiKey, body, fetchImpl, errorPrefix) {
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Nie można połączyć się z OpenAI (${err.message || err}).`);
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
    throw new Error(`${errorPrefix}: ${detail}`);
  }
  if (!data) {
    throw new Error("OpenAI zwróciło pustą/niepoprawną odpowiedź.");
  }
  return data;
}

/**
 * Woła OpenAI bezpośrednio z przeglądarki (fetch, bez pośredniczącego serwera).
 * @param {{apiKey:string, model?:string, html:string, url:string, fields:string[], fetchImpl?:Function}} opts
 * @returns {Promise<{suggestions: any[], model: string}>}
 */
export async function suggestFields({ apiKey, model, html, url, fields, fetchImpl }) {
  const effectiveModel = model || DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error("Brak klucza OpenAI API — ustaw go w ustawieniach wtyczki (sekcja „AI connector”).");
  }
  if (!fields || fields.length === 0) {
    return { suggestions: [], model: effectiveModel };
  }

  const body = buildRequestBody(html, url, fields, effectiveModel);
  const data = await postChatCompletion(apiKey, body, fetchImpl, "OpenAI zwróciło błąd");
  return { suggestions: parseSuggestions(data), model: effectiveModel };
}

const ADAPTER_ROW_JSON_SCHEMA = {
  name: "adapter_rows",
  strict: true,
  schema: {
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
          additionalProperties: false,
        },
      },
    },
    required: ["rows"],
    additionalProperties: false,
  },
};

export function buildAdapterRowsRequestBody(products, model = DEFAULT_MODEL) {
  return {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: "system", content: ADAPTER_ROW_SYSTEM_PROMPT },
      { role: "user", content: buildAdapterRowsUserPrompt(products) },
    ],
    response_format: { type: "json_schema", json_schema: ADAPTER_ROW_JSON_SCHEMA },
  };
}

export function parseAdapterRows(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI nie zwróciło poprawnej odpowiedzi dla finalnych wierszy.");
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`OpenAI zwróciło niepoprawny JSON finalnych wierszy: ${err.message}`);
  }
  return Array.isArray(parsed?.rows) ? parsed.rows : [];
}

export async function generateAdapterRows({ apiKey, model, products, fetchImpl }) {
  const effectiveModel = model || DEFAULT_MODEL;
  if (!apiKey) throw new Error("Brak klucza OpenAI API.");
  if (!products || products.length === 0) return { rows: [], model: effectiveModel };

  const data = await postChatCompletion(apiKey, buildAdapterRowsRequestBody(products, effectiveModel), fetchImpl, "OpenAI zwróciło błąd");
  return { rows: parseAdapterRows(data), model: effectiveModel };
}
