/**
 * @file Czysta logika orkiestracji pełnego auto-skanu katalogu ("scraper sam wszystko znajduje"):
 * budowanie/rozwiązywanie URL-i, deduplikacja, limitowanie liczby stron/produktów, heurystyka
 * wyboru trybu adaptera (requests/playwright) i wybór najlepszej próbki pól. Funkcje faktycznie
 * odpytujące żywy DOM (querySelector na sparsowanych stronach) zostają w content/detector.js —
 * ten moduł zawiera tylko to, co da się przetestować w Node bez prawdziwej przeglądarki
 * (ten sam podział jak jsonld.js/listing.js/fields.js).
 */

/** Bezpiecznie rozwiązuje href względem base — zwraca null zamiast rzucać na złym URL-u. */
export function resolveUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

/** Usuwa duplikaty zachowując kolejność pierwszego wystąpienia; odrzuca puste wartości. */
export function dedupe(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls || []) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Obcina tablicę do maks. `max` elementów (bez mutacji wejścia). max<=0 lub nieskończone => bez limitu. */
export function capArray(arr, max) {
  if (!Number.isFinite(max) || max <= 0) return (arr || []).slice();
  return (arr || []).slice(0, max);
}

/**
 * Heurystyka wyboru trybu adaptera: jeśli statyczny fetch (bez wykonania JS strony) znalazł
 * nazwę produktu i cenę, treść najpewniej jest renderowana po stronie serwera — `requests`
 * powinien wystarczyć. W przeciwnym razie zakładamy, że strona wymaga JS i proponujemy
 * `playwright`. To TYLKO heurystyka — zawsze zgłaszana userowi w logu jako założenie do
 * weryfikacji, nigdy jako pewnik (nie zgadujemy API `.pyd`, tu chodzi wyłącznie o zachowanie
 * strony sklepu).
 */
export function guessAdapterMode(staticFields) {
  const hasName = !!staticFields?.product_name?.value;
  const hasPrice = !!staticFields?.price?.value;
  return hasName && hasPrice ? "requests" : "playwright";
}

/** Liczy "jakość" jednej próbki pól — ile pól ma niepustą wartość. */
export function scoreFieldSample(sample) {
  return Object.values(sample || {}).filter((s) => s && s.value !== undefined && s.value !== null && s.value !== "").length;
}

/** Spośród kilku wykrytych field-mapów (z różnych przykładowych produktów) wybiera najlepszy. */
export function pickBestSample(samples) {
  let best = null;
  let bestScore = -1;
  for (const sample of samples || []) {
    const score = scoreFieldSample(sample);
    if (score > bestScore) {
      bestScore = score;
      best = sample;
    }
  }
  return best;
}

/** Buduje krótki, czytelny opis postępu skanu do wyświetlenia w UI/logu. */
export function formatScanProgress({ pagesVisited, pagesTotal, productsFound, productsTotal }) {
  const pagesPart = pagesTotal ? `strona ${pagesVisited}/${pagesTotal}` : `strona ${pagesVisited}`;
  const productsPart = productsTotal ? `${productsFound}/${productsTotal} produktów` : `${productsFound} produktów`;
  return `${pagesPart} — ${productsPart}`;
}

/**
 * Decyduje, czy paginacja nadaje się do automatycznego, bezobsługowego podążania (fetch po URL-ach).
 * Tylko next_link jest tu bezpieczny — load_more/infinite_scroll wymagają wykonania JS na
 * żywej stronie (klik/scroll), czego statyczny fetch kolejnych stron nie odtworzy.
 */
export function isAutoFollowablePagination(pagination) {
  return !!pagination && pagination.mode === "next_link" && !!pagination.next_selector;
}
