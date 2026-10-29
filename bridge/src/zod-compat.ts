import { z } from 'zod';

/** Match the prior default datetime grammar, including minute-precision UTC values. */
export const legacyDateTimeSchema = z.union([z.iso.datetime(), z.iso.datetime({ precision: -1 })]);
