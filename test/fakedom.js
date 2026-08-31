/**
 * @file Minimalny fake-DOM (bez zależności npm typu jsdom) — implementuje tylko podzbiór
 * interfejsu Element używany przez lib/selectors.js, wystarczający do testów jednostkowych
 * generowania selektorów bez uruchamiania prawdziwej przeglądarki.
 */

export class FakeElement {
  constructor(tag, { id = "", className = "", attrs = {}, text = "" } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = className;
    this._attrs = { ...attrs };
    this._text = text;
    this.children = [];
    this.parentElement = null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx > 0 ? this.parentElement.children[idx - 1] : null;
  }

  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = v;
  }

  get innerHTML() {
    return this._text;
  }

  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }

  setAttribute(name, value) {
    this._attrs[name] = value;
  }
}

/** Buduje drzewo z zagnieżdżonego opisu {tag, id?, className?, attrs?, text?, children?}. */
export function buildTree(spec) {
  const node = new FakeElement(spec.tag, spec);
  for (const childSpec of spec.children || []) {
    node.appendChild(buildTree(childSpec));
  }
  return node;
}
