/**
 * @file Klient BEZPOŚREDNIO do OpenAI (surowe REST przez fetch, bez SDK — w content
 * scripcie/side panelu nie ma pip/node_modules) — fallback AI dla pól, których
 * jsonld/microdata/meta/dom NIE wykryły automatycznie podczas auto-skanu
 * (content/detector.js::scanCatalog). Klucz API i model są trzymane w chrome.storage.local
 * (lib/storage.js::loadOpenAiSettings/saveOpenAiSettings, ustawiane w sidepanelu) — NIE na
 * żadnym serwerze. Wywołanie leci wprost z przeglądarki do api.openai.com; manifest.json ma
 * już `<all_urls>` w host_permissions, więc to pokrywa i ten host bez dodatkowych uprawnień.
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

// Tani/szybki model OpenAI ze structured outputs — nadpisywalny w ustawieniach wtyczki,
// gdyby OpenAI zmieniło nazewnictwo/ofertę modeli.
export const DEFAULT_MODEL = "gpt-5.6-luna";
const MAX_HTML_CHARS = 12_000;
const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export const SYSTEM_PROMPT =
  "Jesteś asystentem konfiguracji scrapera e-commerce. Dostajesz fragment HTML strony " +
  "produktu ze sklepu internetowego oraz listę brakujących pól. Dla KAŻDEGO pola z listy " +
  "zwróć: czy udało się je znaleźć (found), selektor CSS działający przez " +
  "document.querySelector WZGLĘDEM PRZEKAZANEGO HTML-a (bez zależności od kontekstu spoza " +
  "fragmentu), atrybut do odczytu ('text', 'html', albo nazwa atrybutu np. 'src'/'href'/" +
  "'content'), czy pole jest wielowartościowe (multiple) i best-guess wartość (value) do " +
  "podglądu. Jeśli nie znajdziesz pola w podanym HTML-u, zwróć found=false i pusty selector " +
  "— NIE zgaduj/nie wymyślaj selektora na siłę, lepiej zwrócić brak niż błędny selektor.";

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

/** Usuwa script/style (hałas + koszt tokenów, nie treść produktowa) i obcina. Czysta funkcja. */
export function cleanHtml(html) {
  const stripped = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  return stripped.slice(0, MAX_HTML_CHARS);
}

/**
 * Buduje ciało zapytania POST /v1/chat/completions (structured outputs, response_format
 * json_schema). Czysta funkcja — testowalna bez sieci.
 */
export function buildRequestBody(html, url, fields, model = DEFAULT_MODEL) {
  const cleaned = cleanHtml(html);
  const userPrompt =
    `URL strony: ${url}\n` +
    `Brakujące pola do znalezienia: ${(fields || []).join(", ")}\n\n` +
    `HTML (obcięty do ${MAX_HTML_CHARS} znaków):\n${cleaned}`;
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
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

/**
 * Woła OpenAI bezpośrednio z przeglądarki (fetch, bez pośredniczącego serwera).
 * @param {{apiKey:string, model?:string, html:string, url:string, fields:string[], fetchImpl?:Function}} opts
 * @returns {Promise<{suggestions: any[], model: string}>}
 */
export async function suggestFields({ apiKey, model, html, url, fields, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const effectiveModel = model || DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error("Brak klucza OpenAI API — ustaw go w ustawieniach wtyczki (sekcja „AI (OpenAI)”).");
  }
  if (!fields || fields.length === 0) {
    return { suggestions: [], model: effectiveModel };
  }

  const body = buildRequestBody(html, url, fields, effectiveModel);

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
    throw new Error(`OpenAI zwróciło błąd: ${detail}`);
  }
  if (!data) {
    throw new Error("OpenAI zwróciło pustą/niepoprawną odpowiedź.");
  }

  const suggestions = parseSuggestions(data);
  return { suggestions, model: effectiveModel };
}
