/**
 * @file Wykrywanie listy produktów na stronie kategorii: grupowanie powtarzalnych
 * "kart produktu" oraz wykrywanie prostej paginacji (next-link / numery stron / load-more).
 * Część czysta (scoring, wybór kandydata) jest oddzielona od skanowania DOM,
 * żeby dało się ją testować bez prawdziwej przeglądarki.
 */

export const PRICE_LIKE_RE = /\d[\d\s]{0,9}[.,]\d{2}\s?(zł|pln|eur|€|\$|usd|gbp|£)?/i;
const NEXT_TEXT_RE = /(next|dalej|następn|kolejn|»|nast\.)/i;
const LOAD_MORE_TEXT_RE = /(load more|załaduj więcej|pokaż więcej|wczytaj więcej|more products|zobacz więcej)/i;
const BAD_PRODUCT_LINK_RE = /(add-to-cart|add_to_cart|koszyk|cart|basket|checkout|wishlist|compare|login|konto|account|search|szukaj)/i;
const PRODUCT_URL_HINT_RE = /(\/(product|produkt|produkty|p|item|towar)\b|[?&](product|product_id|id_product|sku)=)/i;
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

/** @param {GroupDescriptor} d */
export function scoreGroupDescriptor(d) {
  if (!d || d.count < 3) return -Infinity;
  let score = 0;
  score += Math.min(d.count, 60);
  score += (d.withLink / d.count) * 20;
  score += (d.withPriceLike / d.count) * 30;
  score += (d.withImage / d.count) * 15;
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
 * @property {boolean} hasHref
 */

/** Zwraca najlepszego kandydata na link "następna strona", albo null. @param {LinkCandidate[]} candidates */
export function pickNextLinkCandidate(candidates) {
  const withHref = candidates.filter((c) => c.hasHref);
  const relNext = withHref.find((c) => (c.rel || "").toLowerCase() === "next");
  if (relNext) return relNext;
  return withHref.find((c) => NEXT_TEXT_RE.test((c.text || "").trim())) || null;
}

/** Zwraca najlepszego kandydata na przycisk "załaduj więcej", albo null. @param {LinkCandidate[]} candidates */
export function pickLoadMoreCandidate(candidates) {
  return candidates.find((c) => LOAD_MORE_TEXT_RE.test((c.text || "").trim())) || null;
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
 * Eksportowane osobno, żeby impure skaner DOM (content/detector.js) mógł jej użyć bez
 * duplikowania logiki wyboru klasy.
 */
export function groupSignature(tag, stableClass) {
  return stableClass ? `${tag}.${stableClass}` : tag;
}
