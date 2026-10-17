/**
 * Molang "Versioned Changes". Bedrock selects the rule set per expression: from the pack's
 * `min_engine_version`, or (1.26.x JSON) from `{ "expression": "...", "version": N }`.
 *
 * The per-expression `version` is an internal game enum, NOT an index into the public list:
 * verified in-game (1.26.52, Oxygen test pack t26/t33) that versions 3–5 still use the old ternary
 * associativity and old &&/|| grouping, while 6+ use the fixed rules. Vanilla 1.26.50 files use 12.
 */
export interface VersionedChange {
	engine: string;
	description: string;
}

export const VERSIONED_CHANGES: VersionedChange[] = [
	{ engine: '1.17.0', description: 'Initial support for Versioned Changes.' },
	{ engine: '1.17.30', description: 'query.item_remaining_use_duration converts ticks to seconds and normalizes 1→0.' },
	{ engine: '1.17.40', description: "Content errors for invalid expressions (e.g. 'text' + 1), too many operators in parentheses, unknown tokens." },
	{ engine: '1.18.10', description: 'Ternary operator is right-associative: A ? B : C ? D : E == A ? B : (C ? D : E).' },
	{ engine: '1.18.20', description: 'Logical AND binds tighter than OR; comparisons bind tighter than equality.' },
	{ engine: '1.19.60', description: 'Division by a dynamically determined negative value no longer divides by its absolute value.' },
	{ engine: '1.20.0', description: 'query.cape_flap_amount uses body rotation.' },
	{ engine: '1.20.10', description: 'block_property / has_block_property renamed to block_state / has_block_state.' },
	{ engine: '1.20.40', description: 'block_property / has_block_property deprecated.' },
	{ engine: '1.20.50', description: 'block_property, dash_cooldown_progress, is_scenting, is_rising, is_feelingHappy removed.' },
	{ engine: '1.20.70', description: 'surface_particle_* queries treat leaf blocks as supporting step particles.' },
	{ engine: '1.21.100', description: 'query.is_carrying_block usable by all entities.' },
];

/** The per-expression version vanilla currently writes */
export const LATEST_MOLANG_VERSION = 12;

/** Behaviour switches the parser/compiler understand */
export interface MolangFeatures {
	/** 1.17.40+: invalid expressions are content errors */
	strictErrors: boolean;
	/** 1.18.10+: `A ? B : C ? D : E` groups as `A ? B : (C ? D : E)` */
	ternaryRightAssoc: boolean;
	/** 1.18.20+: && binds tighter than ||; comparisons tighter than equality */
	logicalPrecedence: boolean;
	/** 1.19.60+: dividing by a dynamic negative value divides by the value (not its absolute value) */
	negativeDivisorFix: boolean;
}

export const LATEST_FEATURES: MolangFeatures = { strictErrors: true, ternaryRightAssoc: true, logicalPrecedence: true, negativeDivisorFix: true };

/** Features for a per-expression `version` number (game enum). */
export function featuresForVersion(version: number): MolangFeatures {
	return {
		strictErrors: version >= 3,
		ternaryRightAssoc: version >= 6, // verified: 5 old, 6 new
		logicalPrecedence: version >= 6, // verified: 5 old, 6 new
		negativeDivisorFix: version >= 7, // assumed (later change than the two above)
	};
}

function parseEngine(v: string | readonly number[]): number[] {
	const parts = typeof v === 'string' ? v.split('.').map((s) => parseInt(s, 10) || 0) : [...v];
	while (parts.length < 3) parts.push(0);
	return parts.slice(0, 3);
}

export function compareEngine(a: string | readonly number[], b: string | readonly number[]): number {
	const x = parseEngine(a);
	const y = parseEngine(b);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

/** Features for a pack `min_engine_version` (plain-string expressions in that pack). */
export function featuresForEngine(minEngineVersion: string | readonly number[]): MolangFeatures {
	const at = (v: string) => compareEngine(minEngineVersion, v) >= 0;
	return {
		strictErrors: at('1.17.40'),
		ternaryRightAssoc: at('1.18.10'),
		logicalPrecedence: at('1.18.20'),
		negativeDivisorFix: at('1.19.60'),
	};
}

/** Versioned changes in effect for a pack min_engine_version (for UI) */
export function changesForEngine(minEngineVersion: string | readonly number[]): VersionedChange[] {
	return VERSIONED_CHANGES.filter((c) => compareEngine(c.engine, minEngineVersion) <= 0);
}
