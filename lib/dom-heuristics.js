/**
 * @file Ostatnia linia detekcji: typowe wzorce DOM używane w polskich/europejskich sklepach
 * e-commerce, gdy strona nie ma JSON-LD ani microdata (albo brakuje w nich pola).
 * Lista kandydatów jest świadomie krótka i skupiona na e-commerce — to NIE jest generyczny
 * web scraper (patrz ograniczenia w specyfikacji MVP).
 */

/** @type {Record<string, string[]>} */
export const CANDIDATE_SELECTORS = {
  product_name: ["h1.product-title", "h1[itemprop=name]", "h1.product-name", "h1"],
  price: [
    "[itemprop=price]",
    ".price .amount",
    ".product-price .price",
    ".price--current",
    ".price:not(.price--old)",
    "span.price",
  ],
  old_price: [".price--old", ".price-old", "del.price", "s.price", ".product-price__old"],
  sku: ["[itemprop=sku]", ".product-sku", ".sku-value", "[data-sku]"],
  ean: ["[itemprop=gtin13]", ".product-ean", "[data-ean]"],
  brand: ["[itemprop=brand]", ".product-brand", ".brand-name", "a.brand"],
  availability: [".stock-status", ".availability", ".product-availability", "[data-availability]"],
  description: ["#description", ".product-description", "[itemprop=description]", ".product-details__description"],
  category: ["nav.breadcrumb", "ol.breadcrumb", ".breadcrumbs", '[aria-label="breadcrumb" i]'],
};

export const IMAGE_GALLERY_SELECTORS = [
  // WooCommerce (jedna z najpopularniejszych platform e-commerce) — bez tego selektora
  // detekcja galerii kompletnie milczała na każdym sklepie WooCommerce, zero dopasowań, mimo
  // że zdjęcia w pełnej rozdzielczości były tuż obok w standardowym markupie. Realny przypadek
  // znaleziony na motos.pl.
  ".woocommerce-product-gallery img",
  ".woocommerce-product-gallery__image img",
  ".product-gallery img",
  ".product-images img",
  "[data-gallery] img",
  ".gallery img",
  "figure img",
  "picture img",
];

/**
 * Atrybuty lazy-load w kolejności priorytetu — SPRAWDZANE PRZED `src`. Przy lazy-loadingu `src`
 * bardzo często jest tylko placeholderem (1x1 gif / base64 blank / spinner), a prawdziwy URL
 * zdjęcia siedzi w jednym z tych atrybutów. Poprzednia wersja czytała `src || data-src`
 * (src PIERWSZY) — dla lazy-loadowanych obrazków to zwracało placeholder, nigdy nie docierając
 * do prawdziwego adresu.
 */
const LAZY_IMAGE_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-echo"];

/**
 * Atrybuty "pełny rozmiar/zoom" — wiele galerii pokazuje w `src`/lazy-attrs MINIATURKĘ, a pełny
 * obraz (do lightboxa/powiększenia) trzyma osobno w jednym z tych atrybutów na TYM SAMYM <img>.
 * Sprawdzane PRZED lazy-load i src, bo to jednoznaczny sygnał "to jest pełny rozmiar", nie
 * zgadywanie.
 */
const FULL_IMAGE_DATA_ATTRS = [
  "data-zoom-image",
  "data-zoom-src",
  "data-zoom",
  "data-large_image", // WooCommerce standard — PODKREŚLNIK, nie myślnik (realny przypadek: motos.pl)
  "data-large-image",
  "data-large",
  "data-full",
  "data-full-src",
  "data-big",
  "data-hires",
  "data-original-src",
  "data-image-large",
  "data-photoswipe-src",
];

const IMAGE_HREF_RE = /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;

/**
 * Miniaturki w galeriach są bardzo często opakowane w `<a href="pelny-obraz.jpg">` (lightbox —
 * fancybox/photoswipe/magnific-popup itp.) — to sam SKLEP wskazuje, gdzie jest pełny rozmiar,
 * więc to najpewniejszy z sygnałów, sprawdzany jako pierwszy.
 * @param {Element} el
 */
function fullImageHrefFromWrappingLink(el) {
  if (!el.closest) return "";
  let link;
  try {
    link = el.closest("a[href]");
  } catch {
    return "";
  }
  if (!link) return "";
  const href = link.getAttribute("href") || "";
  return IMAGE_HREF_RE.test(href) ? href : "";
}

/**
 * Zwraca NAJWIĘKSZY kandydat z atrybutu `srcset`/`data-srcset` (format "url 320w, url2 640w" albo
 * "url 1x, url2 2x") — wcześniejsza wersja brała PIERWSZY, a kolejność w praktyce bywa różna;
 * poza tym przy wyborze między miniaturką a pełnym rozmiarem oczywiście chcemy większy.
 */
export function largestUrlFromSrcset(value) {
  if (!value) return "";
  let bestUrl = "";
  let bestScore = -1;
  for (const candidate of String(value).split(",")) {
    const parts = candidate.trim().split(/\s+/);
    const url = parts[0] || "";
    if (!url) continue;
    const descriptor = parts[1] || "";
    const widthMatch = /^(\d+)w$/.exec(descriptor);
    const densityMatch = /^(\d+(?:\.\d+)?)x$/.exec(descriptor);
    // Deskryptory gęstości (1x/2x/3x) nie są bezpośrednio porównywalne z szerokością w px, ale
    // jako heurystyka "który kandydat jest większy" wystarczy je przeskalować w górę.
    const score = widthMatch ? Number(widthMatch[1]) : densityMatch ? Number(densityMatch[1]) * 1000 : 0;
    if (score >= bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/** Zwraca pierwszy adres URL z atrybutu `srcset`/`data-srcset` (format "url 1x, url2 2x, ..."). */
export function firstUrlFromSrcset(value) {
  if (!value) return "";
  const first = String(value).split(",")[0]?.trim() || "";
  return first.split(/\s+/)[0] || "";
}

/**
 * Wybiera adres zdjęcia w kolejności malejącej pewności, że to PEŁNY rozmiar, nie miniaturka:
 * 1. Link lightboxa opakowujący `<img>` (sklep sam wskazuje pełny obraz).
 * 2. Dedykowany atrybut zoom/full/large na `<img>`.
 * 3. Lazy-load (`src` bywa tylko placeholderem).
 * 4. Największy kandydat z `srcset`/`data-srcset`.
 * 5. `src` jako ostateczność.
 * @param {Element} el
 */
export function pickImageUrl(el) {
  const fromLink = fullImageHrefFromWrappingLink(el);
  if (fromLink) return fromLink;

  for (const attr of FULL_IMAGE_DATA_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return value;
  }

  for (const attr of LAZY_IMAGE_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return value;
  }

  const fromSrcset = largestUrlFromSrcset(el.getAttribute("data-srcset") || el.getAttribute("srcset"));
  if (fromSrcset) return fromSrcset;

  return el.getAttribute("src") || "";
}

/**
 * Selektory bezpośrednie dla bloku GPSR (General Product Safety Regulation, obowiązkowy od
 * 13.12.2024 w UE) — część sklepów oznacza go dedykowaną klasą/atrybutem/id.
 */
export const GPSR_SELECTORS = [
  ".gpsr-info",
  ".gpsr",
  "[class*='gpsr' i]",
  "[id*='gpsr' i]",
  "[data-gpsr]",
];

/**
 * Dopasowuje nagłówek/etykietę sekcji GPSR — hasło "GPSR" wprost, albo jego polskie opisowe
 * warianty ("informacje o bezpieczeństwie produktu", "producent odpowiedzialny"/"podmiot
 * odpowiedzialny w UE"), bo wiele sklepów nie nazywa sekcji literalnie "GPSR" w treści strony.
 * Wyeksportowana jako czysta funkcja regexowa, żeby dało się ją testować bez prawdziwego DOM-a —
 * reszta detekcji (przejście po nagłówkach strony) wymaga już żywego querySelectorAll.
 */
export const GPSR_HEADING_RE = /gpsr|producent odpowiedzialny|podmiot odpowiedzialny.{0,20}\bUE\b/i;
const SAFETY_STEM_RE = /bezpiecze[nń]stw\w*/i; // rdzeń — łapie bezpieczeństwo/-a/-u/-em/-ie (wszystkie przypadki)
const PRODUCT_WORD_RE = /produkt\w*/i;

export function looksLikeGpsrHeading(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (GPSR_HEADING_RE.test(value)) return true;
  return SAFETY_STEM_RE.test(value) && PRODUCT_WORD_RE.test(value);
}

const GPSR_HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6,summary,dt,legend,strong,b";
const GPSR_CONTAINER_SELECTOR = "details,section,article,div,dl";

/**
 * Wykrywa blok informacji GPSR na stronie produktu: najpierw selektory bezpośrednie
 * (GPSR_SELECTORS), a jeśli nic nie pasuje — szuka nagłówka/etykiety dopasowującej
 * GPSR_HEADING_RE i bierze tekst najbliższego sensownego kontenera (details/section/div itp.)
 * jako wartość. To fallback, bo sklepy renderują tę sekcję na bardzo różne sposoby (dedykowany
 * blok, zakładka, akordeon) — nie ma tu jednego standardu jak przy schema.org.
 * @param {Document|Element} root
 */
export function detectGpsrInfo(root) {
  const direct = firstMatch(root, GPSR_SELECTORS, textOf);
  if (direct) return { selector: direct.selector, value: direct.value };

  let headings;
  try {
    headings = root.querySelectorAll ? Array.from(root.querySelectorAll(GPSR_HEADING_SELECTOR)) : [];
  } catch {
    headings = [];
  }
  for (const heading of headings) {
    const headingText = textOf(heading);
    if (!looksLikeGpsrHeading(headingText)) continue;
    const container = (heading.closest && heading.closest(GPSR_CONTAINER_SELECTOR)) || heading.parentElement;
    if (!container) continue;
    const value = textOf(container);
    if (value && value.length > headingText.length) {
      return { selector: null, value };
    }
  }
  return null;
}

/**
 * Próbuje kolejnych selektorów dla danego pola, zwraca pierwszy niepusty wynik.
 * @param {Document|Element} root
 * @param {(el: Element) => string} readValue
 */
function firstMatch(root, selectors, readValue) {
  for (const selector of selectors) {
    try {
      const el = root.querySelector(selector);
      if (!el) continue;
      const value = readValue(el);
      if (value) return { selector, value, el };
    } catch {
      // nieprawidłowy selektor w danym silniku CSS — pomijamy
    }
  }
  return null;
}

function textOf(el) {
  return (el.textContent || "").trim();
}

/**
 * Waluta prawie nigdy nie ma własnego elementu DOM w sklepach bez JSON-LD/microdata — jest
 * po prostu częścią tekstu ceny ("199,99 zł", "$19.99"). Bez tego fallbacku pole `currency`
 * zawsze zostawało puste na takich stronach, mimo że informacja była tuż obok ceny.
 * @type {{re: RegExp, code: string}[]}
 */
const CURRENCY_PATTERNS = [
  { re: /zł/i, code: "PLN" },
  { re: /\bpln\b/i, code: "PLN" },
  { re: /€/, code: "EUR" },
  { re: /\beur\b/i, code: "EUR" },
  { re: /£/, code: "GBP" },
  { re: /\bgbp\b/i, code: "GBP" },
  { re: /\$/, code: "USD" },
  { re: /\busd\b/i, code: "USD" },
  { re: /kč/i, code: "CZK" },
  { re: /\bczk\b/i, code: "CZK" },
  { re: /\bft\b/i, code: "HUF" },
  { re: /\bhuf\b/i, code: "HUF" },
  { re: /\blei\b/i, code: "RON" },
  { re: /\bron\b/i, code: "RON" },
  { re: /\bkr\b/i, code: "SEK" },
  { re: /\bsek\b/i, code: "SEK" },
];

/** Zgaduje kod waluty ISO z dowolnego tekstu zawierającego symbol/skrót waluty, albo null. */
export function detectCurrencyFromText(text) {
  const value = String(text || "");
  for (const { re, code } of CURRENCY_PATTERNS) {
    if (re.test(value)) return code;
  }
  return null;
}

/** @param {Document|Element} root */
export function detectFromDom(root) {
  /** @type {Record<string, any>} */
  const fields = {};

  for (const [field, selectors] of Object.entries(CANDIDATE_SELECTORS)) {
    if (field === "category") {
      const match = firstMatch(root, selectors, (el) => {
        const links = el.querySelectorAll ? el.querySelectorAll("a") : [];
        return Array.from(links).map((a) => textOf(a)).filter(Boolean).join(" > ");
      });
      if (match) {
        fields.category = { source: "dom", selector: `${match.selector} a`, attr: "text", multiple: true, value: match.value };
      }
      continue;
    }
    const match = firstMatch(root, selectors, textOf);
    if (match) {
      fields[field] = { source: "dom", selector: match.selector, attr: "text", multiple: false, value: match.value };
    }
  }

  if (!fields.currency && fields.price?.value) {
    const currency = detectCurrencyFromText(fields.price.value);
    if (currency) {
      fields.currency = { source: "dom", selector: fields.price.selector, attr: "text", multiple: false, value: currency };
    }
  }

  const gallery = firstMatch(root, IMAGE_GALLERY_SELECTORS, pickImageUrl);
  if (gallery) {
    fields.images = { source: "dom", selector: gallery.selector, attr: "src", multiple: true, value: gallery.value, values: allImageUrls(root) };
  }

  const gpsr = detectGpsrInfo(root);
  if (gpsr) {
    fields.gpsr = { source: "dom", selector: gpsr.selector || "", attr: "text", multiple: false, value: gpsr.value };
  }

  return { found: Object.keys(fields).length > 0, fields };
}

/**
 * Zbiera WSZYSTKIE (nie tylko pierwszy) adresy zdjęć pasujące do znanych selektorów galerii —
 * używane przez przycisk "Zdjęcia" w prostym trybie (sidepanel/main.js), żeby pobrać cały
 * zestaw zdjęć produktu, nie tylko podgląd. Deduplikowane, bez twardego limitu tutaj (limit
 * bezpieczeństwa jest w main.js na poziomie całego skanu).
 * @param {Document|Element} root
 */
export function allImageUrls(root) {
  const seen = new Set();
  const out = [];
  for (const selector of IMAGE_GALLERY_SELECTORS) {
    let els;
    try {
      els = root.querySelectorAll ? root.querySelectorAll(selector) : [];
    } catch {
      continue;
    }
    for (const el of els) {
      const url = pickImageUrl(el);
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}
