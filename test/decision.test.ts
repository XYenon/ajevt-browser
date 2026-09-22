import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionRequest, resolveDecision, validateChoice } from "../src/decision.js";
import { buildCandidates } from "../src/observation.js";
import { observation, responseFor } from "./helpers.js";

test("rejects incomplete and invalid probabilities", () => {
  assert.throws(
    () => validateChoice({ choice: "a", confidence: 0.9, probabilities: { a: 0.9 } }, ["a", "b"]),
    /exactly match/,
  );
  assert.throws(
    () => validateChoice({ choice: "a", confidence: 0.9, probabilities: { a: 1.2, b: -0.2 } }, ["a", "b"]),
    /\[0,1\]/,
  );
  assert.throws(
    () => validateChoice({ choice: "a", confidence: 0.9, probabilities: { a: 0.4, b: 0.6 } }, ["a", "b"]),
    /maximum/,
  );
});

test("PRESS and SCROLL expose target heads for exact key and direction", () => {
  const page = observation();
  const request = buildDecisionRequest(
    "press Escape then scroll up",
    page,
    buildCandidates(page, "press Escape then scroll up"),
    [],
    "jev",
  );
  assert.ok(request.questions.press_target);
  assert.ok(request.questions.scroll_target);
});

test("only validates the target head selected by operation", () => {
  const page = observation();
  const space = buildCandidates(page, "continue");
  const request: any = {
    questions: {
      operation: { criteria: Object.fromEntries([...space.byOperation.keys()].map((x) => [x, x])) },
      click_target: {
        criteria: Object.fromEntries((space.byOperation.get("CLICK") ?? []).map((x) => [x.id, x.label])),
      },
    },
  };
  const response = responseFor(request, "CLICK");
  response.answers.type_target = { broken: true };
  assert.equal(resolveDecision(response, space).operation, "CLICK");
});
