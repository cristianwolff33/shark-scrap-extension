import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeGpsrHeading } from "../lib/dom-heuristics.js";

test("looksLikeGpsrHeading rozpoznaje literalny skrót GPSR (dowolna wielkość liter)", () => {
  assert.ok(looksLikeGpsrHeading("GPSR"));
  assert.ok(looksLikeGpsrHeading("Informacje o produkcie (gpsr)"));
  assert.ok(looksLikeGpsrHeading("  GPSR  "));
});

test("looksLikeGpsrHeading rozpoznaje polskie opisowe warianty bez słowa GPSR", () => {
  assert.ok(looksLikeGpsrHeading("Informacje o bezpieczeństwie produktu"));
  assert.ok(looksLikeGpsrHeading("Bezpieczeństwo produktu"));
  assert.ok(looksLikeGpsrHeading("Producent odpowiedzialny"));
  assert.ok(looksLikeGpsrHeading("Podmiot odpowiedzialny w UE"));
});

test("looksLikeGpsrHeading odrzuca niepowiązane nagłówki", () => {
  assert.equal(looksLikeGpsrHeading("Opis produktu"), false);
  assert.equal(looksLikeGpsrHeading("Dostawa i zwroty"), false);
  assert.equal(looksLikeGpsrHeading(""), false);
  assert.equal(looksLikeGpsrHeading(undefined), false);
});
