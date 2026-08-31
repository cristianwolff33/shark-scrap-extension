import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyDomain, createDefaultConfig, SCHEMA_VERSION } from "../lib/schema.js";

test("slugifyDomain usuwa www i normalizuje separator", () => {
  assert.equal(slugifyDomain("www.Moj-Sklep.pl"), "moj_sklep_pl");
  assert.equal(slugifyDomain(""), "sklep");
});

test("createDefaultConfig ma poprawną strukturę bazową", () => {
  const c = createDefaultConfig("sklep.pl", "https://sklep.pl/kat");
  assert.equal(c.schema_version, SCHEMA_VERSION);
  assert.equal(c.domain, "sklep.pl");
  assert.equal(c.mode, "requests");
  assert.equal(c.list_page.pagination.mode, "none");
  assert.deepEqual(c.fields, {});
});
