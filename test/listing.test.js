import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreGroupDescriptor,
  pickBestGroup,
  pickNextLinkCandidate,
  pickLoadMoreCandidate,
  pickBestProductLinkCandidate,
  isLikelyPaginationLinkCandidate,
  groupSignature,
  groupSignatureForAttr,
  scoreProductLinkCandidate,
  PRICE_LIKE_RE,
} from "../lib/listing.js";

test("scoreGroupDescriptor odrzuca grupy mniejsze niż 3 elementy", () => {
  assert.equal(scoreGroupDescriptor({ count: 2, withLink: 2, withImage: 2, withPriceLike: 2, avgTextLength: 50 }), -Infinity);
});

test("pickBestGroup wybiera grupę z linkami, cenami i zdjęciami ponad grupę bez tych cech", () => {
  const groups = [
    { selector: "div.banner", count: 10, withLink: 0, withImage: 10, withPriceLike: 0, avgTextLength: 20 },
    { selector: "div.product-card", count: 24, withLink: 24, withImage: 24, withPriceLike: 22, avgTextLength: 80 },
  ];
  const best = pickBestGroup(groups);
  assert.equal(best.selector, "div.product-card");
});

test("pickBestGroup: duże menu nawigacyjne (dużo linków, zero cen/zdjęć) NIE bije małej siatki produktów z cenami", () => {
  // Realny przypadek z motos.pl: mega-menu ma 86 <li class="menu-item"> (same linki, bez
  // ceny/zdjęcia), a właściwe karty produktów na stronie kategorii to tylko 8 elementów
  // (div.kw-product) — ale mają cenę, zdjęcie i link. Poprzednia wersja scoreGroupDescriptor
  // wybierała menu, bo liczba elementów ważyła więcej niż sygnał "to wygląda jak produkt".
  const groups = [
    { selector: "li.menu-item", count: 86, withLink: 86, withImage: 0, withPriceLike: 0, avgTextLength: 33 },
    { selector: "div.kw-product", count: 8, withLink: 8, withImage: 8, withPriceLike: 8, avgTextLength: 188 },
  ];
  const best = pickBestGroup(groups);
  assert.equal(best.selector, "div.kw-product");
});

test("scoreGroupDescriptor odrzuca całkowicie grupy bez ceny i bez zdjęcia (nawigacja/menu/breadcrumb, nigdy karty produktu)", () => {
  const menuLike = { count: 20, withLink: 20, withImage: 0, withPriceLike: 0, avgTextLength: 40 };
  assert.equal(scoreGroupDescriptor(menuLike), -Infinity);
});

test("scoreGroupDescriptor: liczba elementów (count) nie dominuje już wyniku samodzielnie", () => {
  // Karuzela/lista marek: dużo elementów ze zdjęciem i linkiem, ale bez ceny — realny
  // przypadek (div.owl-item / div.kw-item na motos.pl, 44 elementy, karuzela producentów).
  const brandCarousel = { count: 44, withLink: 44, withImage: 44, withPriceLike: 0, avgTextLength: 0 };
  const smallProductGrid = { count: 8, withLink: 8, withImage: 8, withPriceLike: 8, avgTextLength: 188 };
  assert.ok(scoreGroupDescriptor(smallProductGrid) > scoreGroupDescriptor(brandCarousel));
});

test("pickNextLinkCandidate preferuje rel=next", () => {
  const candidates = [
    { text: "Dalej", rel: "", hasHref: true },
    { text: "Coś innego", rel: "next", hasHref: true },
  ];
  assert.equal(pickNextLinkCandidate(candidates).rel, "next");
});

test("pickNextLinkCandidate spada do dopasowania tekstu", () => {
  const candidates = [{ text: "Następna strona »", rel: "", hasHref: true }];
  assert.ok(pickNextLinkCandidate(candidates));
});

test("pickNextLinkCandidate rozpoznaje rel wielowartościowe (rel='next nofollow')", () => {
  const candidates = [{ text: "", rel: "nofollow next", hasHref: true }];
  assert.ok(pickNextLinkCandidate(candidates));
});

test("pickNextLinkCandidate rozpoznaje aria-label gdy link to sama ikona bez tekstu", () => {
  const candidates = [{ text: "", ariaLabel: "Następna strona", rel: "", hasHref: true }];
  assert.ok(pickNextLinkCandidate(candidates));
});

test("pickNextLinkCandidate ignoruje kandydatów bez href", () => {
  const candidates = [{ text: "Next", rel: "next", hasHref: false }];
  assert.equal(pickNextLinkCandidate(candidates), null);
});

test("pickLoadMoreCandidate rozpoznaje polskie i angielskie warianty", () => {
  assert.ok(pickLoadMoreCandidate([{ text: "Załaduj więcej" }]));
  assert.ok(pickLoadMoreCandidate([{ text: "Load more" }]));
  assert.ok(pickLoadMoreCandidate([{ text: "Show more" }]));
  assert.ok(pickLoadMoreCandidate([{ text: "Wczytaj kolejne" }]));
  assert.equal(pickLoadMoreCandidate([{ text: "Dodaj do koszyka" }]), undefined || null);
});

test("pickLoadMoreCandidate pomija disabled i sprawdza aria-label", () => {
  assert.equal(pickLoadMoreCandidate([{ text: "Load more", disabled: true }]), null);
  assert.ok(pickLoadMoreCandidate([{ text: "", ariaLabel: "Pokaż więcej produktów" }]));
});

test("pickBestProductLinkCandidate omija koszyk/wishlist i wybiera link produktu", () => {
  const best = pickBestProductLinkCandidate([
    { href: "/cart/add?id=1", text: "Dodaj do koszyka", hasImage: false, hasPriceNearby: true },
    { href: "/produkt/krzeslo-drewniane", text: "Krzeslo drewniane", hasImage: true, hasPriceNearby: true },
  ]);

  assert.equal(best.href, "/produkt/krzeslo-drewniane");
});

test("pickBestProductLinkCandidate zwraca null gdy ma tylko link akcji", () => {
  assert.equal(
    pickBestProductLinkCandidate([{ href: "/cart/add?id=1", text: "Dodaj do koszyka", hasImage: false, hasPriceNearby: true }]),
    null
  );
});

test("isLikelyPaginationLinkCandidate rozpoznaje next, numery stron i query page", () => {
  assert.equal(isLikelyPaginationLinkCandidate({ href: "/kategoria?page=2", text: "", rel: "" }), true);
  assert.equal(isLikelyPaginationLinkCandidate({ href: "/kategoria/strona/3", text: "", rel: "" }), true);
  assert.equal(isLikelyPaginationLinkCandidate({ href: "/kategoria?p=2", text: "2", rel: "" }), true);
  assert.equal(isLikelyPaginationLinkCandidate({ href: "/produkt/krzeslo", text: "Krzeslo", rel: "" }), false);
});

test("groupSignature escapuje klasy narzędziowe (Tailwind), żeby nie wywalić querySelectorAll", () => {
  // "/" i ":" w nieescapowanym selektorze CSS to błąd składni - to jest realny crash bug na
  // stronach z Tailwindem, gdzie taka klasa (np. "w-1/2", "lg:grid-cols-4") łatwo trafia jako
  // "stabilna" klasa (nie pasuje do wzorców hash-owych z selectors.js).
  assert.equal(groupSignature("div", "w-1/2"), "div.w-1\\/2");
  assert.equal(groupSignature("div", "lg:grid-cols-4"), "div.lg\\:grid-cols-4");
  assert.equal(groupSignature("div", "product-card"), "div.product-card");
  assert.equal(groupSignature("div", null), "div");
});

test("groupSignatureForAttr buduje poprawny selektor atrybutowy i eskejpuje cudzysłów w wartości", () => {
  assert.equal(groupSignatureForAttr("li", "data-testid", "product-card"), 'li[data-testid="product-card"]');
  assert.equal(groupSignatureForAttr("li", "data-testid", 'weird"value'), 'li[data-testid="weird\\"value"]');
});

test("PRICE_LIKE_RE rozpoznaje też ceny całkowite bez groszy (częste w PL/EU)", () => {
  assert.ok(PRICE_LIKE_RE.test("199 zł"));
  assert.ok(PRICE_LIKE_RE.test("od 49 EUR"));
  assert.ok(PRICE_LIKE_RE.test("19,99 zł"));
  assert.ok(PRICE_LIKE_RE.test("19.99"));
  assert.equal(PRICE_LIKE_RE.test("Kategoria: Meble"), false);
});

test("scoreProductLinkCandidate odrzuca dodatkowe warianty złych linków (quick view, porównaj, ulubione)", () => {
  assert.ok(scoreProductLinkCandidate({ href: "/quick-view/123", text: "Szybki podgląd", hasImage: true, hasPriceNearby: true }) < 0);
  assert.ok(scoreProductLinkCandidate({ href: "/porownaj?id=1", text: "Porównaj", hasImage: true, hasPriceNearby: true }) < 0);
  assert.ok(scoreProductLinkCandidate({ href: "/ulubione/dodaj/1", text: "Dodaj do ulubionych", hasImage: true, hasPriceNearby: true }) < 0);
});
