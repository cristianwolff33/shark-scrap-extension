/**
 * @file Wykrywanie listy produktów na stronie kategorii: grupowanie powtarzalnych
 * "kart produktu" oraz wykrywanie prostej paginacji (next-link / numery stron / load-more).
 * Część czysta (scoring, wybór kandydata) jest oddzielona od skanowania DOM,
 * żeby dało się ją testować bez prawdziwej przeglądarki.
 */

import { cssEscape } from "./selectors.js";

// Dopuszcza zarówno ceny z groszami ("19,99 zł", "19.99"), jak i całkowite ("199 zł") —
// wiele sklepów PL/EU nie pokazuje groszy, a wcześniejsza wersja regexu wymagała ich zawsze,
// co zaniżało wynik scoreGroupDescriptor/scoreProductLinkCandidate na takich stronach.
// Uwaga: `\b` po walucie NIE działa dla "zł" (JS \b traktuje "ł" jako znak nie-słowny, więc
// granica po "ł" nigdy się nie domyka) — używamy zamiast tego (?!\w), które sprawdza tylko,
// że dalej nie ciągnie się kolejna litera/cyfra ASCII (np. nie dopasuje "eur" w "eurotrip").
export const PRICE_LIKE_RE =
  /\d[\d\s]{0,9}[.,]\d{2}\s?(zł|pln|eur|€|\$|usd|gbp|£)?|\d[\d\s]{0,9}\s?(zł|pln|eur|€|\$|usd|gbp|£)(?!\w)/i;
const NEXT_TEXT_RE = /(next|dalej|następn|kolejn|»|›|→|nast\.)/i;
const LOAD_MORE_TEXT_RE =
  /(load more|show more|view more|załaduj więcej|pokaż więcej|pokaż kolejne|wczytaj więcej|wczytaj kolejne|more products|zobacz więcej)/i;
// "porówna(j)"/"ulubion" to rdzenie słów, nie pełne wyrazy — polskie odmiany (porównaj/porównanie,
// ulubione/ulubionych/ulubionego/ulubionej) inaczej by nie złapały się na dopasowanie substring.
// URL-e czasem mają usunięte znaki diakrytyczne (porownaj zamiast porównaj), stąd oba warianty.
const BAD_PRODUCT_LINK_RE =
  /(add-to-cart|add_to_cart|koszyk|cart|basket|checkout|wishlist|quick-?view|compare|por[oó]wna|ulubion|newsletter|login|zaloguj|konto|account|search|szukaj)/i;
const PRODUCT_URL_HINT_RE = /(\/(product|produkt|produkty|p|item|towar|produit|artikel)\b|[?&](product|product_id|id_product|sku)=)/i;
const PAGE_URL_HINT_RE = /(\/(page|strona|pagina)\/\d+|[?&](page|paged|pagenumber|strona|pagina|product-page)=\d+)/i;

/**
 * @typedef {Object} GroupDescriptor
 * @property {string} selector - selektor identyfikujący grupę (np. "div.product-card")
 * @property {number} count
 * @property {number} withLink
 * @property {number} withImage
 * @property {number} withPriceLike
 * @property {number} avgTextLength
 */

/**
 * @param {GroupDescriptor} d
 *
 * UWAGA: liczba elementów (`count`) jest ograniczona do max. 30 punktów, a cena jest
 * najsilniejszym sygnałem (waga 60), nie dodatkowym bonusem. Wcześniejsza wersja liczyła
 * `min(count, 60) + linkRatio*20 + priceRatio*30 + imageRatio*15` — przy dużych menu
 * nawigacyjnych (np. `<li class="menu-item">` w mega-menu, gdzie KAŻDY element ma link,
 * ale żaden nie ma ceny/zdjęcia) sam `count` potrafił zdominować wynik i menu (np. 86
 * pozycji) wygrywało ze świetnie pasującą, ale mniejszą siatką produktów (np. 8 kart z
 * ceną+zdjęciem+linkiem) — realny przypadek zaobserwowany na motos.pl.
 *
 * Grupa bez ŻADNEJ ceny i ŻADNEGO zdjęcia jest odrzucana całkowicie (-Infinity), nie tylko
 * karana — wtyczka ma łapać wyłącznie karty produktów, a "same linki bez ceny/zdjęcia" to
 * prawie zawsze nawigacja, breadcrumb, menu albo lista tagów/filtrów, nigdy realna karta
 * produktu w sklepie e-commerce.
 */
export function scoreGroupDescriptor(d) {
  if (!d || d.count < 3) return -Infinity;
  const priceRatio = d.withPriceLike / d.count;
  const linkRatio = d.withLink / d.count;
  const imageRatio = d.withImage / d.count;
  if (priceRatio === 0 && imageRatio === 0) return -Infinity;
  let score = 0;
  score += Math.min(d.count, 30);
  score += linkRatio * 10;
  score += priceRatio * 60;
  score += imageRatio * 20;
  if (d.avgTextLength < 5 || d.avgTextLength > 4000) score -= 50;
  return score;
}

/** @param {GroupDescriptor[]} descriptors */
export function pickBestGroup(descriptors) {
  const scored = descriptors
    .map((d) => ({ d, score: scoreGroupDescriptor(d) }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].d : null;
}

/**
 * @typedef {Object} LinkCandidate
 * @property {string} selector
 * @property {string} text
 * @property {string} rel
 * @property {string} [ariaLabel]
 * @property {boolean} hasHref
 */

/**
 * Zwraca najlepszego kandydata na link "następna strona", albo null.
 * `rel` bywa wielowartościowe (np. `rel="next nofollow"`), więc porównujemy tokenami, nie
 * całym stringiem. Sprawdzamy też aria-label — sporo sklepów renderuje "next" jako sama
 * ikona/strzałkę bez tekstu, opisaną wyłącznie przez aria-label.
 * @param {LinkCandidate[]} candidates
 */
export function pickNextLinkCandidate(candidates) {
  const withHref = candidates.filter((c) => c.hasHref);
  const relNext = withHref.find((c) => (c.rel || "").toLowerCase().split(/\s+/).includes("next"));
  if (relNext) return relNext;
  return (
    withHref.find(
      (c) => NEXT_TEXT_RE.test((c.text || "").trim()) || NEXT_TEXT_RE.test((c.ariaLabel || "").trim())
    ) || null
  );
}

/**
 * Zwraca najlepszego kandydata na przycisk "załaduj więcej", albo null. Pomija kandydatów
 * oznaczonych jako disabled (np. przycisk został już wyłączony, bo katalog nie ma więcej
 * stron) i sprawdza aria-label obok tekstu (ikony bez widocznego tekstu).
 * @param {LinkCandidate[]} candidates
 */
export function pickLoadMoreCandidate(candidates) {
  return (
    candidates.find(
      (c) =>
        !c.disabled &&
        (LOAD_MORE_TEXT_RE.test((c.text || "").trim()) || LOAD_MORE_TEXT_RE.test((c.ariaLabel || "").trim()))
    ) || null
  );
}

/**
 * Sprawdza, czy href realnie prowadzi gdzieś (nie "#" i nie "javascript:...") — odróżnia
 * prawdziwy link "następna strona" (bezpieczny do pobrania przez fetch) od przycisku
 * sterowanego czystym JS/AJAX, gdzie href jest tylko placeholderem, a treść zmienia się przez
 * JS bez przeładowania strony. Takie przypadki content/detector.js obsługuje osobno —
 * klikając na ŻYWEJ stronie (patrz tryb paginacji "click_next"), bo fetch()+DOMParser nigdy by
 * nie zobaczył efektu kliknięcia.
 */
export function isNavigableHref(href) {
  const value = String(href || "").trim();
  if (!value || value === "#") return false;
  if (/^javascript:/i.test(value)) return false;
  return true;
}

/**
 * Punktuje link w obrębie karty produktu. Najczęstszy bug: pierwszy link w karcie prowadzi do
 * koszyka/wishlisty, a właściwy link jest na zdjęciu albo tytule.
 */
export function scoreProductLinkCandidate(candidate) {
  const href = String(candidate?.href || "").trim();
  if (!href || href.startsWith("#") || /^javascript:/i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
    return -Infinity;
  }
  const text = String(candidate?.text || "").trim();
  let score = 0;
  if (candidate?.hasImage) score += 35;
  if (candidate?.hasPriceNearby) score += 25;
  if (text.length >= 3 && text.length <= 180) score += 20;
  if (PRODUCT_URL_HINT_RE.test(href)) score += 20;
  if (BAD_PRODUCT_LINK_RE.test(href) || BAD_PRODUCT_LINK_RE.test(text)) score -= 90;
  return score;
}

export function pickBestProductLinkCandidate(candidates) {
  const scored = (candidates || [])
    .map((candidate) => ({ candidate, score: scoreProductLinkCandidate(candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].candidate : null;
}

/** Rozpoznaje linki paginacji typu next/rel, numery stron i popularne query/path page=N. */
export function isLikelyPaginationLinkCandidate(candidate) {
  const href = String(candidate?.href || "").trim();
  if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return false;
  const text = String(candidate?.text || "").trim();
  const aria = String(candidate?.ariaLabel || "").trim();
  const rel = String(candidate?.rel || "").toLowerCase();
  if (rel.split(/\s+/).includes("next") || rel.split(/\s+/).includes("prev")) return true;
  if (NEXT_TEXT_RE.test(text) || NEXT_TEXT_RE.test(aria)) return true;
  if (/^\d{1,4}$/.test(text)) return true;
  if (/page|strona|pagina/i.test(aria) && /\d/.test(`${aria} ${text}`)) return true;
  return PAGE_URL_HINT_RE.test(href);
}

/**
 * Buduje sygnaturę grupowania elementu (tag + pierwsza "stabilna" klasa, patrz selectors.js).
 * Zwrócona wartość jest jednocześnie poprawnym selektorem CSS gotowym do użycia w
 * querySelectorAll — klasa jest escapowana (cssEscape), bo klasy narzędziowe (np. Tailwind
 * "w-1/2", "lg:grid-cols-4") zawierają znaki, które w nieescapowanym selektorze CSS są
 * błędem składni i wywalają całe querySelectorAll (a więc cały auto-skan) wyjątkiem.
 * Eksportowane osobno, żeby impure skaner DOM (content/detector.js) mógł jej użyć bez
 * duplikowania logiki wyboru klasy.
 */
export function groupSignature(tag, stableClass) {
  return stableClass ? `${tag}.${cssEscape(stableClass)}` : tag;
}

/**
 * Wariant groupSignature dla elementów bez żadnej "stabilnej" klasy (np. wyłącznie klasy
 * hashowane przez CSS modules/emotion), ale za to oznaczonych atrybutem testowym
 * (data-testid/data-test/...) — bardzo częste w komponentowych frontendach. Bez tego
 * fallbacku takie strony w ogóle nie miały żadnej sygnatury grupowania i detekcja listingu
 * zawsze kończyła się "nie znaleziono".
 * @param {string} tag
 * @param {string} attr
 * @param {string} value
 */
export function groupSignatureForAttr(tag, attr, value) {
  const safeValue = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${tag}[${attr}="${safeValue}"]`;
}
