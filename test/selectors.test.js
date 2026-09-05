import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeElement, buildTree } from "./fakedom.js";
import { isStableId, isStableClass, pickStableClass, pickTestId, generateSelector, valueForAttr } from "../lib/selectors.js";

test("isStableId odrzuca id numeryczne i hashowe", () => {
  assert.equal(isStableId("main-price"), true);
  assert.equal(isStableId("123456"), false);
  assert.equal(isStableId("a1b2c3d4e5f6"), false);
  assert.equal(isStableId(""), false);
});

test("isStableClass odrzuca klasy wyglądające na wygenerowane (css-in-js)", () => {
  assert.equal(isStableClass("product-price"), true);
  assert.equal(isStableClass("css-1a2b3c4"), false);
  assert.equal(isStableClass("sc-abcdef"), false);
  assert.equal(isStableClass("btn-4f5a9c"), false);
});

test("pickStableClass zwraca pierwszą sensowną klasę", () => {
  const el = new FakeElement("div", { className: "css-x1y2 product-card active" });
  assert.equal(pickStableClass(el), "product-card");
});

test("generateSelector preferuje stabilne #id", () => {
  const el = new FakeElement("span", { id: "product-title" });
  assert.equal(generateSelector(el), "#product-title");
});

test("generateSelector preferuje data-testid", () => {
  const el = new FakeElement("button", { attrs: { "data-testid": "add-to-cart" } });
  assert.equal(generateSelector(el), 'button[data-testid="add-to-cart"]');
});

test("generateSelector buduje ścieżkę tag.klasa w górę drzewa gdy brak id/testid", () => {
  const tree = buildTree({
    tag: "div",
    className: "product-page",
    children: [
      {
        tag: "div",
        className: "css-hash1 gallery",
        children: [{ tag: "img", className: "main-image" }],
      },
    ],
  });
  const img = tree.children[0].children[0];
  const selector = generateSelector(img);
  assert.equal(selector, "div.product-page > div.gallery > img.main-image");
});

test("generateSelector spada do nth-of-type gdy brak stabilnej klasy", () => {
  const parent = new FakeElement("ul", { className: "list" });
  parent.appendChild(new FakeElement("li", { className: "css-a1" }));
  const target = parent.appendChild(new FakeElement("li", { className: "css-b2" }));
  const selector = generateSelector(target);
  assert.equal(selector, "ul.list > li:nth-of-type(2)");
});

test("pickTestId zwraca pierwszy pasujący atrybut testowy albo null", () => {
  const withTestId = new FakeElement("li", { attrs: { "data-testid": "product-card" } });
  assert.deepEqual(pickTestId(withTestId), { attr: "data-testid", value: "product-card" });

  const withDataQa = new FakeElement("li", { attrs: { "data-qa": "product-tile" } });
  assert.deepEqual(pickTestId(withDataQa), { attr: "data-qa", value: "product-tile" });

  const withoutAny = new FakeElement("li", { className: "css-x1y2" });
  assert.equal(pickTestId(withoutAny), null);
});

test("valueForAttr obsługuje text/html/atrybut", () => {
  const el = new FakeElement("img", { attrs: { src: "/a.jpg" }, text: "  Cena: 10 zł  " });
  assert.equal(valueForAttr(el, "text"), "Cena: 10 zł");
  assert.equal(valueForAttr(el, "src"), "/a.jpg");
});
