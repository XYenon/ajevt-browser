import assert from "node:assert/strict";
import test from "node:test";
import { verify } from "../src/verifier.js";
import { observation } from "./helpers.js";

test("text verifiers read prose that only the rendered page text carries", () => {
  const page = observation({ text: '- heading "Form submitted" [ref=e1]', pageText: "# Form submitted\n\nReceived!" });
  assert.equal(verify(page, [{ type: "text_contains", text: "Received!" }]).passed, true);
  assert.equal(verify(page, [{ type: "text_absent", text: "Received!" }]).passed, false);
});

test("text verifiers still read the accessibility text", () => {
  const page = observation({ text: '- button "Sign in" [ref=e7]', pageText: "" });
  assert.equal(verify(page, [{ type: "text_contains", text: "Sign in" }]).passed, true);
});

test("a term present in either text source satisfies text_absent only when absent everywhere", () => {
  const page = observation({ text: "Cookie settings", pageText: "Manage cookies" });
  assert.equal(verify(page, [{ type: "text_absent", text: "cookie" }]).passed, false);
});
