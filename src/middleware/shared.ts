import type { HeaderOptions } from '../headers.js';
import type { RateLimitResult } from '../types.js';

/** A rejection body: strings are sent as text, everything else as JSON. */
export type MessageBody =
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | { readonly [key: string]: unknown };

/** Options shared by every middleware. `Req` is the framework's request type. */
export interface BaseMiddlewareOptions<Req> {
  /** Units to take for this request. Default 1. */
  cost?: (req: Req) => number | Promise<number>;
  /** Return true to let a request through without counting it (health checks, allow-lists). */
  skip?: (req: Req) => boolean | Promise<boolean>;
  /** Header options, or `false` to send no rate-limit headers at all. */
  headers?: HeaderOptions | false;
  /** Status for rejected requests. Default 429. */
  statusCode?: number;
  /**
   * Body for rejected requests: a string is sent as text/plain, anything else
   * as JSON. Default `'Too many requests, please try again later.'`.
   */
  message?: MessageBody | ((req: Req, result: RateLimitResult) => MessageBody | Promise<MessageBody>);
  /**
   * If the store throws (for example Redis is down), let the request through
   * instead of failing it. Default false.
   */
  failOpen?: boolean;
}

export const DEFAULT_MESSAGE = 'Too many requests, please try again later.';

export async function renderMessage<Req>(
  options: BaseMiddlewareOptions<Req>,
  req: Req,
  result: RateLimitResult,
): Promise<{ body: string; contentType: string }> {
  const raw = typeof options.message === 'function' ? await options.message(req, result) : options.message;
  const value = raw === undefined ? DEFAULT_MESSAGE : raw;
  if (typeof value === 'string') return { body: value, contentType: 'text/plain; charset=utf-8' };
  return { body: JSON.stringify(value), contentType: 'application/json; charset=utf-8' };
}
