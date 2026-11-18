/** Full command-response JSON budget, leaving room for endpoint encryption and base64. */
export const ATTENTION_SUMMARY_MAX_BYTES = 300_000;
/** Read-only request may be split into smaller subsets after this explicit response. */
export const ATTENTION_SUMMARY_TOO_LARGE = 'attention_summary_too_large';
