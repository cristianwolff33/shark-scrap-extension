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
} from "../lib/openai-client.js";

test("cleanHtml usuwa script i style, zachowuje resztę", () => {
  const html = "<div>A</div><script>evil()</script><style>.x{color:red}</style><p>B</p>";
  assert.equal(cleanHtml(html), "<div>A</div><p>B</p>");
});

test("cleanHtml obcina do MAX_HTML_CHARS", () => {
  const html = "x".repeat(20_000);
  assert.equal(cleanHtml(html).length, 12_000);
});

test("cleanHtml radzi sobie z pustym/undefined wejściem", () => {
  assert.equal(cleanHtml(undefined), "");
  assert.equal(cleanHtml(""), "");
});

test("buildRequestBody zawiera model, oba komunikaty i json_schema response_format", () => {
  const body = buildRequestBody("<div class='sku'>X1</div>", "https://sklep.pl/p/1", ["sku", "price"], "gpt-5.6-luna");
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].role, "user");
  assert.match(body.messages[1].content, /sku, price/);
  assert.match(body.messages[1].content, /https:\/\/sklep\.pl\/p\/1/);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "ai_field_suggestions");
  assert.equal(body.response_format.json_schema.strict, true);
});

test("buildRequestBody używa DEFAULT_MODEL gdy model nie podany", () => {
  const body = buildRequestBody("<div></div>", "https://x.pl", ["sku"]);
  assert.equal(body.model, DEFAULT_MODEL);
});

test("parseSuggestions parsuje JSON-string z choices[0].message.content", () => {
  const res = {
    choices: [{ message: { content: JSON.stringify({ suggestions: [{ field: "sku", found: true, selector: ".sku", attr: "text", multiple: false, value: "X1" }] }) } }],
  };
  const suggestions = parseSuggestions(res);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].field, "sku");
});

test("parseSuggestions rzuca czytelny błąd na brak content", () => {
  assert.throws(() => parseSuggestions({ choices: [{ message: {} }] }), /brak choices/);
});

test("parseSuggestions rzuca czytelny błąd na niepoprawny JSON w content", () => {
  const res = { choices: [{ message: { content: "{niepoprawny" } }] };
  assert.throws(() => parseSuggestions(res), /niepoprawny JSON/);
});

test("parseSuggestions zwraca [] gdy suggestions nie jest tablicą", () => {
  const res = { choices: [{ message: { content: JSON.stringify({ suggestions: null }) } }] };
  assert.deepEqual(parseSuggestions(res), []);
});

test("suggestFields rzuca czytelny błąd bez klucza API — NIE woła fetch", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(
    () => suggestFields({ apiKey: "", html: "<div></div>", url: "https://x.pl", fields: ["sku"], fetchImpl }),
    /Brak klucza OpenAI/
  );
  assert.equal(called, false);
});

test("suggestFields zwraca [] bez wołania sieci gdy fields jest puste", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const res = await suggestFields({ apiKey: "sk-test", html: "<div></div>", url: "https://x.pl", fields: [], fetchImpl });
  assert.deepEqual(res, { suggestions: [], model: DEFAULT_MODEL });
  assert.equal(called, false);
});

test("suggestFields — happy path zwraca sugestie i użyty model", async () => {
  const fakeResponse = {
    suggestions: [{ field: "sku", found: true, selector: ".sku", attr: "text", multiple: false, value: "X1" }],
  };
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(opts.headers.Authorization, "Bearer sk-test");
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "gpt-5.6-luna");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeResponse) } }] }),
    };
  };
  const res = await suggestFields({ apiKey: "sk-test", model: "gpt-5.6-luna", html: "<div class='sku'>X1</div>", url: "https://sklep.pl/p/1", fields: ["sku"], fetchImpl });
  assert.equal(res.model, "gpt-5.6-luna");
  assert.equal(res.suggestions.length, 1);
  assert.equal(res.suggestions[0].selector, ".sku");
});

test("suggestFields rzuca czytelny błąd na HTTP != ok (np. zły klucz)", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: "Incorrect API key provided" } }),
  });
  await assert.rejects(
    () => suggestFields({ apiKey: "sk-zly", html: "<div></div>", url: "https://x.pl", fields: ["sku"], fetchImpl }),
    /Incorrect API key provided/
  );
});

test("suggestFields rzuca czytelny błąd gdy fetch sam rzuci (np. brak sieci)", async () => {
  const fetchImpl = async () => { throw new Error("network down"); };
  await assert.rejects(
    () => suggestFields({ apiKey: "sk-test", html: "<div></div>", url: "https://x.pl", fields: ["sku"], fetchImpl }),
    /Nie można połączyć się z OpenAI/
  );
});

test("buildAdapterRowsRequestBody wysyła produkty i wymusza strukturę adapter request", () => {
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
  ], "gpt-5.6-luna");
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.response_format.json_schema.name, "adapter_rows");
  assert.match(body.messages[1].content, /TYTUŁ OFERTY/);
  assert.match(body.messages[1].content, /Krzesło/);
});

test("parseAdapterRows parsuje finalne wiersze z odpowiedzi OpenAI", () => {
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
  const rows = parseAdapterRows({ choices: [{ message: { content: JSON.stringify({ rows: [row] }) } }] });
  assert.deepEqual(rows, [row]);
});

test("generateAdapterRows woła OpenAI i zwraca finalne wiersze", async () => {
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
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(opts.headers.Authorization, "Bearer sk-test");
    const body = JSON.parse(opts.body);
    assert.equal(body.response_format.json_schema.name, "adapter_rows");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows: [fakeRow] }) } }] }),
    };
  };
  const res = await generateAdapterRows({ apiKey: "sk-test", products: [{ url: "https://x.pl", fields: {} }], fetchImpl });
  assert.equal(res.model, DEFAULT_MODEL);
  assert.deepEqual(res.rows, [fakeRow]);
});
