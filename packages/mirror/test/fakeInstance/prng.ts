// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Seeded PRNG for the fixture corpus (architecture §5.14, WP-M2).
 *
 * The acceptance criterion for this work package is "two runs → identical
 * bytes", which makes `Math.random()` not merely discouraged but disqualifying:
 * a single call anywhere in the generator turns the committed corpus into a
 * file that can never be regenerated, and a fixture nobody can reproduce is a
 * fixture nobody can review.
 *
 * The generator is mulberry32. Two properties earned it the slot over the
 * shorter LCG one-liner:
 *
 *   - It is integer-only. `Math.imul` is specified by ECMA-262 as a wrapping
 *     32-bit signed multiply, and `>>>` as a wrapping unsigned shift, so the
 *     state sequence is bit-identical on every engine and every platform. A
 *     float LCG (`seed = (seed * 9301 + 49297) % 233280`) depends on double
 *     rounding for large products and is only *usually* portable — "usually"
 *     is not a corpus you can commit.
 *   - Its period (2^32) and equidistribution are far better than an LCG's low
 *     bits, which matters because the corpus derives 32-hex sys_ids from
 *     consecutive draws and a weak low bit would produce visibly patterned
 *     identifiers that sort into runs.
 *
 * Everything downstream is built on {@link SeededRandom.nextUint32} rather than
 * on a [0,1) float, so no value in the corpus ever passes through a double.
 */

/**
 * A deterministic 32-bit PRNG.
 *
 * Instances are stateful and therefore order-sensitive: the corpus generator
 * draws in a fixed declaration order and any reordering of its table list
 * changes every sys_id downstream of the move. That is intentional — the
 * committed corpus is a snapshot of one specific draw order, and the byte
 * comparison in the self-test is what makes an accidental reorder visible.
 */
export class SeededRandom {
  #state: number;

  constructor(seed: number) {
    // `>>> 0` normalizes negatives and non-integers into the 32-bit domain the
    // step function assumes, so `new SeededRandom(-1)` is a legal seed rather
    // than a source of NaN state.
    this.#state = seed >>> 0;
  }

  /** One mulberry32 step. Returns a value in [0, 2^32). */
  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * An integer in [0, maxExclusive).
   *
   * This uses a plain modulo and therefore carries the classic modulo bias for
   * bounds that do not divide 2^32. The bias is accepted deliberately: the
   * requirement on this class is reproducibility, not statistical quality, and
   * rejection sampling would make the number of draws depend on the bound —
   * which would couple the corpus bytes to an implementation detail of the
   * bound rather than to the seed.
   */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt bound must be a positive integer, got ${maxExclusive}`);
    }
    return this.nextUint32() % maxExclusive;
  }

  /** A lowercase hex string of exactly `length` characters. */
  hex(length: number): string {
    let out = "";
    // Each draw yields 8 hex characters; taking them 8 at a time (instead of
    // one nibble per draw) keeps the number of state steps proportional to the
    // output length rather than 8x it, which matters for the 24 000-key bulk
    // table where the difference is ~700 000 wasted steps.
    while (out.length < length) {
      out += this.nextUint32().toString(16).padStart(8, "0");
    }
    return out.slice(0, length);
  }

  /**
   * A sys_id in the only shape the mirror accepts (INV-6, `SYS_ID_RE`):
   * 32 lowercase hex characters.
   */
  sysId(): string {
    return this.hex(32);
  }

  /** A deterministic choice from a non-empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError("pick requires a non-empty list");
    }
    return items[this.nextInt(items.length)] as T;
  }

  /** `count` deterministic bytes — the source of every synthetic attachment body. */
  bytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    // Fill four bytes per draw for the same reason `hex` takes eight nibbles:
    // a 300 000-byte attachment would otherwise cost 300 000 state steps on
    // every request that serves it.
    let i = 0;
    while (i < count) {
      const word = this.nextUint32();
      out[i] = word & 0xff;
      if (i + 1 < count) out[i + 1] = (word >>> 8) & 0xff;
      if (i + 2 < count) out[i + 2] = (word >>> 16) & 0xff;
      if (i + 3 < count) out[i + 3] = (word >>> 24) & 0xff;
      i += 4;
    }
    return out;
  }
}

/**
 * Derive a stable child seed from a string.
 *
 * FNV-1a, 32-bit. Used wherever a value must be a pure function of an identity
 * rather than of draw order — the bulk table synthesizes a row body from its
 * sys_id alone, so page 17 produces the same rows whether it is fetched first
 * or last, and a mid-sweep insert does not shift every row after it.
 */
export function seedFromString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    // Mix the high byte of the code unit too, or every non-ASCII name would
    // collide with its low-byte truncation — the corpus is full of Cyrillic
    // and CJK names, so that collision would be routine rather than exotic.
    hash ^= (value.charCodeAt(i) >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
