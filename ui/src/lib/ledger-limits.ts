export const LEDGER_BODY_MAX_BYTES = 2_621_440;

/** A chain that CREATES an account is small: UTF-8 size of the serialized chain, and records including the genesis.
 *  Offers for an account that already exists are not bound by these (only by the ledger format's own limits). */
export const CREATION_MAX_BYTES = 131_072;
export const CREATION_MAX_RECORDS = 16;
