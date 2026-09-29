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

test("HOVER uses a target head while FORWARD and RELOAD select their sole candidates", () => {
  const page = observation({
    elements: [
      { ref: "@menu", role: "button", name: "Products" },
      { ref: "@help", role: "link", name: "Help" },
    ],
  });
  const space = buildCandidates(page, "hover Help");
  const request = buildDecisionRequest("hover Help", page, space, [], "jev");
  assert.ok(request.questions.hover_target);
  const target = space.byOperation.get("HOVER")?.find((candidate) => candidate.ref === "@help");
  assert.ok(target);
  assert.equal(resolveDecision(responseFor(request, "HOVER", target.id), space).candidate?.ref, "@help");
  assert.equal(resolveDecision(responseFor(request, "FORWARD"), space).candidate?.operation, "FORWARD");
  assert.equal(resolveDecision(responseFor(request, "RELOAD"), space).candidate?.operation, "RELOAD");
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
