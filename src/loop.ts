import { decide } from "./decision.js";
import { buildCandidates, compactObservation } from "./observation.js";
import { requestsActionOnLabel } from "./policy.js";
import type {
  BrowserAdapter,
  Candidate,
  Decision,
  Handoff,
  HandoffStatus,
  HistoryEntry,
  JevTransport,
  Observation,
  Verifier,
} from "./types.js";
import { verify } from "./verifier.js";

export interface RunOptions {
  goal: string;
  url: string;
  values?: Record<string, string>;
  maxSteps?: number;
  allowRisky?: boolean;
  allowedDomains?: string[];
  ignoreHttpsErrors?: boolean;
  caCert?: string;
  proxy?: string;
  proxyBypass?: string[];
  hostMappings?: Record<string, string>;
  keepSession?: boolean;
  requireAction?: boolean;
  verifiers?: Verifier[];
  confidenceThreshold?: number;
  goalThreshold?: number;
  riskThreshold?: number;
  stuckThreshold?: number;
  repeatLimit?: number;
  historyLimit?: number;
  model?: string;
  signal?: AbortSignal;
  onProgress?: (event: { step: number; phase: string; url?: string; operation?: string }) => void | Promise<void>;
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function navigationBoundary(
  observation: Observation,
  options: RunOptions,
  initialOrigin: string,
): { status: "blocked" | "needs_confirmation"; reason: string } | undefined {
  const current = new URL(observation.url);
  if (options.allowedDomains?.length) {
    const allowed = options.allowedDomains.some(
      (domain) => current.hostname === domain || current.hostname.endsWith(`.${domain}`),
    );
    if (!allowed) return { status: "blocked", reason: "Current page is outside the configured domain allowlist." };
  } else if (current.origin !== initialOrigin) {
    return { status: "needs_confirmation", reason: "Navigation crossed origin and no domain allowlist authorized it." };
  }
  return undefined;
}

function handoff(
  status: HandoffStatus,
  options: RunOptions,
  observation: Observation,
  history: HistoryEntry[],
  decision: Partial<Decision>,
  reason: string,
  extra: Partial<Handoff> = {},
): Handoff {
  const next: Record<HandoffStatus, string> = {
    done: "No further action required.",
    likely_done: "The caller should inspect the evidence or supply a deterministic verifier.",
    input_required:
      "The caller should generate or ask for the requested value, then call ajevt_browser again with values.",
    ambiguous: "The caller should refine the goal or take over the uncertain step.",
    needs_confirmation: "Ask the user to confirm, then retry with allow_risky=true if approved.",
    blocked: "The caller should handle the blocker or choose another approach.",
    stuck: "The caller should inspect the compact state and take over or refine the task.",
    error: "The caller should inspect the error and retry only after correcting it.",
  };
  return {
    status,
    session_id: options.keepSession ? browserSession(options) : undefined,
    goal: options.goal,
    url: observation.url,
    observation: compactObservation(observation),
    recent_actions: history.slice(-(options.historyLimit ?? 6)),
    confidence: decision.confidence ?? 0,
    reason,
    resumable: options.keepSession === true,
    next: next[status],
    ...extra,
  };
}

function browserSession(options: RunOptions): string | undefined {
  return (options as RunOptions & { activeSession?: string }).activeSession;
}

function signature(candidate: Candidate): string {
  return [candidate.operation, candidate.ref ?? "", candidate.option ?? candidate.key ?? candidate.valueKey ?? ""].join(
    "|",
  );
}

function canVerifyAfterActions(history: HistoryEntry[], verifiers: Verifier[] = []): boolean {
  if (history.some((entry) => entry.operation !== "TYPE")) return true;
  return (
    verifiers.length > 0 &&
    verifiers.every(
      (check) => check.type === "value_equals" || check.type === "element_value_equals" || check.type === "checked",
    )
  );
}

export async function runBrowserLoop(
  browser: BrowserAdapter,
  jev: JevTransport,
  options: RunOptions,
): Promise<Handoff> {
  const history: HistoryEntry[] = [];
  (options as RunOptions & { activeSession?: string }).activeSession = browser.session;
  const values = options.values ?? {};
  const maxSteps = options.maxSteps ?? 12;
  const confidenceThreshold = options.confidenceThreshold ?? 0.62;
  const goalThreshold = options.goalThreshold ?? 0.82;
  const riskThreshold = options.riskThreshold ?? 0.55;
  const stuckThreshold = options.stuckThreshold ?? 0.82;
  const repeatLimit = options.repeatLimit ?? 2;
  let observation: Observation;
  let sameAction = 0;
  let previousSignature = "";
  let noProgress = 0;
  const hasValues = Object.keys(values).length > 0;
  const filledRefs = new Set<string>();
  const initialOrigin = origin(options.url);

  try {
    await browser.open(
      options.url,
      {
        allowedDomains: options.allowedDomains,
        ignoreHttpsErrors: options.ignoreHttpsErrors,
        caCert: options.caCert,
        proxy: options.proxy,
        proxyBypass: options.proxyBypass,
        hostMappings: options.hostMappings,
      },
      options.signal,
    );
    observation = await browser.observe(options.signal);
    let boundary = navigationBoundary(observation, options, initialOrigin);
    if (boundary) return handoff(boundary.status, options, observation, history, {}, boundary.reason);
    if (hasValues) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidates = buildCandidates(observation, options.goal, values);
        const hasBoundValue = candidates.byOperation.get("TYPE")?.some((candidate) => candidate.value !== undefined);
        if (hasBoundValue) break;
        await browser.execute(
          { id: "readiness-wait", operation: "WAIT", label: "Wait for caller-bound fields" },
          options.signal,
        );
        observation = await browser.observe(options.signal);
        boundary = navigationBoundary(observation, options, initialOrigin);
        if (boundary) return handoff(boundary.status, options, observation, history, {}, boundary.reason);
      }
    }
    if (options.verifiers?.length && !hasValues) {
      for (
        let attempt = 0;
        attempt < 6 && observation.elements.length === 0 && !verify(observation, options.verifiers).passed;
        attempt++
      ) {
        await browser.execute(
          { id: "verifier-readiness-wait", operation: "WAIT", label: "Wait for verifiable page content" },
          options.signal,
        );
        observation = await browser.observe(options.signal);
        boundary = navigationBoundary(observation, options, initialOrigin);
        if (boundary) return handoff(boundary.status, options, observation, history, {}, boundary.reason);
      }
    }
    await options.onProgress?.({ step: 0, phase: "observed", url: observation.url });

    for (let step = 1; step <= maxSteps; step++) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
      boundary = navigationBoundary(observation, options, initialOrigin);
      if (boundary) return handoff(boundary.status, options, observation, history, {}, boundary.reason);
      // Caller-authored deterministic checks can prove an already-satisfied
      // read-only goal immediately. After TYPE, text checks are deferred until a
      // subsequent non-TYPE action so input text cannot masquerade as output.
      if (
        options.verifiers?.length &&
        ((!history.length && !options.requireAction) || canVerifyAfterActions(history, options.verifiers))
      ) {
        const verification = verify(observation, options.verifiers);
        if (verification.passed)
          return handoff("done", options, observation, history, {}, "Deterministic completion checks passed.", {
            verification,
          });
      }

      const space = buildCandidates(observation, options.goal, values);
      const boundTypeCandidate = space.byOperation
        .get("TYPE")
        ?.find(
          (candidate) => candidate.value !== undefined && candidate.ref !== undefined && !filledRefs.has(candidate.ref),
        );
      if (boundTypeCandidate) {
        const fresh = await browser.observe(options.signal);
        if (fresh.fingerprint !== observation.fingerprint) {
          observation = fresh;
          await options.onProgress?.({ step, phase: "stale-reobserve", url: observation.url });
          continue;
        }
        await browser.execute(boundTypeCandidate, options.signal);
        filledRefs.add(boundTypeCandidate.ref!);
        const after = await browser.observe(options.signal);
        history.push({
          step,
          operation: "TYPE",
          target: boundTypeCandidate.ref,
          label: boundTypeCandidate.label,
          valueKey: boundTypeCandidate.valueKey,
          confidence: 1,
          changed: after.fingerprint !== observation.fingerprint,
          url: after.url,
        });
        while (history.length > (options.historyLimit ?? 6)) history.shift();
        observation = after;
        await options.onProgress?.({ step, phase: "executed", url: after.url, operation: "TYPE" });
        boundary = navigationBoundary(observation, options, initialOrigin);
        if (boundary) return handoff(boundary.status, options, observation, history, {}, boundary.reason);
        continue;
      }
      if (!options.allowRisky) {
        const explicitRiskyMatches = (space.byOperation.get("CLICK") ?? []).filter((candidate) => {
          if (!candidate.risky || !candidate.ref) return false;
          const element = observation.elements.find((item) => item.ref === candidate.ref);
          return element?.name ? requestsActionOnLabel(options.goal, element.name) : false;
        });
        if (explicitRiskyMatches.length === 1) {
          const pending = explicitRiskyMatches[0];
          return handoff(
            "needs_confirmation",
            options,
            observation,
            history,
            { confidence: 1 },
            "The explicitly requested action is destructive or creates an external commitment.",
            { pending_action: { operation: pending.operation, ref: pending.ref, label: pending.label } },
          );
        }
      }
      await options.onProgress?.({ step, phase: "deciding", url: observation.url });
      let decision: Decision;
      try {
        decision = await decide(
          jev,
          options.goal,
          observation,
          space,
          history.slice(-(options.historyLimit ?? 6)),
          options.model ?? "jev-latest",
          options.signal,
        );
      } catch (error) {
        return handoff(
          "error",
          options,
          observation,
          history,
          {},
          `Invalid or failed Jev decision; no action executed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const candidate = decision.candidate!;
      await options.onProgress?.({ step, phase: "decided", url: observation.url, operation: decision.operation });

      // Completion is an independent head. When it crosses the configured
      // threshold, deterministic verification is stronger evidence than an
      // uncertain next-operation head, so evaluate it before action confidence.
      if (decision.goalCompleted >= goalThreshold || decision.operation === "DONE") {
        const verification = verify(observation, options.verifiers);
        return handoff(
          verification.passed ? "done" : "likely_done",
          options,
          observation,
          history,
          decision,
          verification.passed
            ? "Deterministic completion checks passed."
            : "Jev claims completion, but deterministic proof is absent or failed.",
          { verification },
        );
      }
      if (decision.confidence < confidenceThreshold)
        return handoff(
          "ambiguous",
          options,
          observation,
          history,
          decision,
          `Decision confidence ${decision.confidence.toFixed(3)} is below ${confidenceThreshold}.`,
        );
      if (decision.stuck >= stuckThreshold || decision.operation === "BLOCKED")
        return handoff(
          "blocked",
          options,
          observation,
          history,
          decision,
          "Jev reports that no safe supported action can progress.",
        );
      if (candidate.operation === "TYPE" && candidate.value === undefined) {
        const field = observation.elements.find((element) => element.ref === candidate.ref)!;
        return handoff(
          "input_required",
          options,
          observation,
          history,
          decision,
          "The chosen field has no semantically bound caller value.",
          {
            field: {
              ref: field.ref,
              role: field.role,
              name: field.name,
              context: `${observation.title}: ${observation.text.slice(0, 300)}`,
              value_key: candidate.valueKey,
            },
          },
        );
      }
      if ((candidate.risky || decision.risky >= riskThreshold) && !options.allowRisky) {
        return handoff(
          "needs_confirmation",
          options,
          observation,
          history,
          decision,
          "The next action appears destructive or creates an external commitment.",
          { pending_action: { operation: candidate.operation, ref: candidate.ref, label: candidate.label } },
        );
      }

      const sig = signature(candidate);
      if (candidate.operation === "WAIT") {
        sameAction = 0;
        previousSignature = "";
      } else {
        sameAction = sig === previousSignature ? sameAction + 1 : 1;
        previousSignature = sig;
        if (sameAction > repeatLimit)
          return handoff(
            "stuck",
            options,
            observation,
            history,
            decision,
            "Repeated-action recovery budget exhausted.",
          );
      }

      const fresh = await browser.observe(options.signal);
      if (fresh.fingerprint !== observation.fingerprint) {
        observation = fresh;
        await options.onProgress?.({ step, phase: "stale-reobserve", url: observation.url });
        continue;
      }

      await browser.execute(candidate, options.signal);
      const after = await browser.observe(options.signal);
      const changed = after.fingerprint !== observation.fingerprint;
      history.push({
        step,
        operation: candidate.operation,
        target: candidate.ref,
        label: candidate.label,
        valueKey: candidate.valueKey,
        confidence: decision.confidence,
        changed,
        url: after.url,
      });
      while (history.length > (options.historyLimit ?? 6)) history.shift();
      await options.onProgress?.({ step, phase: "executed", url: after.url, operation: candidate.operation });
      noProgress = changed || candidate.operation === "WAIT" ? 0 : noProgress + 1;
      observation = after;
      boundary = navigationBoundary(observation, options, initialOrigin);
      if (boundary) return handoff(boundary.status, options, observation, history, decision, boundary.reason);
      if (noProgress >= 3)
        return handoff(
          "stuck",
          options,
          observation,
          history,
          decision,
          "Three consecutive non-wait actions produced no observable progress.",
        );
    }
    return handoff("stuck", options, observation!, history, {}, `Maximum step budget (${maxSteps}) reached.`);
  } catch (error) {
    const fallback: Observation = observation! ?? {
      url: options.url,
      title: "",
      text: "",
      elements: [],
      fingerprint: "",
    };
    return handoff("error", options, fallback, history, {}, error instanceof Error ? error.message : String(error));
  } finally {
    if (!options.keepSession) await browser.close().catch(() => undefined);
  }
}
