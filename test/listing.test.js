import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreGroupDescriptor,
  pickBestGroup,
  pickNextLinkCandidate,
  pickLoadMoreCandidate,
  pickBestProductLinkCandidate,
  isLikelyPaginationLinkCandidate,
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

test("pickLoadMoreCandidate rozpoznaje polskie i angielskie warianty", () => {
  assert.ok(pickLoadMoreCandidate([{ text: "Załaduj więcej" }]));
  assert.ok(pickLoadMoreCandidate([{ text: "Load more" }]));
  assert.equal(pickLoadMoreCandidate([{ text: "Dodaj do koszyka" }]), undefined || null);
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
