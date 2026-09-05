import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeGpsrHeading, detectCurrencyFromText, firstUrlFromSrcset, largestUrlFromSrcset, pickImageUrl } from "../lib/dom-heuristics.js";

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

test("detectCurrencyFromText rozpoznaje popularne waluty PL/EU z tekstu ceny", () => {
  assert.equal(detectCurrencyFromText("199,99 zł"), "PLN");
  assert.equal(detectCurrencyFromText("od 49 EUR"), "EUR");
  assert.equal(detectCurrencyFromText("€19.99"), "EUR");
  assert.equal(detectCurrencyFromText("$19.99"), "USD");
  assert.equal(detectCurrencyFromText("£15"), "GBP");
  assert.equal(detectCurrencyFromText("199 Kč"), "CZK");
  assert.equal(detectCurrencyFromText("1990 Ft"), "HUF");
});

test("detectCurrencyFromText zwraca null gdy nic nie pasuje", () => {
  assert.equal(detectCurrencyFromText("199,99"), null);
  assert.equal(detectCurrencyFromText(""), null);
  assert.equal(detectCurrencyFromText(undefined), null);
});

test("firstUrlFromSrcset bierze pierwszy adres z listy kandydatów", () => {
  assert.equal(firstUrlFromSrcset("/img-320.jpg 320w, /img-640.jpg 640w"), "/img-320.jpg");
  assert.equal(firstUrlFromSrcset("/img-1x.jpg 1x, /img-2x.jpg 2x"), "/img-1x.jpg");
  assert.equal(firstUrlFromSrcset(""), "");
  assert.equal(firstUrlFromSrcset(undefined), "");
});

function fakeImgEl(attrs, { closestLink = null } = {}) {
  return {
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    closest: (selector) => {
      if (selector === "a[href]" && closestLink) {
        return { getAttribute: (name) => (name === "href" ? closestLink.href : null) };
      }
      return null;
    },
  };
}

test("pickImageUrl preferuje atrybuty lazy-load nad src-placeholderem", () => {
  // Realny bug: src to placeholder (base64 blank gif), prawdziwy adres jest w data-src —
  // wcześniejsza wersja (src PIERWSZY) zwracała placeholder.
  const el = fakeImgEl({ src: "data:image/gif;base64,R0lGOD==", "data-src": "/produkty/x200.jpg" });
  assert.equal(pickImageUrl(el), "/produkty/x200.jpg");
});

test("pickImageUrl spada na data-original, potem data-srcset, potem src", () => {
  assert.equal(pickImageUrl(fakeImgEl({ "data-original": "/a.jpg", src: "/placeholder.gif" })), "/a.jpg");
  assert.equal(pickImageUrl(fakeImgEl({ "data-srcset": "/b-320.jpg 320w", src: "/placeholder.gif" })), "/b-320.jpg");
  assert.equal(pickImageUrl(fakeImgEl({ src: "/c.jpg" })), "/c.jpg");
  assert.equal(pickImageUrl(fakeImgEl({})), "");
});

test("largestUrlFromSrcset bierze NAJWIĘKSZY kandydat (deskryptory 'w'), nie pierwszy", () => {
  assert.equal(largestUrlFromSrcset("/img-320.jpg 320w, /img-1600.jpg 1600w, /img-640.jpg 640w"), "/img-1600.jpg");
  assert.equal(largestUrlFromSrcset("/only.jpg"), "/only.jpg"); // pojedynczy kandydat bez deskryptora
  assert.equal(largestUrlFromSrcset(""), "");
  assert.equal(largestUrlFromSrcset(undefined), "");
});

test("largestUrlFromSrcset radzi sobie z deskryptorami gęstości (1x/2x/3x)", () => {
  assert.equal(largestUrlFromSrcset("/img-1x.jpg 1x, /img-3x.jpg 3x, /img-2x.jpg 2x"), "/img-3x.jpg");
});

test("pickImageUrl: miniaturka opakowana w link lightboxa do pełnego zdjęcia wygrywa nad wszystkim innym", () => {
  // Najczęstszy realny przypadek: galeria pokazuje MINIATURKĘ w <img>, a pełny obraz jest pod
  // href linku-lightboxa (fancybox/photoswipe/magnific-popup) — user zgłosił dokładnie ten
  // problem (pobierane były miniaturki, nie dało się ich użyć).
  const el = fakeImgEl(
    { src: "/miniaturki/produkt-150x150.jpg", "data-src": "/miniaturki/produkt-300x300.jpg" },
    { closestLink: { href: "/pelne/produkt-oryginal.jpg" } }
  );
  assert.equal(pickImageUrl(el), "/pelne/produkt-oryginal.jpg");
});

test("pickImageUrl ignoruje link opakowujący, gdy href NIE wygląda na obraz (np. link do strony produktu)", () => {
  const el = fakeImgEl({ src: "/miniaturka.jpg" }, { closestLink: { href: "/produkt/12345" } });
  assert.equal(pickImageUrl(el), "/miniaturka.jpg");
});

test("pickImageUrl preferuje dedykowany atrybut zoom/full nad lazy-load i srcset", () => {
  assert.equal(pickImageUrl(fakeImgEl({ "data-zoom-image": "/pelny.jpg", "data-src": "/mini.jpg", src: "/placeholder.gif" })), "/pelny.jpg");
  assert.equal(pickImageUrl(fakeImgEl({ "data-large": "/duzy.jpg", srcset: "/mini-320.jpg 320w" })), "/duzy.jpg");
});

test("pickImageUrl bierze NAJWIĘKSZY kandydat z srcset, nie pierwszy (miniaturka vs pełny rozmiar)", () => {
  const el = fakeImgEl({ srcset: "/produkt-150w.jpg 150w, /produkt-1200w.jpg 1200w, /produkt-600w.jpg 600w" });
  assert.equal(pickImageUrl(el), "/produkt-1200w.jpg");
});
