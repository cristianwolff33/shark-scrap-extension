/**
 * @file Content script trybu "Select element": po starcie podświetla element pod kursorem,
 * po kliknięciu oblicza selektor CSS i podgląd wartości, wysyła wynik do side panelu i kończy tryb.
 */

let active = false;
let overlay = null;
let currentTarget = null;
let currentField = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    background: "rgba(59, 130, 246, 0.25)",
    outline: "2px solid #3b82f6",
    transition: "all 60ms ease-out",
    display: "none",
  });
  document.documentElement.appendChild(overlay);
  return overlay;
}

function positionOverlay(el) {
  const rect = el.getBoundingClientRect();
  const box = ensureOverlay();
  Object.assign(box.style, {
    display: "block",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function guessAttr(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "img") return "src";
  if (tag === "a" || tag === "link") return "href";
  if (tag === "meta") return "content";
  if (tag === "time") return "datetime";
  return "text";
}

function onMouseMove(e) {
  if (!active) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (el && el !== overlay) {
    currentTarget = el;
    positionOverlay(el);
  }
}

async function onClick(e) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const el = currentTarget || document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return;

  const { generateSelector, valueForAttr } = await import(chrome.runtime.getURL("lib/selectors.js"));
  const attr = guessAttr(el);
  const selector = generateSelector(el);
  const value = valueForAttr(el, attr);

  stopPicker();
  chrome.runtime.sendMessage({
    action: "PICKER_RESULT",
    field: currentField,
    selector,
    attr,
    value,
    tag: el.tagName.toLowerCase(),
  });
}

function onKeyDown(e) {
  if (e.key === "Escape") {
    stopPicker();
    chrome.runtime.sendMessage({ action: "PICKER_CANCELLED", field: currentField });
  }
}

function startPicker(field) {
  active = true;
  currentField = field;
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.body.style.cursor = "crosshair";
}

function stopPicker() {
  active = false;
  currentTarget = null;
  document.removeEventListener("mousemove", onMouseMove, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("keydown", onKeyDown, true);
  document.body.style.cursor = "";
  if (overlay) overlay.style.display = "none";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "START_PICKER") {
    startPicker(message.field);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.action === "STOP_PICKER") {
    stopPicker();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
