import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveUrl,
  normalizeCrawlUrl,
  dedupe,
  capArray,
  guessAdapterMode,
  scoreFieldSample,
  pickBestSample,
  formatScanProgress,
  isAutoFollowablePagination,
} from "../lib/crawler.js";

test("resolveUrl rozwiązuje względny URL względem base", () => {
  assert.equal(resolveUrl("/produkt/123", "https://sklep.pl/kategoria/meble"), "https://sklep.pl/produkt/123");
  assert.equal(resolveUrl("https://inny.pl/x", "https://sklep.pl/"), "https://inny.pl/x");
});

test("resolveUrl zwraca null zamiast rzucać na pustym/złym wejściu", () => {
  assert.equal(resolveUrl("", "https://sklep.pl/"), null);
  assert.equal(resolveUrl(null, "https://sklep.pl/"), null);
  assert.equal(resolveUrl("::::nie-url::::", "not a base at all"), null);
});

test("normalizeCrawlUrl usuwa hash, ale zostawia query do paginacji", () => {
  assert.equal(normalizeCrawlUrl("https://sklep.pl/kategoria?page=2#products"), "https://sklep.pl/kategoria?page=2");
  assert.equal(normalizeCrawlUrl("nie-url"), null);
});

test("dedupe zachowuje kolejność pierwszego wystąpienia i odrzuca puste", () => {
  assert.deepEqual(dedupe(["a", "b", "a", "", null, "c", "b"]), ["a", "b", "c"]);
});

test("capArray obcina do limitu bez mutacji wejścia", () => {
  const input = [1, 2, 3, 4, 5];
  const out = capArray(input, 3);
  assert.deepEqual(out, [1, 2, 3]);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
});

test("capArray bez limitu (0/Infinity/NaN) zwraca kopię całości", () => {
  assert.deepEqual(capArray([1, 2], 0), [1, 2]);
  assert.deepEqual(capArray([1, 2], Infinity), [1, 2]);
  assert.deepEqual(capArray([1, 2], NaN), [1, 2]);
});

test("guessAdapterMode: name+price ze statycznego fetcha => requests", () => {
  const fields = { product_name: { value: "Krzesło" }, price: { value: "199.99" } };
  assert.equal(guessAdapterMode(fields), "requests");
});

test("guessAdapterMode: brak name lub price => playwright", () => {
  assert.equal(guessAdapterMode({ product_name: { value: "Krzesło" } }), "playwright");
  assert.equal(guessAdapterMode({}), "playwright");
  assert.equal(guessAdapterMode(undefined), "playwright");
});

test("scoreFieldSample liczy tylko niepuste wartości", () => {
  const sample = {
    product_name: { value: "X" },
    price: { value: "" },
    sku: { value: undefined },
    brand: { value: "Acme" },
  };
  assert.equal(scoreFieldSample(sample), 2);
});

test("pickBestSample wybiera próbkę z największą liczbą wypełnionych pól", () => {
  const weak = { product_name: { value: "X" } };
  const strong = { product_name: { value: "X" }, price: { value: "10" }, sku: { value: "A1" } };
  assert.equal(pickBestSample([weak, strong]), strong);
  assert.equal(pickBestSample([]), null);
});

test("formatScanProgress buduje czytelny opis z/bez znanych totali", () => {
  assert.equal(
    formatScanProgress({ pagesVisited: 2, pagesTotal: 5, productsFound: 12, productsTotal: 40 }),
    "strona 2/5 — 12/40 produktów"
  );
  assert.equal(
    formatScanProgress({ pagesVisited: 1, pagesTotal: 0, productsFound: 3, productsTotal: 0 }),
    "strona 1 — 3 produktów"
  );
});

test("isAutoFollowablePagination: tylko next_link z selektorem", () => {
  assert.equal(isAutoFollowablePagination({ mode: "next_link", next_selector: "a.next" }), true);
  assert.equal(isAutoFollowablePagination({ mode: "next_link", next_selector: "" }), false);
  assert.equal(isAutoFollowablePagination({ mode: "load_more", next_selector: "" }), false);
  assert.equal(isAutoFollowablePagination({ mode: "none" }), false);
  assert.equal(isAutoFollowablePagination(null), false);
});
