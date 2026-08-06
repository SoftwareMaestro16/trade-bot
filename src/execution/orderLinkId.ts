/**
 * RSK-36 (RISK-REGISTER.md, FM-18): orderLinkId must be ≤36 chars, from
 * `[A-Za-z0-9_-]`, FIXED WIDTH, namespaced by leg, and produced by a
 * constructor that cannot create an invalid ID. Fixed width specifically —
 * not "a UUID plus a suffix" — because FM-18 cites a real bug (passivbot #436)
 * where UUID4-plus-suffix concatenation occasionally exceeded Bybit's 36-char
 * limit and the order was silently never placed. Fixed-width zero-padded
 * integers make the total length a compile-time-obvious constant, not
 * something that depends on how large a UUID's string form happens to be.
 */

export type Leg = "spot" | "perp";

export interface OrderLinkIdComponents {
  /**
   * The fencing epoch (FM-33 in RISK-REGISTER.md): a monotonic counter bumped
   * on lock acquisition, embedded in every ID so a zombie process holding a
   * stale epoch cannot have its writes mistaken for the current holder's.
   * Deriving the correct epoch value (max(db, exchange) + 1) is I/O and does
   * NOT belong in this pure module — this type only carries the number.
   */
  epoch: number;
  /** Sequential per-epoch intent counter — resets to 0 at each new epoch, does not need to be globally unique on its own. */
  intentSeq: number;
  leg: Leg;
}

const EPOCH_DIGITS = 6;
const INTENT_SEQ_DIGITS = 8;
const MAX_EPOCH = 10 ** EPOCH_DIGITS - 1;
const MAX_INTENT_SEQ = 10 ** INTENT_SEQ_DIGITS - 1;
const VALID_CHARSET = /^[A-Za-z0-9_-]+$/;
const BYBIT_MAX_LENGTH = 36;

function legCode(leg: Leg): "S" | "P" {
  return leg === "spot" ? "S" : "P";
}

/**
 * Total length is always exactly `EPOCH_DIGITS + 1 + INTENT_SEQ_DIGITS + 1 + 1`
 * = 17 characters — well under Bybit's 36-char limit, with headroom deliberately
 * left unused rather than spent, in case a future field needs to join this ID.
 */
export function buildOrderLinkId(components: OrderLinkIdComponents): string {
  if (!Number.isInteger(components.epoch) || components.epoch < 0 || components.epoch > MAX_EPOCH) {
    throw new RangeError(`epoch must be an integer in [0, ${MAX_EPOCH}], got ${components.epoch}`);
  }
  if (!Number.isInteger(components.intentSeq) || components.intentSeq < 0 || components.intentSeq > MAX_INTENT_SEQ) {
    throw new RangeError(`intentSeq must be an integer in [0, ${MAX_INTENT_SEQ}], got ${components.intentSeq}`);
  }

  const id = [
    String(components.epoch).padStart(EPOCH_DIGITS, "0"),
    String(components.intentSeq).padStart(INTENT_SEQ_DIGITS, "0"),
    legCode(components.leg),
  ].join("-");

  // Cannot actually fail given the range checks above — asserted anyway so
  // Bybit's real constraint (RSK-36) is checked directly at the one place
  // this ID is ever constructed, not merely implied by the arithmetic.
  if (id.length > BYBIT_MAX_LENGTH || !VALID_CHARSET.test(id)) {
    throw new Error(
      `Constructed orderLinkId "${id}" violates Bybit's constraints (≤${BYBIT_MAX_LENGTH} chars, ${VALID_CHARSET.source}) — this is a bug in buildOrderLinkId itself, not bad caller input.`,
    );
  }

  return id;
}

/** Inverse of buildOrderLinkId. Returns null for anything not in the exact expected shape — never throws on foreign/malformed input. */
export function parseOrderLinkId(id: string): OrderLinkIdComponents | null {
  const pattern = new RegExp(`^(\\d{${EPOCH_DIGITS}})-(\\d{${INTENT_SEQ_DIGITS}})-([SP])$`);
  const match = pattern.exec(id);
  if (!match) return null;

  const [, epochStr, intentSeqStr, leg] = match;
  return {
    epoch: Number(epochStr),
    intentSeq: Number(intentSeqStr),
    leg: leg === "S" ? "spot" : "perp",
  };
}
