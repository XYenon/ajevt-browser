import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ENDPOINT, type ResolveJevConfigOptions, resolveJevConfig } from "../src/config.js";
import { FetchJevTransport } from "../src/jev.js";
import type { JevTransport } from "../src/types.js";

type PiJevModel = Pick<Parameters<ExtensionContext["modelRegistry"]["classify"]>[0], "provider" | "id">;
const MODEL_ENTRY = "ajevt-browser-model";

export function selectedPiModel(ctx: ExtensionContext): PiJevModel | undefined {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "custom" && entry.customType === MODEL_ENTRY);
  return entry?.type === "custom" ? ((entry.data as { model: PiJevModel | null }).model ?? undefined) : undefined;
}

export function registerPiModelCommand(pi: ExtensionAPI): void {
  pi.registerCommand("ajevt-model", {
    description: "Select the browser's native classifier model for this session",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("/ajevt-model requires an interactive UI.", "error");
        return;
      }
      if (typeof ctx.modelRegistry.getAvailableOfType !== "function") {
        ctx.ui.notify("Native Jev model selection requires Pi 1.0.0 or newer.", "error");
        return;
      }
      const models = await ctx.modelRegistry.getAvailableOfType("classifier");
      if (models.length === 0)
        ctx.ui.notify("No authenticated classifier models. Configure a provider in Pi.", "warning");
      const labels = models.map((model) => `${model.provider}/${model.id}`);
      const current = selectedPiModel(ctx);
      const defaultLabel = "Default (HTTP config or TypeSafe Jev)";
      const selected = await ctx.ui.select(
        `Browser classifier · ${current ? `${current.provider}/${current.id}` : "Default"}`,
        [defaultLabel, ...labels],
      );
      if (selected === undefined) return;
      const model = models[labels.indexOf(selected)];
      pi.appendEntry(MODEL_ENTRY, { model: model ? { provider: model.provider, id: model.id } : null });
      ctx.ui.notify(`Browser classifier: ${model ? selected : "Default"}`, "info");
    },
  });
}

export function resolvePiDecision(
  registry: ExtensionContext["modelRegistry"],
  options: ResolveJevConfigOptions = {},
  selected?: PiJevModel,
): { model: string; transport: JevTransport } {
  const config = resolveJevConfig({ ...options, requireAuth: false });
  // A session selection explicitly opts into Pi's native provider authentication.
  if (!selected && config.apiKey) {
    return { model: config.model, transport: new FetchJevTransport({ ...config, apiKey: config.apiKey }) };
  }
  if (!selected && config.endpoint !== DEFAULT_ENDPOINT)
    throw new Error("A custom Jev endpoint requires JEV_API_KEY or decision.auth; Pi credentials are not reused.");
  if (typeof registry.findOfType !== "function" || typeof registry.classify !== "function")
    throw new Error("Native Jev requires Pi 1.0.0 or newer. Alternatively, configure JEV_API_KEY or decision.auth.");

  const { provider, id } = selected ?? { provider: "typesafe", id: "jev-latest" };
  const model = registry.findOfType("classifier", provider, id);
  if (!model) throw new Error(`Pi has no classifier model ${provider}/${id}. Select a model with /ajevt-model.`);

  return {
    model: model.id,
    transport: {
      async decide(request, signal) {
        const questions: Parameters<typeof registry.classify>[1]["questions"] = {};
        for (const [name, raw] of Object.entries(request.questions)) {
          const question = raw as { type: string; instructions: string; criteria: Record<string, string> };
          questions[name] =
            question.type === "noul"
              ? {
                  type: "bool",
                  instructions: question.instructions,
                  criteria: { true: question.instructions, false: `Not: ${question.instructions}` },
                }
              : { type: "choice", instructions: question.instructions, criteria: question.criteria };
        }
        const result = await registry.classify(
          model,
          { state: request.state as Parameters<typeof registry.classify>[1]["state"], questions },
          {
            signal,
            timeoutMs: config.timeoutMs,
            maxRetries: config.retries,
            headers: selected ? undefined : config.headers,
          },
        );
        if (result.stopReason !== "stop") {
          if (signal?.aborted) throw signal.reason ?? new Error("Jev request aborted");
          throw new Error(result.errorMessage ?? `Pi Jev classification ${result.stopReason}`);
        }
        return {
          model: result.model,
          usage: result.usage,
          answers: Object.fromEntries(
            Object.entries(result.answers).map(([name, answer]) => [
              name,
              answer.type === "bool" ? { noul: answer.probability } : answer,
            ]),
          ),
        };
      },
    },
  };
}
