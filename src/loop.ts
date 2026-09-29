import { decide } from "./decision.js";
import { matchesAllowedDomain } from "./domains.js";
import { buildCandidates, type CandidateSpace, compactObservation } from "./observation.js";
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
  Operation,
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
  // A page-initiated new tab cannot inherit agent-browser's network controls, so
  // the session can end up on about:blank. Report that cause rather than a
  // generic allowlist violation.
  if (!current.hostname)
    return {
      status: "blocked",
      reason: `The page is no longer an HTTP(S) page (${observation.url}), which happens when a click opens a new tab that cannot inherit the domain allowlist; retry without allowed_domains or choose a link that stays in this tab.`,
    };
  if (options.allowedDomains?.length) {
    if (!matchesAllowedDomain(current.hostname, options.allowedDomains))
      return { status: "blocked", reason: "Current page is outside the configured domain allowlist." };
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
  return [
    candidate.operation,
    candidate.ref ?? "",
    candidate.option ?? candidate.key ?? candidate.direction ?? candidate.valueKey ?? "",
  ].join("|");
}

function withoutExcluded(space: CandidateSpace, excluded: Set<string>): CandidateSpace {
  if (!excluded.size) return space;
  const all = space.all.filter((candidate) => !excluded.has(signature(candidate)));
  const byOperation = new Map<Operation, Candidate[]>();
  for (const candidate of all) {
    const pool = byOperation.get(candidate.operation) ?? [];
    pool.push(candidate);
    byOperation.set(candidate.operation, pool);
  }
  return { all, byOperation };
}

// Command-level failures (timeout, abort, oversized output) mean the browser
// adapter itself could not run, so they end the run. A page-level failure such
// as a click covered by a banner is recoverable: the model can pick another
// action once it sees the failure in the recent history.
function isCommandFailure(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === "string";
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
  let recovery: { reason: string; avoid_previous_signature: string; instruction: string } | undefined;
  const excluded = new Set<string>();
  let excludedFingerprint = "";
  const recover = (candidate: Candidate, reason: string, exclude: boolean) => {
    const sig = signature(candidate);
    recovery = {
      reason,
      avoid_previous_signature: sig,
      instruction: `The previous action (${sig}) ${reason}. Avoid that signature and choose a different strategy from the offered candidates; do not claim completion without evidence.`,
    };
    if (exclude) {
      excludedFingerprint = observation.fingerprint;
      excluded.add(sig);
    }
  };
  let staleReobserves = 0;
  const staleReobserveLimit = 2;
  const hasValues = Object.keys(values).length > 0;
  const filledRefs = new Set<string>();
  const initialOrigin = origin(options.url);

  // Lazy-loading can change unrelated page content between every observation.
  // After two re-decisions, reuse only a decision whose target and local
  // context are unchanged and whose action is still offered on the fresh page.
  const refreshBeforeExecution = async (
    step: number,
    candidate: Candidate,
    decidedOn: Observation,
  ): Promise<{ observation: Observation; proceed: boolean }> => {
    const target = candidate.ref ? decidedOn.elements.find((element) => element.ref === candidate.ref) : undefined;
    const fresh = await browser.observe(options.signal);
    if (fresh.fingerprint === decidedOn.fingerprint) {
      staleReobserves = 0;
      return { observation: fresh, proceed: true };
    }
    const current = target && fresh.elements.find((element) => element.ref === target.ref);
    const targetSurvives =
      current &&
      target.role === current.role &&
      target.name === current.name &&
      target.context === current.context &&
      target.value === current.value &&
      target.filled === current.filled &&
      target.checked === current.checked &&
      target.selected === current.selected &&
      target.disabled === current.disabled &&
      JSON.stringify(target.options) === JSON.stringify(current.options);
    const stillOffered = buildCandidates(fresh, options.goal, values).all.some(
      (offered) =>
        offered.operation === candidate.operation &&
        offered.ref === candidate.ref &&
        offered.option === candidate.option &&
        offered.value === candidate.value &&
        offered.risky === candidate.risky,
    );
    if (targetSurvives && stillOffered && staleReobserves >= staleReobserveLimit && fresh.url === decidedOn.url) {
      staleReobserves = 0;
      return { observation: fresh, proceed: true };
    }
    staleReobserves = targetSurvives && stillOffered && fresh.url === decidedOn.url ? staleReobserves + 1 : 0;
    await options.onProgress?.({ step, phase: "stale-reobserve", url: fresh.url });
    return { observation: fresh, proceed: false };
  };

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
      if (excludedFingerprint && observation.fingerprint !== excludedFingerprint) {
        excluded.clear();
        excludedFingerprint = "";
        recovery = undefined;
        sameAction = 0;
        previousSignature = "";
      }
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

      const space = withoutExcluded(buildCandidates(observation, options.goal, values), excluded);
      const boundTypeCandidate = space.byOperation
        .get("TYPE")
        ?.find(
          (candidate) => candidate.value !== undefined && candidate.ref !== undefined && !filledRefs.has(candidate.ref),
        );
      if (boundTypeCandidate) {
        const refreshed = await refreshBeforeExecution(step, boundTypeCandidate, observation);
        observation = refreshed.observation;
        boundary = navigationBoundary(observation, options, initialOrigin);
        if (boundary) return handoff(boundary.status, options, observation, history, {}, boundary.reason);
        if (!refreshed.proceed) continue;
        try {
          await browser.execute(boundTypeCandidate, options.signal);
        } catch (error) {
          if (isCommandFailure(error)) throw error;
          history.push({
            step,
            operation: "TYPE",
            target: boundTypeCandidate.ref,
            label: boundTypeCandidate.label,
            valueKey: boundTypeCandidate.valueKey,
            confidence: 1,
            changed: false,
            url: observation.url,
            error: error instanceof Error ? error.message : String(error),
          });
          while (history.length > (options.historyLimit ?? 6)) history.shift();
          recover(boundTypeCandidate, "failed on this page", true);
          observation = await browser.observe(options.signal);
          await options.onProgress?.({
            step,
            phase: "action-failed",
            url: observation.url,
            operation: "TYPE",
          });
          continue;
        }
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
          recovery,
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

      const refreshed = await refreshBeforeExecution(step, candidate, observation);
      observation = refreshed.observation;
      boundary = navigationBoundary(observation, options, initialOrigin);
      if (boundary) return handoff(boundary.status, options, observation, history, decision, boundary.reason);
      if (!refreshed.proceed) continue;

      // Repeat detection runs after the freshness check so decisions abandoned
      // as stale do not consume the recovery budget.
      const sig = signature(candidate);
      if (candidate.operation === "WAIT") {
        sameAction = 0;
        previousSignature = "";
      } else {
        sameAction = sig === previousSignature ? sameAction + 1 : 1;
        previousSignature = sig;
        if (sameAction > repeatLimit) {
          recover(candidate, "was repeated without progress", true);
          continue;
        }
      }

      try {
        await browser.execute(candidate, options.signal);
      } catch (error) {
        if (isCommandFailure(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        history.push({
          step,
          operation: candidate.operation,
          target: candidate.ref,
          label: candidate.label,
          valueKey: candidate.valueKey,
          confidence: decision.confidence,
          changed: false,
          url: observation.url,
          error: message,
        });
        while (history.length > (options.historyLimit ?? 6)) history.shift();
        recover(candidate, `failed: ${message}`, true);
        observation = await browser.observe(options.signal);
        noProgress += 1;
        await options.onProgress?.({
          step,
          phase: "action-failed",
          url: observation.url,
          operation: candidate.operation,
        });
        if (noProgress >= 3)
          return handoff(
            "stuck",
            options,
            observation,
            history,
            decision,
            `Actions kept failing without progress: ${message}`,
          );
        continue;
      }
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
      if (changed) {
        recovery = undefined;
        sameAction = 0;
        previousSignature = "";
      } else if (candidate.operation !== "WAIT") {
        recover(candidate, "produced no observable progress", false);
      }
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
      pageText: "",
      elements: [],
      fingerprint: "",
    };
    return handoff("error", options, fallback, history, {}, error instanceof Error ? error.message : String(error));
  } finally {
    if (!options.keepSession) await browser.close().catch(() => undefined);
  }
}
