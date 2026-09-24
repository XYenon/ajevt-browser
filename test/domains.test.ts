import assert from "node:assert/strict";
import test from "node:test";
import { allowedDomainPatterns, matchesAllowedDomain, normalizeAllowedDomain } from "../src/domains.js";

test("a bare domain authorizes its own host and subdomains", () => {
  assert.equal(matchesAllowedDomain("wikipedia.org", ["wikipedia.org"]), true);
  assert.equal(matchesAllowedDomain("en.wikipedia.org", ["wikipedia.org"]), true);
  assert.equal(matchesAllowedDomain("en.m.wikipedia.org", ["wikipedia.org"]), true);
  assert.equal(matchesAllowedDomain("notwikipedia.org", ["wikipedia.org"]), false);
  assert.equal(matchesAllowedDomain("wikipedia.org.example.test", ["wikipedia.org"]), false);
});

test("wildcard entries match the same hosts as their bare domain", () => {
  assert.equal(normalizeAllowedDomain("*.example.test"), "example.test");
  assert.equal(matchesAllowedDomain("example.test", ["*.example.test"]), true);
  assert.equal(matchesAllowedDomain("www.example.test", ["*.example.test"]), true);
  assert.equal(matchesAllowedDomain("WWW.Example.Test.", ["*.example.test"]), true);
});

test("blank and malformed entries never authorize a host", () => {
  assert.equal(matchesAllowedDomain("example.test", []), false);
  assert.equal(matchesAllowedDomain("", ["example.test"]), false);
  assert.equal(matchesAllowedDomain("example.test", ["  ", "."]), false);
  assert.equal(normalizeAllowedDomain(" . "), undefined);
});

test("agent-browser patterns cover the base host and every subdomain", () => {
  assert.deepEqual(allowedDomainPatterns(["wikipedia.org"]).sort(), ["*.wikipedia.org", "wikipedia.org"]);
  assert.deepEqual(allowedDomainPatterns(["*.example.test"]).sort(), ["*.example.test", "example.test"]);
  assert.deepEqual(allowedDomainPatterns(["wikipedia.org", "*.wikipedia.org"]).sort(), [
    "*.wikipedia.org",
    "wikipedia.org",
  ]);
  assert.deepEqual(allowedDomainPatterns(["", "."]), []);
});
