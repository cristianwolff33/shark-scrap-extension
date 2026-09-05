import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanHtml,
  buildRequestBody,
  buildAdapterRowsRequestBody,
  parseAdapterRows,
  parseSuggestions,
  generateAdapterRows,
  suggestFields,
  DEFAULT_MODEL,
} from "../lib/anthropic-client.js";

test("buildRequestBody: system jest osobnym polem (nie wiadomością), wymusza tool_choice", () => {
  const body = buildRequestBody("<div class='sku'>X1</div>", "https://sklep.pl/p/1", ["sku", "price"], "claude-opus-5");
  assert.equal(body.model, "claude-opus-5");
  assert.ok(body.max_tokens > 0);
  assert.match(body.system, /asystentem konfiguracji scrapera/);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content, /sku, price/);
  assert.match(body.messages[0].content, /https:\/\/sklep\.pl\/p\/1/);
  assert.equal(body.tool_choice.type, "tool");
  assert.equal(body.tool_choice.name, "field_suggestions");
  assert.equal(body.tools[0].name, "field_suggestions");
});

test("buildRequestBody używa DEFAULT_MODEL gdy model nie podany", () => {
  const body = buildRequestBody("<div></div>", "https://x.pl", ["sku"]);
  assert.equal(body.model, DEFAULT_MODEL);
});

test("parseSuggestions czyta .input z bloku tool_use field_suggestions", () => {
  const res = {
    content: [
      { type: "text", text: "coś tam" },
      { type: "tool_use", name: "field_suggestions", input: { suggestions: [{ field: "sku", found: true, selector: ".sku", attr: "text", multiple: false, value: "X1" }] } },
    ],
  };
  const suggestions = parseSuggestions(res);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].field, "sku");
});

test("parseSuggestions rzuca czytelny błąd, gdy brak bloku tool_use", () => {
  assert.throws(() => parseSuggestions({ content: [{ type: "text", text: "no tools" }] }), /brak bloku tool_use/);
  assert.throws(() => parseSuggestions({}), /brak bloku tool_use/);
});

test("parseSuggestions zwraca [] gdy suggestions nie jest tablicą", () => {
  const res = { content: [{ type: "tool_use", name: "field_suggestions", input: { suggestions: null } }] };
  assert.deepEqual(parseSuggestions(res), []);
});

test("suggestFields rzuca czytelny błąd bez klucza API — NIE woła fetch", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(
    () => suggestFields({ apiKey: "", html: "<div></div>", url: "https://x.pl", fields: ["sku"], fetchImpl }),
    /Brak klucza Claude/
  );
  assert.equal(called, false);
});

test("suggestFields zwraca [] bez wołania sieci gdy fields jest puste", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const res = await suggestFields({ apiKey: "sk-ant-test", html: "<div></div>", url: "https://x.pl", fields: [], fetchImpl });
  assert.deepEqual(res, { suggestions: [], model: DEFAULT_MODEL });
  assert.equal(called, false);
});

test("suggestFields — happy path zwraca sugestie, użyty model i poprawne nagłówki Anthropic", async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(opts.headers["x-api-key"], "sk-ant-test");
    assert.equal(opts.headers["anthropic-version"], "2023-06-01");
    assert.equal(opts.headers["anthropic-dangerous-direct-browser-access"], "true");
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "claude-haiku-4-5-20251001");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content: [{ type: "tool_use", name: "field_suggestions", input: { suggestions: [{ field: "sku", found: true, selector: ".sku", attr: "text", multiple: false, value: "X1" }] } }],
        }),
    };
  };
  const res = await suggestFields({ apiKey: "sk-ant-test", model: "claude-haiku-4-5-20251001", html: "<div class='sku'>X1</div>", url: "https://sklep.pl/p/1", fields: ["sku"], fetchImpl });
  assert.equal(res.model, "claude-haiku-4-5-20251001");
  assert.equal(res.suggestions.length, 1);
  assert.equal(res.suggestions[0].selector, ".sku");
});

test("suggestFields rzuca czytelny błąd na HTTP != ok (np. zły klucz)", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: "invalid x-api-key" } }),
  });
  await assert.rejects(
    () => suggestFields({ apiKey: "zly-klucz", html: "<div></div>", url: "https://x.pl", fields: ["sku"], fetchImpl }),
    /invalid x-api-key/
  );
});

test("suggestFields rzuca czytelny błąd gdy fetch sam rzuci (np. brak sieci)", async () => {
  const fetchImpl = async () => { throw new Error("network down"); };
  await assert.rejects(
    () => suggestFields({ apiKey: "sk-ant-test", html: "<div></div>", url: "https://x.pl", fields: ["sku"], fetchImpl }),
    /Nie można połączyć się z Claude/
  );
});

test("buildAdapterRowsRequestBody wysyła produkty i wymusza tool_choice adapter_rows", () => {
  const body = buildAdapterRowsRequestBody([
    {
      url: "https://sklep.pl/p/1",
      ok: true,
      fields: {
        product_name: { value: "Krzesło" },
        sku: { value: "K1" },
        description: { value: "Opis" },
        images: { values: ["https://cdn.pl/k1.jpg"] },
      },
    },
  ], "claude-opus-5");
  assert.equal(body.model, "claude-opus-5");
  assert.equal(body.tool_choice.name, "adapter_rows");
  assert.match(body.messages[0].content, /TYTUŁ OFERTY/);
  assert.match(body.messages[0].content, /Krzesło/);
});

test("parseAdapterRows czyta .input.rows z bloku tool_use adapter_rows", () => {
  const row = {
    index: 0,
    Cena: "10",
    SKU: "K1",
    EAN: "",
    OPIS: "<strong>Opis</strong><br>Tekst",
    opis_dodatkowy1: "<strong>Opis</strong><br>Tekst",
    opis_dodatkowy2: "<strong>Cechy</strong><br>",
    opis_dodatkowy3: "<strong>Zastosowanie</strong><br>",
    opis_dodatkowy4: "<strong>Parametry produktu</strong><br>",
    Marka: "Acme",
    "TYTUŁ OFERTY": "Krzesło Acme",
    "KOD PRODUCENTA": "K1",
    UWAGI: "",
  };
  const rows = parseAdapterRows({ content: [{ type: "tool_use", name: "adapter_rows", input: { rows: [row] } }] });
  assert.deepEqual(rows, [row]);
});

test("generateAdapterRows woła Claude i zwraca finalne wiersze", async () => {
  const fakeRow = {
    index: 0,
    Cena: "10",
    SKU: "K1",
    EAN: "",
    OPIS: "Opis",
    opis_dodatkowy1: "Opis 1",
    opis_dodatkowy2: "Opis 2",
    opis_dodatkowy3: "Opis 3",
    opis_dodatkowy4: "Parametry",
    Marka: "Acme",
    "TYTUŁ OFERTY": "Krzesło Acme",
    "KOD PRODUCENTA": "K1",
    UWAGI: "",
  };
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(opts.headers["x-api-key"], "sk-ant-test");
    const body = JSON.parse(opts.body);
    assert.equal(body.tool_choice.name, "adapter_rows");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: "tool_use", name: "adapter_rows", input: { rows: [fakeRow] } }] }),
    };
  };
  const res = await generateAdapterRows({ apiKey: "sk-ant-test", products: [{ url: "https://x.pl", fields: {} }], fetchImpl });
  assert.equal(res.model, DEFAULT_MODEL);
  assert.deepEqual(res.rows, [fakeRow]);
});

test("cleanHtml (re-eksport ze wspólnego lib/ai-shared.js) usuwa script/style", () => {
  const html = "<div>A</div><script>evil()</script><style>.x{color:red}</style><p>B</p>";
  assert.equal(cleanHtml(html), "<div>A</div><p>B</p>");
});
