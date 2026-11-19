import type { RateLimitResult } from './types.js';

/**
 * Which version of the IETF "RateLimit header fields for HTTP" draft to follow:
 *
 * - `draft-6`: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `RateLimit-Policy`
 * - `draft-7`: `RateLimit: limit=…, remaining=…, reset=…` and `RateLimit-Policy`
 * - `draft-8` and later: structured fields `RateLimit: "name";r=…;t=…` and `RateLimit-Policy: "name";q=…;w=…`
 */
export type HeaderStandard = 'draft-6' | 'draft-7' | 'draft-8';

export interface HeaderOptions {
  /** Default `'draft-6'`, the most widely supported. `false` sends no `RateLimit*` headers. */
  standard?: HeaderStandard | false;
  /** Also send `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds). Default false. */
  legacy?: boolean;
  /** Send `Retry-After` on rejected requests. Default true. */
  retryAfter?: boolean;
  /** Policy name for `draft-8`. Default `'default'`. */
  policyName?: string;
}

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/** The response headers for a result, as a plain object. */
export function rateLimitHeaders(
  result: RateLimitResult,
  options: HeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  const standard = options.standard ?? 'draft-6';
  const limit = String(result.limit);
  const remaining = String(Math.max(0, result.remaining));
  const reset = String(seconds(result.resetMs));
  const window = seconds(result.windowMs);

  if (standard === 'draft-6' || standard === 'draft-7') {
    headers['RateLimit-Policy'] = `${limit};w=${window}`;
    if (standard === 'draft-6') {
      headers['RateLimit-Limit'] = limit;
      headers['RateLimit-Remaining'] = remaining;
      headers['RateLimit-Reset'] = reset;
    } else {
      headers.RateLimit = `limit=${limit}, remaining=${remaining}, reset=${reset}`;
    }
  } else if (standard === 'draft-8') {
    const name = JSON.stringify(options.policyName ?? 'default');
    headers['RateLimit-Policy'] = `${name};q=${limit};w=${window}`;
    headers.RateLimit = `${name};r=${remaining};t=${reset}`;
  }
  if (options.legacy) {
    headers['X-RateLimit-Limit'] = limit;
    headers['X-RateLimit-Remaining'] = remaining;
    headers['X-RateLimit-Reset'] = String(Math.ceil(result.resetAt / 1000));
  }
  if (!result.allowed && options.retryAfter !== false) {
    headers['Retry-After'] = String(Math.max(1, seconds(result.retryAfterMs)));
  }
  return headers;
}
