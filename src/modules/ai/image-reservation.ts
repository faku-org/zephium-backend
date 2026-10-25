import { AppError } from "../../platform/errors";
import type { Model } from "../policy";
import type { PreparedRequest } from "./protocol";
import type { InputReservation } from "./reservation";
import type { CloudTransport } from "./transport";

/** Refines only customer escrow. Never use this result for provider-cost budgets. */
export async function customerInputTokens(
  model: Model,
  prepared: PreparedRequest,
  bound: InputReservation,
  transport: CloudTransport,
  signal: AbortSignal,
): Promise<number> {
  if (!bound.countImages) return bound.inputTokens;
  if (signal.aborted) throw new AppError("request_cancelled", 408);
  const deadline = AbortSignal.timeout(5000);
  const counting = AbortSignal.any([signal, deadline]);
  let count: number;
  try {
    count = await transport.count(model, prepared, counting);
  } catch (error) {
    if (signal.aborted) throw new AppError("request_cancelled", 408);
    if (deadline.aborted) throw new AppError("token_count_unavailable", 503, 30);
    if (error instanceof AppError) throw error;
    throw new AppError("token_count_unavailable", 503, 30);
  }
  if (counting.aborted)
    throw new AppError(
      signal.aborted ? "request_cancelled" : "token_count_unavailable",
      signal.aborted ? 408 : 503,
      signal.aborted ? undefined : 30,
    );
  if (!Number.isSafeInteger(count) || count < 0 || count > model.contextWindow)
    throw new AppError("invalid_provider_response", 502);
  if (count + prepared.outputLimit > model.contextWindow)
    throw new AppError("context_limit_exceeded", 400);
  // Output schemas may be omitted by counting endpoints. Cover the generation
  // config separately with the existing text multiplier, without inspecting images.
  const extraConfig =
    model.provider === "google"
      ? prepared.body.generationConfig
      : model.provider === "anthropic"
        ? prepared.body.output_config
        : undefined;
  const extra =
    extraConfig === undefined
      ? 0
      : new TextEncoder().encode(JSON.stringify(extraConfig)).length * 2;
  // Reuse the local estimator's framing margin: native counts can differ slightly
  // from final usage. The provider budget still covers the original context ceiling.
  const margin = Math.min(8192, Math.max(256, Math.ceil(model.contextWindow / 100)));
  return Math.min(bound.inputTokens, count + extra + margin);
}
