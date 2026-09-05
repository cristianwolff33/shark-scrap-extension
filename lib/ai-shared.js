/**
 * @file Logika WSPÓLNA dla wszystkich providerów AI (OpenAI/Codex i Claude/Anthropic) — prompty,
 * sprzątanie HTML-a i spłaszczanie produktów są identyczne bez względu na to, czyje API
 * wywołujemy. Różni się TYLKO kształt requestu/response (OpenAI: `response_format: json_schema`
 * w Chat Completions; Anthropic: wymuszone "tool use" w Messages API) — to zostaje osobno w
 * lib/openai-client.js i lib/anthropic-client.js, każdy trzyma tylko to, co naprawdę specyficzne
 * dla jego API.
 */

export const MAX_HTML_CHARS = 12_000;

export const SUGGEST_FIELDS_SYSTEM_PROMPT =
  "Jesteś asystentem konfiguracji scrapera e-commerce. Dostajesz fragment HTML strony " +
  "produktu ze sklepu internetowego oraz listę brakujących pól. Dla KAŻDEGO pola z listy " +
  "zwróć: czy udało się je znaleźć (found), selektor CSS działający przez " +
  "document.querySelector WZGLĘDEM PRZEKAZANEGO HTML-a (bez zależności od kontekstu spoza " +
  "fragmentu), atrybut do odczytu ('text', 'html', albo nazwa atrybutu np. 'src'/'href'/" +
  "'content'), czy pole jest wielowartościowe (multiple) i best-guess wartość (value) do " +
  "podglądu. Jeśli nie znajdziesz pola w podanym HTML-u, zwróć found=false i pusty selector " +
  "— NIE zgaduj/nie wymyślaj selektora na siłę, lepiej zwrócić brak niż błędny selektor.";

export const ADAPTER_ROW_SYSTEM_PROMPT =
  "Jesteś silnikiem transformacji danych produktowych dla eksportu Allegro. " +
  "Dostajesz produkty zeskanowane ze sklepu i zwracasz finalne wiersze w strukturze Adapter Request. " +
  "Zasady: zachowaj ceny, SKU, EAN i markę, jeśli są podane. Nie wymyślaj SKU ani EAN. " +
  "Tytuł oferty ma być krótki, handlowy i zgodny z nazwą produktu. " +
  "Opis napisz po polsku własnymi słowami, SEO-friendly, bez linków do zdjęć. " +
  "Podziel opis na cztery HTML sekcje: opis_dodatkowy1, opis_dodatkowy2, opis_dodatkowy3, opis_dodatkowy4. " +
  "Każda sekcja musi mieć wyboldowany tytuł przez <strong>. Jedna sekcja musi zawierać parametry produktu. " +
  "Nie zwracaj ogólników typu 'wysoka jakość' bez oparcia w danych wejściowych. " +
  "Jeśli opis źródłowy jest ubogi, zbuduj krótki opis sprzedażowy wyłącznie z nazwy, marki, kategorii i dostępnych parametrów. " +
  "Jeśli brakuje danych, zostaw puste pole i wpisz krótką uwagę w UWAGI. Zwróć tyle wierszy, ile produktów wejściowych.";

/** Lista pól pojedynczego wiersza adapter-request — jedno źródło prawdy dla obu providerów
 * (schemat JSON OpenAI i input_schema narzędzia Anthropic muszą wymagać dokładnie tych samych
 * kluczy, inaczej wyniki dwóch providerów przestałyby być wymienne). */
export const ADAPTER_ROW_FIELDS = [
  "index",
  "Cena",
  "SKU",
  "EAN",
  "OPIS",
  "opis_dodatkowy1",
  "opis_dodatkowy2",
  "opis_dodatkowy3",
  "opis_dodatkowy4",
  "Marka",
  "TYTUŁ OFERTY",
  "KOD PRODUCENTA",
  "UWAGI",
];

/** Usuwa script/style (hałas + koszt tokenów, nie treść produktowa) i obcina. Czysta funkcja. */
export function cleanHtml(html) {
  const stripped = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  return stripped.slice(0, MAX_HTML_CHARS);
}

/** Buduje treść user-prompta dla suggestFields — identyczna dla obu providerów. */
export function buildSuggestFieldsUserPrompt(html, url, fields) {
  const cleaned = cleanHtml(html);
  return (
    `URL strony: ${url}\n` +
    `Brakujące pola do znalezienia: ${(fields || []).join(", ")}\n\n` +
    `HTML (obcięty do ${MAX_HTML_CHARS} znaków):\n${cleaned}`
  );
}

function compactField(fields, name) {
  const spec = fields?.[name];
  const value = spec?.value;
  if (value === undefined || value === null) return "";
  return String(value).slice(0, 4000);
}

function compactImages(fields) {
  const spec = fields?.images;
  const values = Array.isArray(spec?.values) ? spec.values : spec?.value ? [spec.value] : [];
  return values.map((v) => String(v || "")).filter(Boolean).slice(0, 20);
}

/** Spłaszcza produkty ze skanu do kompaktowej struktury wysyłanej do modelu (limit rozmiaru pól/liczby zdjęć). */
export function compactProducts(products) {
  return (products || []).map((product, index) => ({
    index,
    source_url: product.url || "",
    ok: product.ok !== false,
    error: product.error || "",
    product_name: compactField(product.fields, "product_name"),
    sku: compactField(product.fields, "sku"),
    ean: compactField(product.fields, "ean"),
    brand: compactField(product.fields, "brand"),
    price: compactField(product.fields, "price"),
    old_price: compactField(product.fields, "old_price"),
    currency: compactField(product.fields, "currency"),
    availability: compactField(product.fields, "availability"),
    category: compactField(product.fields, "category"),
    description: compactField(product.fields, "description"),
    product_url: compactField(product.fields, "product_url") || product.url || "",
    images: compactImages(product.fields),
  }));
}

/** Buduje treść user-prompta dla generateAdapterRows — identyczna dla obu providerów. */
export function buildAdapterRowsUserPrompt(products) {
  const compact = compactProducts(products);
  return (
    "Zwróć finalne wiersze eksportu. Kolumny: Cena, SKU, EAN, OPIS, opis_dodatkowy1, opis_dodatkowy2, " +
    "opis_dodatkowy3, opis_dodatkowy4, Marka, TYTUŁ OFERTY, KOD PRODUCENTA, UWAGI.\n\n" +
    JSON.stringify({ products: compact })
  );
}
