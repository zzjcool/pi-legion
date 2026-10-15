/**
 * Provider pinning for ambiguous bare model ids (#123).
 *
 * A model id like `workbuddy/hy4-preview-ioa` can exist under more than one
 * provider: one registered live by an extension (any-endpoint) and one static
 * in models.json without usable auth. Children start with `--no-extensions`,
 * so the live provider only exists when the role lists its extension — and a
 * bare `--model workbuddy/...` still resolves into the FIRST provider that
 * declares the id, which may be the auth-less static one. The child then dies
 * instantly with "No API key found for <provider>".
 *
 * Fix: at dispatch time, ask the PARENT's registry which provider actually
 * owns the resolved model and pass it as `--provider` alongside `--model`.
 * The parent registry reflects the live extension providers, so the pinned
 * provider is the one that can authenticate.
 */

/** Minimal registry surface `providerForModel` needs (subset of ModelRegistry). */
export interface ProviderLookup {
	getAll(): Array<{ provider: string; id: string }>;
}

/**
 * Find the provider that owns `model` in the parent's registry.
 *
 * Returns `undefined` when the model cannot be found or when more than one
 * provider declares the same id AND the id carries no provider prefix — in
 * that ambiguous case pinning a wrong provider is worse than leaving the
 * child to resolve it. Models with a `provider/id` prefix are matched on the
 * full prefixed id first (extension providers register such ids verbatim),
 * then on the suffix after the first slash.
 */
export function providerForModel(
	registry: ProviderLookup | undefined,
	model: string | undefined,
): string | undefined {
	if (!registry || !model) return undefined;
	const bare = model.trim();
	if (!bare) return undefined;

	const models = registry.getAll();
	// Candidates: the id verbatim (extension providers may register prefixed
	// ids) and, when `bare` carries a provider prefix, the id after stripping it
	// (`any-endpoint/workbuddy/x` ↔ registry id `workbuddy/x`).
	const suffix = bare.includes("/") ? bare.slice(bare.indexOf("/") + 1) : undefined;
	const matches = models.filter(
		(m) => m.id === bare || (suffix !== undefined && m.id === suffix),
	);
	if (matches.length === 1) {
		return matches[0]!.provider;
	}
	if (matches.length > 1) {
		// Prefer the provider named by the id's own prefix (`any-endpoint/...`).
		const prefix = bare.split("/")[0]!;
		const prefixed = matches.find((m) => m.provider === prefix);
		return prefixed?.provider;
	}
	return undefined;
}
