import type { BrowserAdapter, Candidate, ChoiceAnswer, JevResponse, JevTransport, Observation } from "../src/types.js";

export function choice(choice: string, ids: string[], confidence = 0.95): ChoiceAnswer {
  const rest = ids.length > 1 ? (1 - confidence) / (ids.length - 1) : 1;
  return {
    choice,
    confidence,
    probabilities: Object.fromEntries(
      ids.map((id) => [id, id === choice ? (ids.length === 1 ? 1 : confidence) : rest]),
    ),
  };
}

export function responseFor(
  request: any,
  operation: string,
  target?: string,
  options: { confidence?: number; done?: number; stuck?: number; risky?: number } = {},
): JevResponse {
  const confidence = options.confidence ?? 0.95;
  const operationIds = Object.keys(request.questions.operation.criteria);
  const answers: Record<string, unknown> = {
    operation: choice(operation, operationIds, confidence),
    goal_completed: { noul: options.done ?? 0.05 },
    stuck: { noul: options.stuck ?? 0.05 },
    risky: { noul: options.risky ?? 0.05 },
  };
  for (const head of ["click_target", "type_target", "select_target", "press_target", "scroll_target"]) {
    const ids = Object.keys(request.questions[head]?.criteria ?? {});
    if (ids.length)
      answers[head] = choice(
        head === `${operation.toLowerCase()}_target` ? (target ?? ids[0]) : ids[0],
        ids,
        confidence,
      );
  }
  return { answers, model: "fake" };
}

export class FakeJev implements JevTransport {
  calls: any[] = [];
  constructor(private readonly reply: (request: any, index: number) => JevResponse) {}
  async decide(request: any): Promise<JevResponse> {
    this.calls.push(request);
    return this.reply(request, this.calls.length - 1);
  }
}

export class FakeBrowser implements BrowserAdapter {
  actions: Candidate[] = [];
  closed = false;
  observations: Observation[];
  private index = 0;
  constructor(observations: Observation[]) {
    this.observations = observations;
  }
  async open(): Promise<void> {}
  async observe(): Promise<Observation> {
    return this.observations[Math.min(this.index++, this.observations.length - 1)];
  }
  async execute(candidate: Candidate): Promise<void> {
    this.actions.push(candidate);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    url: "https://example.test/",
    title: "Test",
    text: "Form",
    elements: [{ ref: "@e1", role: "button", name: "Continue" }],
    fingerprint: "a",
    ...overrides,
  };
}
