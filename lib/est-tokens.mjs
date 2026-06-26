/**
 * est-tokens.mjs — shared chars/4 token estimate.
 *
 * F-10: previously defined inline in 4 places (assembler.mjs, core.mjs,
 * cache-doctor.mjs, test-skills.mjs) with subtly different implementations
 * (some stringified objects, some didn't). This single source prevents drift.
 *
 * For BPE-accurate counts, use gpt-tokenizer in the benchmark modules.
 * This is the fast estimate used in hot paths (hooks, reports, planning).
 *
 * Node >= 18. Zero dependencies.
 */

/**
 * Estimate token count from a string or object via chars/4.
 * Objects are JSON-stringified first (matching the original assembler.mjs behavior).
 * @param {string|object} s
 * @returns {number}
 */
export const estTokens = (s) =>
  Math.ceil((typeof s === 'string' ? s : JSON.stringify(s)).length / 4);

export default estTokens;
