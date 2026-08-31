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
