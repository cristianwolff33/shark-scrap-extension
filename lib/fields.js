/**
 * @file Łączenie wyników detekcji z wielu źródeł wg priorytetu:
 * jsonld > microdata > meta > dom-heuristics. Ostatni krok to selektory ustawione
 * ręcznie przez usera (source "css") — te ZAWSZE wygrywają, bo user wie lepiej.
 */

export const SOURCE_PRIORITY = ["jsonld", "microdata", "meta", "dom"];

/**
 * @param {Record<string, any>} manual - pola nadpisane ręcznie przez picker (source: "css")
 * @param {...Record<string, any>} autoResults - wyniki detektorów w kolejności SOURCE_PRIORITY
 */
export function mergeFieldSources(manual, ...autoResults) {
  /** @type {Record<string, any>} */
  const merged = {};
  // Najpierw auto-detekcja w odwrotnej kolejności priorytetu, żeby wyższy priorytet nadpisał niższy.
  for (const result of [...autoResults].reverse()) {
    for (const [field, spec] of Object.entries(result || {})) {
      merged[field] = spec;
    }
  }
  // Ręczne selektory zawsze na końcu — najwyższy priorytet.
  for (const [field, spec] of Object.entries(manual || {})) {
    merged[field] = spec;
  }
  return merged;
}

/** Zwraca listę pól z brakującą wartością — do podświetlenia w UI jako "wymaga ręcznego wskazania". */
export function missingFields(allFields, merged) {
  return allFields.filter((f) => !merged[f] || merged[f].value === undefined || merged[f].value === "");
}

/** Liczba zdjęć w polu "images" (0, gdy pole puste/brak). */
function imageCount(spec) {
  if (!spec) return 0;
  if (Array.isArray(spec.values)) return spec.values.length;
  return spec.value ? 1 : 0;
}

/**
 * Dla pola "images" ogólny priorytet źródeł (jsonld > microdata > meta > dom) bywa ZŁYM
 * wyborem: meta (og:image) niemal zawsze daje TYLKO JEDNO zdjęcie — często mniejsze,
 * wygenerowane specjalnie pod social sharing (Yoast/RankMath itp.) — podczas gdy prawdziwa
 * galeria produktu w DOM może dać kilka zdjęć w pełnej rozdzielczości. Ślepe trzymanie się
 * priorytetu źródeł oznaczało, że jedno małe og:image ZAWSZE wygrywało z całą galerią.
 * Zamiast tego wybieramy kandydata z NAJWIĘKSZĄ liczbą zdjęć (przy remisie wygrywa ten
 * wcześniejszy w kolejności — czyli oryginalny priorytet źródeł jako tiebreaker).
 * @param {(Record<string, any>|null|undefined)[]} candidates - w kolejności priorytetu źródeł
 * @returns {Record<string, any>|null}
 */
export function pickRichestImagesField(candidates) {
  const present = (candidates || []).filter(Boolean);
  if (present.length === 0) return null;
  return present.reduce((best, candidate) => (imageCount(candidate) > imageCount(best) ? candidate : best));
}
