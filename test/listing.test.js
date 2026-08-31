import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreGroupDescriptor, pickBestGroup, pickNextLinkCandidate, pickLoadMoreCandidate } from "../lib/listing.js";

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
