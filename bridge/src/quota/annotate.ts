import type {
  AnnotatedPick,
  AnnotatedTier,
  HarnessModel,
  ModelRoutingConfig,
  ProviderModels,
  ProviderQuota,
  ProviderRouting,
  QuotaProviderId,
  RoutingPick,
} from './types.js';

/** First entry for a provider, so duplicate provider rows resolve to the first one. */
function firstFor<T extends { provider: QuotaProviderId }>(
  list: readonly T[],
  provider: QuotaProviderId,
): T | undefined {
  return list.find((entry) => entry.provider === provider);
}

/** Annotate one pick with the provider's live availability, scoped limits and model check. */
export function annotatePick(
  pick: RoutingPick,
  quota: readonly ProviderQuota[],
  routing: readonly ProviderRouting[],
  models: readonly ProviderModels[],
): AnnotatedPick {
  const route = firstFor(routing, pick.provider);
  const quotaRow = firstFor(quota, pick.provider);
  const modelList = firstFor(models, pick.provider);

  const availability = route ? route.availability : 'unknown';
  const leftPercent = route ? route.leftPercent : null;
  const resetsAt = route ? route.resetsAt : null;
  const scopedLimits = (quotaRow?.scopedLimits ?? []).map((limit) => ({ ...limit }));

  let modelName: string | null = null;
  let problem: string | null = null;
  const checked = modelList !== undefined && modelList.status === 'ok';

  if (modelList && modelList.status === 'ok') {
    const model: HarnessModel | undefined = modelList.models.find((candidate) => candidate.id === pick.model);
    if (!model) {
      problem = `${pick.provider} no longer offers model "${pick.model}"`;
    } else {
      modelName = model.name ?? null;
      if (pick.effort !== null) {
        if (model.efforts.length === 0) {
          problem = `model "${pick.model}" takes no effort setting`;
        } else if (!model.efforts.includes(pick.effort)) {
          problem = `model "${pick.model}" does not support effort "${pick.effort}"`;
        }
      }
    }
  }

  return {
    provider: pick.provider,
    model: pick.model,
    effort: pick.effort,
    modelName,
    availability,
    leftPercent,
    resetsAt,
    scopedLimits,
    problem,
    checked,
  };
}

/** Annotate every tier of the user's routing config, keeping tier and pick order. */
export function annotateTiers(
  config: ModelRoutingConfig,
  quota: readonly ProviderQuota[],
  routing: readonly ProviderRouting[],
  models: readonly ProviderModels[],
): AnnotatedTier[] {
  return config.tiers.map((tier) => ({
    name: tier.name,
    description: tier.description,
    picks: tier.picks.map((pick) => annotatePick(pick, quota, routing, models)),
    guidance: typeof tier.guidance === 'string' ? tier.guidance : '',
  }));
}
