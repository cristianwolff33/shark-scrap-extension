/**
 * @file Content script (klasyczny, nie-module) wstrzykiwany deklaratywnie na wszystkie strony.
 * Sam nic nie robi dopóki nie dostanie wiadomości z side panelu — wtedy dynamicznie importuje
 * czyste moduły z lib/ (wymaga web_accessible_resources w manifest.json) i wykonuje detekcję.
 * Trzymanie ciężkiej logiki w lib/*.js (a nie tutaj) jest tym, co pozwala ją testować w Node.
 *
 * SCAN_CATALOG (auto-skan całej witryny) jest tu, bo wymaga prawdziwego DOM-a (fetch + DOMParser
 * po stronach listingu/produktów) — orkiestracja jest więc z natury nietestowalna w Node, ale
 * cała jej "matematyka" (rozwiązywanie URL-i, dedup, limity, heurystyka trybu) żyje w
 * lib/crawler.js i JEST testowana (patrz test/crawler.test.js).
 */

async function loadLib(name) {
  const url = chrome.runtime.getURL(`lib/${name}`);
  return import(url);
}

function collectJsonLdStrings(doc = document) {
  return Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).map((el) => el.textContent || "");
}

function collectMetaPairs(doc = document) {
  return Array.from(doc.querySelectorAll("meta")).map((el) => [
    el.getAttribute("property") || el.getAttribute("name") || "",
    el.getAttribute("content") || "",
  ]);
}

function resolveMaybeUrl(value, baseUrl) {
  if (!value) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

function normalizeUrlFields(fields, pageUrl) {
  for (const [field, spec] of Object.entries(fields || {})) {
    if (!spec) continue;
    const attr = String(spec.attr || "").toLowerCase();
    const looksLikeUrl = field === "images" || field === "product_url" || attr === "src" || attr === "href";
    if (!looksLikeUrl) continue;
    if (Array.isArray(spec.values)) {
      spec.values = spec.values.map((value) => resolveMaybeUrl(value, pageUrl)).filter(Boolean);
      if (spec.values.length > 0) spec.value = spec.values[0];
    } else if (spec.value) {
      spec.value = resolveMaybeUrl(spec.value, pageUrl);
    }
  }
  return fields;
}

/** @param {Document} doc @param {string} pageUrl */
async function detectProductFromDoc(doc, pageUrl) {
  const [{ detectFromJsonLd }, { detectFromMicrodata }, { mapOgTags }, { detectFromDom }, { mergeFieldSources }] = await Promise.all([
    loadLib("jsonld.js"),
    loadLib("microdata.js"),
    loadLib("meta.js"),
    loadLib("dom-heuristics.js"),
    loadLib("fields.js"),
  ]);

  const jsonld = detectFromJsonLd(collectJsonLdStrings(doc));
  const microdata = detectFromMicrodata(doc);
  const meta = mapOgTags(collectMetaPairs(doc));
  const dom = detectFromDom(doc);

  const merged = mergeFieldSources({}, jsonld.fields, microdata.fields, meta, dom.fields);

  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
  if (!merged.product_url && canonical) {
    merged.product_url = { source: "canonical", attr: "href", multiple: false, value: canonical };
  } else if (!merged.product_url) {
    merged.product_url = { source: "canonical", attr: "href", multiple: false, value: pageUrl };
  }

  normalizeUrlFields(merged, pageUrl);

  return {
    url: pageUrl,
    domain: (() => { try { return new URL(pageUrl).hostname; } catch { return ""; } })(),
    detectedFrom: { jsonld: jsonld.found, microdata: microdata.found, meta: Object.keys(meta).length > 0, dom: dom.found },
    fields: merged,
  };
}

async function detectProduct() {
  return detectProductFromDoc(document, location.href);
}

async function extractFieldsByMapFromDoc(doc, pageUrl, fieldMap) {
  const { valueForAttr } = await loadLib("selectors.js");
  const fields = {};
  for (const [field, spec] of Object.entries(fieldMap || {})) {
    if (!spec?.selector) continue;
    if (!["css", "dom", "ai"].includes(spec.source)) continue;
    try {
      if (spec.multiple) {
        const values = Array.from(doc.querySelectorAll(spec.selector))
          .map((node) => valueForAttr(node, spec.attr))
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        if (values.length > 0) {
          fields[field] = { ...spec, value: values.join(", "), values };
        }
      } else {
        const node = doc.querySelector(spec.selector);
        const value = node ? String(valueForAttr(node, spec.attr) || "").trim() : "";
        if (value) fields[field] = { ...spec, value };
      }
    } catch {
      // Selektor mógł być poprawny na próbce, ale nie na innej wersji szablonu produktu.
    }
  }
  return normalizeUrlFields(fields, pageUrl);
}

/** Grupuje elementy strony wg sygnatury (tag + stabilna klasa, albo tag + atrybut testowy) i szuka powtarzalnych "kart produktu". */
async function detectListingFromDoc(doc, pageUrl = location.href) {
  const [
    { pickStableClass, pickTestId },
    { groupSignature, groupSignatureForAttr, pickBestGroup, pickBestProductLinkCandidate, PRICE_LIKE_RE },
  ] = await Promise.all([loadLib("selectors.js"), loadLib("listing.js")]);

  /** @type {Map<string, {selector:string, els:Element[]}>} */
  const groups = new Map();
  const candidates = doc.querySelectorAll("body *");
  for (const el of candidates) {
    if (!el.children || el.children.length === 0) continue; // liście drzewa raczej nie są kartami
    if (!el.querySelector("a")) continue; // karta produktu prawie zawsze ma link
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "svg", "path", "nav", "header", "footer"].includes(tag)) continue;
    const stableClass = pickStableClass(el);
    // Fallback na atrybut testowy (data-testid itp.), gdy element ma tylko klasy hashowane
    // przez css-in-js/CSS modules — bez tego takie strony (częste w nowoczesnych frontendach)
    // w ogóle nie trafiały do żadnej grupy.
    const testId = stableClass ? null : pickTestId(el);
    if (!stableClass && !testId) continue;
    const sig = stableClass ? groupSignature(tag, stableClass) : groupSignatureForAttr(tag, testId.attr, testId.value);
    // `sig` jest już poprawnym, escapowanym selektorem CSS (patrz groupSignature/groupSignatureForAttr)
    // — używamy go wprost, żeby nie duplikować (i przypadkiem rozjechać) budowanie selektora.
    if (!groups.has(sig)) groups.set(sig, { selector: sig, els: [] });
    groups.get(sig).els.push(el);
  }

  const descriptors = Array.from(groups.values())
    .filter((g) => g.els.length >= 3 && g.els.length <= 500)
    .map((g) => {
      const withLink = g.els.filter((el) => el.querySelector("a[href]")).length;
      const withImage = g.els.filter((el) => el.querySelector("img")).length;
      const withPriceLike = g.els.filter((el) => PRICE_LIKE_RE.test(el.textContent || "")).length;
      const avgTextLength = g.els.reduce((sum, el) => sum + (el.textContent || "").trim().length, 0) / g.els.length;
      return { selector: g.selector, count: g.els.length, withLink, withImage, withPriceLike, avgTextLength, _els: g.els };
    });

  const best = pickBestGroup(descriptors);
  if (!best) return { found: false, item_selector: "", url_selector: "", url_attribute: "href", detected_count: 0, sample_urls: [] };

  const group = descriptors.find((d) => d.selector === best.selector);
  const firstLink = group._els[0].querySelector("a[href]");
  const urlSelector = firstLink ? "a[href]" : "";
  const sampleUrls = group._els
    .slice(0, 5)
    .map((el) => {
      const link = pickProductLinkFromCard(el, urlSelector, "href", PRICE_LIKE_RE, pickBestProductLinkCandidate);
      return resolveMaybeUrl(link?.raw || link?.href, pageUrl);
    })
    .filter(Boolean);

  return {
    found: true,
    item_selector: best.selector,
    url_selector: urlSelector,
    url_attribute: "href",
    detected_count: best.count,
    sample_urls: sampleUrls,
  };
}

async function detectListing() {
  return detectListingFromDoc(document);
}

function isDisabledCandidateEl(el) {
  if (el.disabled === true) return true;
  if ((el.getAttribute("aria-disabled") || "").toLowerCase() === "true") return true;
  return !!(el.closest && el.closest("[disabled], [aria-disabled='true'], .disabled"));
}

async function detectPaginationFromDoc(doc) {
  const { pickNextLinkCandidate, pickLoadMoreCandidate, isNavigableHref } = await loadLib("listing.js");
  const { generateSelector } = await loadLib("selectors.js");

  const links = Array.from(doc.querySelectorAll("a")).map((a) => ({
    el: a,
    selector: "",
    text: (a.textContent || "").trim(),
    rel: a.getAttribute("rel") || "",
    ariaLabel: a.getAttribute("aria-label") || "",
    hasHref: !!a.getAttribute("href"),
  }));
  // Sporo CMS-ów (WordPress i inne) emituje SEO-owy <link rel="next" href="..."> w <head>,
  // niezależnie od tego, czy w <body> w ogóle jest widoczny link "następna strona" — to bardzo
  // rzetelny sygnał, kompletnie pomijany wcześniej, bo skanowaliśmy tylko <a> w treści strony.
  const headNext = doc.querySelector('head link[rel~="next"]');
  if (headNext && headNext.getAttribute("href")) {
    links.unshift({ el: headNext, selector: "", text: "", rel: "next", ariaLabel: "", hasHref: true });
  }
  const buttons = Array.from(doc.querySelectorAll("button, a")).map((el) => ({
    el,
    text: (el.textContent || "").trim(),
    ariaLabel: el.getAttribute("aria-label") || "",
    disabled: isDisabledCandidateEl(el),
  }));

  const next = pickNextLinkCandidate(links);
  const loadMore = pickLoadMoreCandidate(buttons);

  // Kandydat "next" istnieje, ale jego href to placeholder ("#"/"javascript:...") — typowe dla
  // paginacji sterowanej czystym JS/AJAX bez przeładowania strony (częste w React/Vue). Taki
  // link jest bezużyteczny dla fetch()+DOMParser (kolejna strona wygląda identycznie jak
  // pierwsza), ale da się go realnie kliknąć na żywej stronie — stąd osobny tryb "click_next"
  // zamiast mylącego "next_link", który sugerowałby bezpieczne podążanie przez URL.
  if (next && isNavigableHref(next.el.getAttribute("href"))) {
    return { mode: "next_link", next_selector: generateSelector(next.el), load_more_selector: "", experimental: false };
  }
  if (loadMore) {
    return { mode: "load_more", next_selector: "", load_more_selector: generateSelector(loadMore.el), experimental: true };
  }
  if (next) {
    return { mode: "click_next", next_selector: generateSelector(next.el), load_more_selector: "", experimental: true };
  }
  return { mode: "none", next_selector: "", load_more_selector: "", experimental: false };
}

async function detectPagination() {
  return detectPaginationFromDoc(document);
}

// --- pełny auto-skan katalogu (SCAN_CATALOG) --------------------------------------

let scanStopRequested = false;

function pickProductLinkFromCard(card, urlSelector, urlAttribute, priceLikeRe, pickBestProductLinkCandidate) {
  const selected = urlSelector ? Array.from(card.querySelectorAll(urlSelector)) : [];
  const anchors = [];
  for (const node of selected.length ? selected : [card]) {
    if (node.matches?.("a[href]")) anchors.push(node);
    if (node.querySelectorAll) anchors.push(...Array.from(node.querySelectorAll("a[href]")));
  }
  if (!anchors.length && card.querySelectorAll) anchors.push(...Array.from(card.querySelectorAll("a[href]")));
  const unique = Array.from(new Set(anchors));
  const hasPriceNearby = priceLikeRe.test(card.textContent || "");
  const candidates = unique.map((el) => {
    const attr = urlAttribute || "href";
    const raw = attr === "text" ? el.textContent : el.getAttribute(attr);
    return {
      el,
      raw,
      href: el.getAttribute("href") || raw || "",
      text: (el.textContent || "").trim(),
      hasImage: !!el.querySelector("img"),
      hasPriceNearby,
    };
  });
  return pickBestProductLinkCandidate(candidates);
}

function extractItemUrlsFromDoc(doc, itemSelector, urlSelector, urlAttribute, baseUrl, resolveUrl, priceLikeRe, pickBestProductLinkCandidate) {
  if (!itemSelector) return [];
  let cards;
  try {
    cards = Array.from(doc.querySelectorAll(itemSelector));
  } catch {
    // Selektor mógł zostać zapisany ręcznie/wcześniej i być niepoprawny na tej wersji strony —
    // nie wywalamy całego skanu, tylko spadamy na fallback (extractLikelyProductUrlsFromDoc).
    return [];
  }
  const urls = [];
  for (const card of cards) {
    const link = pickProductLinkFromCard(card, urlSelector, urlAttribute, priceLikeRe, pickBestProductLinkCandidate);
    const abs = resolveUrl(link?.raw || link?.href, baseUrl);
    if (abs) urls.push(abs);
  }
  return urls;
}

function extractLikelyProductUrlsFromDoc(doc, baseUrl, resolveUrl, priceLikeRe, scoreProductLinkCandidate) {
  const anchors = Array.from(doc.querySelectorAll("a[href]"));
  const candidates = anchors.map((el) => {
    let node = el.parentElement;
    let hasPriceNearby = priceLikeRe.test(el.textContent || "");
    for (let depth = 0; node && depth < 4 && !hasPriceNearby; depth += 1) {
      hasPriceNearby = priceLikeRe.test(node.textContent || "");
      node = node.parentElement;
    }
    return {
      el,
      raw: el.getAttribute("href"),
      href: el.getAttribute("href") || "",
      text: (el.textContent || "").trim(),
      hasImage: !!el.querySelector("img"),
      hasPriceNearby,
    };
  });
  return candidates
    .filter((candidate) => scoreProductLinkCandidate(candidate) >= 45)
    .map((candidate) => resolveUrl(candidate.raw, baseUrl))
    .filter(Boolean);
}

function isSameListingAreaUrl(url, baseUrl) {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    if (target.origin !== base.origin) return false;
    if (target.pathname === base.pathname) return true;
    const basePath = base.pathname.replace(/\/+$/, "");
    const targetPath = target.pathname.replace(/\/+$/, "");
    if (basePath && targetPath.startsWith(`${basePath}/`)) return true;
    const [baseFirst] = base.pathname.split("/").filter(Boolean);
    const [targetFirst] = target.pathname.split("/").filter(Boolean);
    return !!baseFirst && baseFirst === targetFirst;
  } catch {
    return false;
  }
}

function isSameOriginUrl(url, baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function extractPaginationUrlsFromDoc(doc, pagination, currentUrl, baseUrl, resolveUrl, normalizeCrawlUrl, isLikelyPaginationLinkCandidate) {
  const urls = [];
  const add = (raw) => {
    const abs = normalizeCrawlUrl(resolveUrl(raw, currentUrl));
    if (!abs || abs === normalizeCrawlUrl(currentUrl) || !isSameListingAreaUrl(abs, baseUrl)) return;
    urls.push(abs);
  };

  if (pagination?.mode === "next_link" && pagination.next_selector) {
    try {
      const next = doc.querySelector(pagination.next_selector);
      if (next) add(next.getAttribute("href"));
    } catch {
      // Strona kolejna może mieć inny DOM niż pierwsza; wtedy szukamy linków paginacji niżej.
    }
  }

  // Niezależnie od trybu wykrytego na pierwszej stronie: <link rel="next"> w <head> sprawdzamy
  // zawsze, na każdej stronie z osobna — to niezawodny sygnał SEO, którego brak na jednej
  // stronie (albo inny next_selector) nie powinien przerywać podążania za paginacją.
  const headNext = doc.querySelector('head link[rel~="next"]');
  if (headNext) add(headNext.getAttribute("href"));

  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    if (a.closest?.("[disabled], [aria-disabled='true'], .disabled")) continue;
    const candidate = {
      href: a.getAttribute("href") || "",
      text: (a.textContent || "").trim(),
      ariaLabel: a.getAttribute("aria-label") || "",
      rel: a.getAttribute("rel") || "",
      hasHref: true,
    };
    if (isLikelyPaginationLinkCandidate(candidate)) add(candidate.href);
  }
  return Array.from(new Set(urls));
}

async function fetchDoc(url, { retries = 1, timeoutMs = 15_000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
      const html = await res.text();
      return new DOMParser().parseFromString(html, "text/html");
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastError || new Error(`Nie udało się pobrać ${url}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendProgress(payload) {
  try {
    chrome.runtime.sendMessage({ action: "SCAN_PROGRESS", ...payload });
  } catch {
    // panel mógł zostać zamknięty w trakcie skanu — ignorujemy, scan i tak działa do końca/Stop
  }
}

function sendProduct(product) {
  try {
    chrome.runtime.sendMessage({ action: "SCAN_PRODUCT", product });
  } catch {
    /* jw. */
  }
}

const HARD_PRODUCT_CAP = 2000;
const REQUEST_DELAY_MS = 350; // uprzejmość wobec serwera sklepu — ten sam rząd wielkości co request_delay_seconds frameworka
const LOAD_MORE_MAX_CLICKS = 60;
const LOAD_MORE_STABLE_ROUNDS_LIMIT = 2; // ile kliknięć z rzędu bez przyrostu kart = koniec listy
const LOAD_MORE_WAIT_TIMEOUT_MS = 6000; // ile czekamy po kliknięciu, aż strona doładuje nowe karty (AJAX)
const LOAD_MORE_POLL_INTERVAL_MS = 250;

/** Liczy dopasowania selektora na ŻYWEJ stronie, bezpiecznie (selektor mógł być wygenerowany z klasy, która okazała się niepoprawna w praktyce). */
function safeCount(selector) {
  if (!selector) return 0;
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/** Czeka aż liczba dopasowań selektora wzrośnie ponad `previousCount` (strona doładowała AJAX-em) albo upłynie timeout. */
function waitForCountIncrease(selector, previousCount, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (safeCount(selector) > previousCount || scanStopRequested) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, LOAD_MORE_POLL_INTERVAL_MS);
    };
    check();
  });
}

/** Czeka aż `extractUrls()` zwróci inny zestaw URL-i niż `previousKey` (strona podmieniła treść
 * po kliknięciu "następna strona") albo upłynie timeout. */
function waitForUrlSetChange(extractUrls, previousKey, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const currentKey = extractUrls().join("|");
      if ((currentKey && currentKey !== previousKey) || scanStopRequested) {
        resolve(currentKey);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, LOAD_MORE_POLL_INTERVAL_MS);
    };
    check();
  });
}

/**
 * Odpowiednik autoExpandLoadMore, ale dla paginacji "click_next" — przycisk "następna strona"
 * sterowany JS-em/AJAX-em (href to placeholder, patrz isNavigableHref w listing.js), gdzie
 * kliknięcie PODMIENIA karty produktów zamiast je dokładać (więc licznik kart nie rośnie —
 * porównujemy sam ZESTAW zebranych URL-i, nie jego rozmiar). Działa tylko na żywej stronie,
 * z tych samych powodów co autoExpandLoadMore.
 */
async function autoClickThroughPages(pagination, listing, baseUrl, resolveUrl, priceLikeRe, pickBestProductLinkCandidate, productCap, maxPages) {
  if (!pagination || pagination.mode !== "click_next" || !pagination.next_selector) {
    return { clicks: 0, collectedUrls: [] };
  }
  const extractCurrent = () =>
    extractItemUrlsFromDoc(document, listing.item_selector, listing.url_selector, listing.url_attribute, baseUrl, resolveUrl, priceLikeRe, pickBestProductLinkCandidate);

  let allUrls = extractCurrent();
  let previousKey = allUrls.join("|");
  let clicks = 0;

  while (clicks < Math.max(maxPages - 1, 0) && allUrls.length < productCap && !scanStopRequested) {
    let btn;
    try {
      btn = document.querySelector(pagination.next_selector);
    } catch {
      break;
    }
    if (!btn || isDisabledCandidateEl(btn) || btn.offsetParent === null) break; // brak/disabled/niewidoczny = ostatnia strona

    btn.scrollIntoView({ block: "center", behavior: "instant" });
    btn.click();
    clicks += 1;
    sendProgress({ phase: "listing", pagesVisited: clicks + 1, pagesTotal: maxPages, productsFound: allUrls.length });

    const newKey = await waitForUrlSetChange(extractCurrent, previousKey, LOAD_MORE_WAIT_TIMEOUT_MS);
    if (newKey === null) break; // brak zmiany po kliknięciu w rozsądnym czasie = koniec paginacji

    previousKey = newKey;
    allUrls = Array.from(new Set([...allUrls, ...extractCurrent()]));
    await sleep(REQUEST_DELAY_MS);
  }
  return { clicks, collectedUrls: allUrls };
}

/**
 * Realnie klika przycisk "Załaduj więcej" na ŻYWEJ stronie (tej samej karcie, w której user
 * uruchomił skan) i czeka, aż DOM doładuje kolejne karty — tak jak zrobiłby to człowiek. To
 * jedyny sposób, żeby obsłużyć load-more bez Playwrighta: fetch()+DOMParser (używany do
 * kolejnych stron next_link) nie wykonuje JS-a strony, więc nigdy by nie zobaczył efektu
 * kliknięcia. Działa TYLKO na bieżącej, żywej stronie (nie na fetchowanych kopiach) i tylko
 * dla trybu "load_more" z rozpoznanym przyciskiem — infinite_scroll (doładowanie na scrollu,
 * bez jawnego przycisku) zostaje nieobsłużone, bo nie ma tu jednego niezawodnego triggera.
 * Zatrzymuje się, gdy: przycisk zniknie/będzie disabled/niewidoczny, osiągniemy limit
 * produktów, dwa kliknięcia z rzędu nie dadzą przyrostu kart, albo user kliknie "Stop".
 */
async function autoExpandLoadMore(pagination, itemSelector, productCap) {
  if (!pagination || pagination.mode !== "load_more" || !pagination.load_more_selector) {
    return { clicks: 0 };
  }
  let clicks = 0;
  let stableRounds = 0;
  let lastCount = safeCount(itemSelector);

  while (clicks < LOAD_MORE_MAX_CLICKS && stableRounds < LOAD_MORE_STABLE_ROUNDS_LIMIT && !scanStopRequested) {
    if (Number.isFinite(productCap) && productCap > 0 && lastCount >= productCap) break;
    let btn;
    try {
      btn = document.querySelector(pagination.load_more_selector);
    } catch {
      break;
    }
    if (!btn || isDisabledCandidateEl(btn) || btn.offsetParent === null) break; // brak przycisku / wyłączony / niewidoczny = koniec listy

    btn.scrollIntoView({ block: "center", behavior: "instant" });
    btn.click();
    clicks += 1;
    sendProgress({ phase: "listing", pagesVisited: 1, pagesTotal: 1, productsFound: lastCount });

    await waitForCountIncrease(itemSelector, lastCount, LOAD_MORE_WAIT_TIMEOUT_MS);
    const newCount = safeCount(itemSelector);
    stableRounds = newCount > lastCount ? 0 : stableRounds + 1;
    lastCount = newCount;
    await sleep(REQUEST_DELAY_MS); // uprzejmość wobec serwera, tak jak przy fetchowaniu kolejnych stron
  }
  return { clicks, finalCount: lastCount };
}

/**
 * Pełny auto-skan: wykrywa listing+paginację+pola produktowe na bieżącej stronie (bez pytania
 * usera o nic) i sam przechodzi przez wszystkie strony listingu oraz wszystkie karty produktów,
 * zbierając dane wg tego samego priorytetu źródeł co pojedyncza detekcja (jsonld > microdata >
 * meta > dom). Zwraca zebrane produkty + wykryty listing/pola/pagination, żeby panel mógł
 * wypełnić resztę formularza (do ręcznej korekty, jeśli coś zawiodło).
 */
async function suggestMissingFieldsWithAi({ apiKey, aiModel, aiProvider, cloudAi }, bestSamplePair, missing) {
  const html = bestSamplePair.doc.documentElement.outerHTML;
  if (aiProvider === "cloud") {
    const { createBridgeClient } = await loadLib("bridge-client.js");
    const client = createBridgeClient(cloudAi?.baseUrl || "http://127.0.0.1:8766", fetch, {
      headers: cloudAi?.headers || {},
      serviceName: "cloud AI",
    });
    return client.suggestFields({ html, url: bestSamplePair.url, fields: missing, model: aiModel });
  }
  // "openai" (Codex) albo "anthropic" (Claude) — oba klienty mają identyczne publiczne API
  // (suggestFields), różni się tylko moduł, więc reszta orkiestracji (poniżej, weryfikacja
  // selektora na żywym DOM próbki) jest wspólna dla obu providerów.
  const clientModule = aiProvider === "anthropic" ? "anthropic-client.js" : "openai-client.js";
  const { suggestFields } = await loadLib(clientModule);
  return suggestFields({ apiKey, model: aiModel, html, url: bestSamplePair.url, fields: missing });
}

async function scanCatalog({ maxPages, maxProducts, useAI, apiKey, aiModel, aiProvider, cloudAi } = {}) {
  scanStopRequested = false;
  const { resolveUrl, normalizeCrawlUrl, dedupe, capArray, guessAdapterMode, isAutoFollowablePagination, pickBestSample } = await loadLib("crawler.js");
  const { PRICE_LIKE_RE, pickBestProductLinkCandidate, scoreProductLinkCandidate, isLikelyPaginationLinkCandidate } = await loadLib("listing.js");

  const baseUrl = location.href;
  const listing = await detectListing();
  const pagination = await detectPagination();

  if (!listing.found) {
    // Brak wykrytej listy na bieżącej stronie — traktujemy ją jako pojedynczy produkt (fallback),
    // żeby przycisk "Skanuj sklep" zawsze coś sensownego zrobił, nawet z karty produktu.
    const product = await detectProduct();
    sendProduct({ url: product.url, fields: product.fields, ok: true });
    return {
      mode: "single_product",
      listing,
      pagination,
      fieldMap: product.fields,
      products: [{ url: product.url, fields: product.fields, ok: true }],
      pagesVisited: 1,
      warnings: ["Nie wykryto listy produktów na bieżącej stronie — zeskanowano ją jako pojedynczy produkt. Wejdź na stronę kategorii, żeby zeskanować cały katalog."],
    };
  }

  const warnings = [];
  const effectiveMaxPages = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : (pagination.max_pages || 20);
  const productCap = Math.min(Number.isFinite(maxProducts) && maxProducts > 0 ? maxProducts : HARD_PRODUCT_CAP, HARD_PRODUCT_CAP);

  let preCollectedProductUrls = [];
  let clickThroughPages = 0;

  if (pagination.mode === "load_more") {
    sendProgress({ phase: "listing", pagesVisited: 1, pagesTotal: 1, productsFound: safeCount(listing.item_selector) });
    const expandResult = await autoExpandLoadMore(pagination, listing.item_selector, productCap);
    if (expandResult.clicks > 0) {
      warnings.push(`Kliknięto "Załaduj więcej" ${expandResult.clicks}× na żywej stronie — doładowano do ${expandResult.finalCount} kart produktowych.`);
    } else {
      warnings.push(`Wykryto przycisk "Załaduj więcej", ale nie udało się go automatycznie kliknąć/doładować kolejnych produktów — sprawdź selektor ręcznie.`);
    }
  } else if (pagination.mode === "click_next") {
    // Przycisk "następna strona" bez prawdziwego href (sterowany JS-em/AJAX) — jedyny sposób to
    // kliknąć na żywej stronie i zbierać URL-e produktów po kolei, strona po stronie (patrz
    // autoClickThroughPages: w odróżnieniu od load-more, tu treść jest PODMIENIANA, nie dokładana).
    sendProgress({ phase: "listing", pagesVisited: 1, pagesTotal: effectiveMaxPages, productsFound: safeCount(listing.item_selector) });
    const clickResult = await autoClickThroughPages(
      pagination,
      listing,
      baseUrl,
      resolveUrl,
      PRICE_LIKE_RE,
      pickBestProductLinkCandidate,
      productCap,
      effectiveMaxPages
    );
    preCollectedProductUrls = clickResult.collectedUrls;
    clickThroughPages = clickResult.clicks;
    if (clickResult.clicks > 0) {
      warnings.push(`Kliknięto "następna strona" ${clickResult.clicks}× na żywej stronie (paginacja bez zwykłych linków, sterowana JS-em) — zebrano ${preCollectedProductUrls.length} URL-i produktów z ${clickResult.clicks + 1} stron.`);
    } else {
      warnings.push(`Wykryto przycisk "następna strona" bez normalnego linku (paginacja JS/AJAX), ale nie udało się przejść dalej automatycznie — sprawdź selektor ręcznie.`);
    }
  } else if (pagination.mode !== "none" && !isAutoFollowablePagination(pagination)) {
    warnings.push(`Wykryto paginację typu "${pagination.mode}" (experimental) — spróbuję jeszcze linki z href/numery stron, ale przyciski wymagające JS mogą wymagać trybu Playwright.`);
  }

  // 1. Zbieramy URL-e produktów ze stron listingu. Kolejka obsługuje next link oraz paginację
  // numeryczną (?page=2, /page/2, /strona/2) wykrytą na każdej kolejnej stronie. Dla click_next
  // startujemy z URL-ami zebranymi już przez kliknięcie na żywo (preCollectedProductUrls) —
  // poniższa pętla i tak jeszcze raz przetworzy bieżącą (już przeklikaną) stronę, ale dedupe
  // sprawia, że to nieszkodliwe powtórzenie, nie utrata danych.
  const baseKey = normalizeCrawlUrl(baseUrl);
  const pendingPageUrls = [baseKey || baseUrl];
  const visitedPageUrls = new Set();
  let pagesVisited = 0;
  let productUrls = dedupe(preCollectedProductUrls.map(normalizeCrawlUrl).filter((url) => url && isSameOriginUrl(url, baseUrl)));
  let queuedBeyondLimit = false;

  while (pendingPageUrls.length > 0 && pagesVisited < effectiveMaxPages && !scanStopRequested) {
    const currentUrl = pendingPageUrls.shift();
    const currentKey = normalizeCrawlUrl(currentUrl);
    if (!currentKey || visitedPageUrls.has(currentKey)) continue;
    visitedPageUrls.add(currentKey);

    let currentDoc = currentKey === baseKey ? document : null;
    if (!currentDoc) {
      await sleep(REQUEST_DELAY_MS);
      try {
        currentDoc = await fetchDoc(currentUrl);
      } catch (err) {
        warnings.push(`Nie udało się pobrać strony listingu ${currentUrl}: ${err.message || err}`);
        continue;
      }
    }

    pagesVisited += 1;
    const urlsOnPage = extractItemUrlsFromDoc(
      currentDoc,
      listing.item_selector,
      listing.url_selector,
      listing.url_attribute,
      currentUrl,
      resolveUrl,
      PRICE_LIKE_RE,
      pickBestProductLinkCandidate
    );
    // Fallback (skan WSZYSTKICH linków na stronie wg score'u) używamy TYLKO, gdy strukturalna
    // detekcja kart (item_selector) nic nie znalazła na tej stronie. Wcześniej dokładaliśmy go
    // zawsze, przez co nawet przy poprawnie wykrytych kartach produktów do wyniku wpadały linki
    // do kategorii/menu/filtrów, które przypadkiem miały zdjęcie i sensowną długość tekstu —
    // wtyczka ma łapać wyłącznie produkty, nie "wszystko co wygląda trochę jak produkt".
    const fallbackUrlsOnPage =
      urlsOnPage.length > 0
        ? []
        : extractLikelyProductUrlsFromDoc(currentDoc, currentUrl, resolveUrl, PRICE_LIKE_RE, scoreProductLinkCandidate);
    productUrls = dedupe(
      [...productUrls, ...urlsOnPage, ...fallbackUrlsOnPage]
        .map(normalizeCrawlUrl)
        .filter((url) => url && isSameOriginUrl(url, baseUrl))
    );

    const nextPageUrls = extractPaginationUrlsFromDoc(
      currentDoc,
      pagination,
      currentUrl,
      baseUrl,
      resolveUrl,
      normalizeCrawlUrl,
      isLikelyPaginationLinkCandidate
    );
    for (const url of nextPageUrls) {
      if (visitedPageUrls.has(url) || pendingPageUrls.includes(url)) continue;
      if (visitedPageUrls.size + pendingPageUrls.length >= effectiveMaxPages) {
        queuedBeyondLimit = true;
        continue;
      }
      pendingPageUrls.push(url);
    }

    sendProgress({ phase: "listing", pagesVisited, pagesTotal: effectiveMaxPages, productsFound: productUrls.length });

    if (productUrls.length >= productCap) break;
  }

  productUrls = capArray(dedupe(productUrls), productCap);
  pagesVisited += clickThroughPages; // strony "odklikane" w click_next liczą się jako realnie odwiedzone
  if (queuedBeyondLimit || pendingPageUrls.length > 0) {
    warnings.push(`Skan zatrzymał się na limicie ${effectiveMaxPages} stron. Zwiększ "Max pages", jeśli kategoria ma więcej stron.`);
  }
  if (productUrls.length >= productCap) {
    warnings.push(`Skan zatrzymał się na limicie ${productCap} produktów. Zwiększ limit po stronie skanera/backendu, jeśli chcesz pełny katalog.`);
  }
  if (productUrls.length === 0) {
    warnings.push("Nie znaleziono URL-i produktów na listingu — selector kart lub linków prawdopodobnie wymaga ręcznej korekty.");
  }

  // 2. Pola produktowe: detekcja na próbce (do 3 kart) — wygrywa najlepsza (najwięcej niepustych pól),
  //    potem to samo źródło pól stosujemy do KAŻDEGO produktu (jsonld/microdata path'y są strukturalne,
  //    css/dom selektory generalizują się na kartach z tego samego szablonu).
  const sampleUrls = capArray(productUrls, 3);
  const samples = []; // {fields, doc, url}[] — trzymamy doc, żeby ewentualny fallback AI (niżej) mógł zweryfikować selektor na tej samej stronie
  for (const url of sampleUrls) {
    try {
      const doc = url === baseUrl ? document : await fetchDoc(url);
      const detected = await detectProductFromDoc(doc, url);
      samples.push({ fields: detected.fields, doc, url });
    } catch {
      // próbka się nie powiodła — próbujemy kolejnej
    }
    await sleep(REQUEST_DELAY_MS);
  }
  const bestSample = pickBestSample(samples.map((s) => s.fields));
  const bestSamplePair = samples.find((s) => s.fields === bestSample);
  const fieldMap = bestSample || {};
  const guessedMode = guessAdapterMode(fieldMap);
  if (Object.keys(fieldMap).length === 0) {
    warnings.push("Nie udało się automatycznie wykryć żadnych pól produktowych z próbki — uzupełnij ręcznie (Wskaż element).");
  }

  // 2b. Fallback AI (opt-in, patrz sidepanel — checkbox "Użyj AI"): TYLKO dla pól, których nic
  // powyższego nie znalazło, TYLKO raz na skan (kontrola kosztu), a zwrócony selektor jest
  // ZAWSZE zweryfikowany na żywym DOM próbki przed przyjęciem — nigdy nie ufamy modelowi ślepo.
  // W trybie cloud woła backendowe AI API (klucze modelu zostają na serwerze). W trybie local
  // zostaje direct OpenAI dev flow z chrome.storage.local.
  if (useAI && bestSamplePair && (aiProvider === "cloud" || apiKey)) {
    const { PRODUCT_FIELDS } = await loadLib("schema.js");
    const { valueForAttr } = await loadLib("selectors.js");
    const missing = PRODUCT_FIELDS.filter((f) => !fieldMap[f]);
    if (missing.length > 0) {
      try {
        const res = await suggestMissingFieldsWithAi({ apiKey, aiModel, aiProvider, cloudAi }, bestSamplePair, missing);
        let accepted = 0;
        for (const s of res.suggestions || []) {
          if (!s.found || !s.selector) continue;
          let elVal = null;
          try {
            const el = bestSamplePair.doc.querySelector(s.selector);
            elVal = el ? valueForAttr(el, s.attr) : null;
          } catch {
            elVal = null; // selektor niepoprawny (np. model zwrócił coś, czego querySelector nie przyjmie) — NIGDY nie ufamy ślepo
          }
          if (elVal !== null && elVal !== undefined && elVal !== "") {
            fieldMap[s.field] = { source: "ai", selector: s.selector, attr: s.attr, multiple: !!s.multiple, value: elVal };
            accepted += 1;
          } else {
            warnings.push(`AI zaproponowało selektor dla „${s.field}”, ale nie da się go zweryfikować na stronie — pominięto.`);
          }
        }
        if (accepted > 0) warnings.push(`AI (${res.model}) uzupełniło ${accepted} pole/pól — oznaczone badge'em "ai", zweryfikowane na żywym DOM. Sprawdź mimo to ręcznie.`);
      } catch (err) {
        warnings.push(`Fallback AI nie powiódł się (${err.message || err}) — kontynuuję bez niego.`);
      }
    }
  }

  // 3. Właściwe zbieranie danych z każdego produktu wg wykrytego field mapu.
  const products = [];
  const failedProductErrors = [];
  let done = 0;
  for (const url of productUrls) {
    if (scanStopRequested) break;
    try {
      const doc = url === baseUrl ? document : await fetchDoc(url);
      const detected = await detectProductFromDoc(doc, url);
      // Field mapa z próbki generalizuje selektory, ale wartości muszą pochodzić z aktualnego
      // produktu. Świeża detekcja strony nadal wygrywa, bo zwykle ma JSON-LD/meta dla tej karty.
      const mappedFields = await extractFieldsByMapFromDoc(doc, url, fieldMap);
      const merged = { ...mappedFields, ...detected.fields };
      const record = { url, fields: merged, ok: true };
      products.push(record);
      sendProduct(record);
    } catch (err) {
      const record = { url, fields: {}, ok: false, error: String(err.message || err) };
      products.push(record);
      failedProductErrors.push(record.error);
      sendProduct(record);
    }
    done += 1;
    sendProgress({ phase: "products", pagesVisited, pagesTotal: effectiveMaxPages, productsFound: done, productsTotal: productUrls.length });
    await sleep(REQUEST_DELAY_MS);
  }
  if (failedProductErrors.length > 0) {
    const firstError = failedProductErrors[0];
    warnings.push(`Nie udało się pobrać ${failedProductErrors.length}/${productUrls.length} produktów. Pierwszy błąd: ${firstError}`);
  }

  return {
    mode: "catalog",
    listing,
    pagination,
    fieldMap,
    guessedMode,
    products,
    pagesVisited,
    warnings,
    stopped: scanStopRequested,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "PING_CONTENT_SCRIPT") {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.action === "DETECT_PRODUCT") {
    detectProduct().then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (message?.action === "DETECT_LISTING") {
    detectListing().then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (message?.action === "DETECT_PAGINATION") {
    detectPagination().then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (message?.action === "SCAN_CATALOG") {
    scanCatalog(message.options || {}).then(sendResponse).catch((err) => sendResponse({ error: String(err.message || err) }));
    return true;
  }
  if (message?.action === "STOP_SCAN") {
    scanStopRequested = true;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
