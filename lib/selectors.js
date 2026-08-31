/**
 * @file Generowanie stabilnych selektorów CSS z klikniętego elementu (picker) oraz
 * odczyt wartości z elementu wg typu atrybutu. Działa na dowolnym obiekcie zgodnym
 * z minimalnym interfejsem Element (id, tagName, getAttribute, textContent, innerHTML,
 * parentElement, previousElementSibling) — spełnia go zarówno prawdziwy DOM jak i
 * fake-dom używany w testach (extension/test/fakedom.js).
 */

const GENERIC_ID_RE = /^\d+$/;
const HASH_ID_RE = /^[0-9a-f]{8,}$/i;
const HASHY_CLASS_RE = /^(css-|sc-|_|jsx-|emotion-)/i;
const HASH_SUFFIX_CLASS_RE = /-[0-9a-f]{5,}$/i;
const TESTID_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy", "data-automation-id"];

export function isStableId(id) {
  if (!id) return false;
  if (id.length > 60) return false;
  if (GENERIC_ID_RE.test(id)) return false;
  if (HASH_ID_RE.test(id)) return false;
  return true;
}

export function isStableClass(cls) {
  if (!cls) return false;
  if (cls.length < 2 || cls.length > 50) return false;
  if (HASHY_CLASS_RE.test(cls)) return false;
  if (HASH_SUFFIX_CLASS_RE.test(cls)) return false;
  if (/^[0-9]/.test(cls)) return false;
  return true;
}

/** Zwraca pierwszą "sensowną" klasę z className elementu albo null. */
export function pickStableClass(el) {
  const raw = (el.className || "").toString().trim();
  if (!raw) return null;
  for (const cls of raw.split(/\s+/)) {
    if (isStableClass(cls)) return cls;
  }
  return null;
}

export function cssEscape(value) {
  return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function nthOfTypeIndex(el) {
  let index = 1;
  let sibling = el.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === el.tagName) index++;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

/**
 * Buduje selektor CSS identyfikujący element: id stabilne > data-testid > ścieżka
 * tag(.klasa|:nth-of-type) w górę drzewa, maks. `maxDepth` poziomów.
 */
export function generateSelector(el, { maxDepth = 6 } = {}) {
  if (!el || !el.tagName) return "";

  if (isStableId(el.id)) return `#${cssEscape(el.id)}`;

  for (const attr of TESTID_ATTRS) {
    const value = el.getAttribute && el.getAttribute(attr);
    if (value) return `${el.tagName.toLowerCase()}[${attr}="${cssEscape(value).replace(/\\"/g, '"')}"]`;
  }

  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.tagName && depth < maxDepth) {
    if (isStableId(node.id)) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const stableClass = pickStableClass(node);
    parts.unshift(stableClass ? `${tag}.${cssEscape(stableClass)}` : `${tag}:nth-of-type(${nthOfTypeIndex(node)})`);
    node = node.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

/**
 * Odczytuje wartość z elementu wg typu atrybutu ("text" | "html" | nazwa atrybutu HTML).
 * Zwraca string — normalizacja liczb/cen zostaje po stronie transformera frameworka.
 */
export function valueForAttr(el, attr) {
  if (!el) return "";
  if (attr === "text" || !attr) return (el.textContent || "").trim();
  if (attr === "html") return el.innerHTML || "";
  return el.getAttribute ? el.getAttribute(attr) || "" : "";
}
