import { rateLimitHeaders } from '../headers.js';
import type { RateLimiter } from '../limiter.js';
import type { RateLimitResult } from '../types.js';
import { type BaseMiddlewareOptions, renderMessage } from './shared.js';

export interface FetchMiddlewareOptions extends BaseMiddlewareOptions<Request> {
  /**
   * Which bucket a request belongs to. Required: Fetch-API requests carry no
   * client address, and which proxy header to trust depends on your host.
   * See `keyByHeader()`.
   */
  key: (req: Request) => string | Promise<string>;
  /** Build your own rejection response. Rate-limit headers are added to it. */
  onLimited?: (req: Request, result: RateLimitResult) => Response | Promise<Response>;
}

/**
 * Reads the client key from a header set by your proxy, taking the first
 * comma-separated value (`x-forwarded-for: client, proxy1`). Only use a
 * header your own infrastructure sets or overwrites; clients can send any
 * header they like.
 *
 * Common choices: `cf-connecting-ip` (Cloudflare), `x-real-ip` (nginx),
 * `x-forwarded-for` (most load balancers), `fly-client-ip` (Fly.io).
 */
export function keyByHeader(name: string, fallback = 'unknown') {
  return (req: Request) => req.headers.get(name)?.split(',')[0]?.trim() || fallback;
}

/** Adds headers to a response, copying it first if its headers are immutable. */
export function withHeaders(response: Response, headers: Record<string, string>) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return response;
  try {
    for (const [name, value] of entries) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of entries) copy.headers.set(name, value);
    return copy;
  }
}

/**
 * Checks one Fetch-API request. Returns the result, the headers to add and,
 * when the request is rejected, the response to send. The building block
 * for `withRateLimit()` and `honoRateLimit()`; use it for other frameworks.
 */
export async function checkRequest(
  limiter: RateLimiter,
  req: Request,
  options: FetchMiddlewareOptions,
): Promise<{ result?: RateLimitResult; headers: Record<string, string>; response?: Response }> {
  let result: RateLimitResult;
  try {
    if (await options.skip?.(req)) return { headers: {} };
    const cost = options.cost ? await options.cost(req) : 1;
    result = await limiter.consume(await options.key(req), cost);
  } catch (err) {
    if (options.failOpen) return { headers: {} };
    throw err;
  }
  const headers = options.headers === false ? {} : rateLimitHeaders(result, options.headers);
  if (result.allowed) return { result, headers };
  let response: Response;
  if (options.onLimited) {
    response = await options.onLimited(req, result);
  } else {
    const { body, contentType } = await renderMessage(options, req, result);
    response = new Response(body, {
      status: options.statusCode ?? 429,
      headers: { 'Content-Type': contentType },
    });
  }
  return { result, headers, response: withHeaders(response, headers) };
}

/**
 * Wraps a Fetch-API handler: Next.js route handlers, Remix and React Router
 * actions, SvelteKit endpoints, Bun.serve, Deno.serve and Cloudflare Workers.
 *
 * ```ts
 * export const POST = withRateLimit(limiter, { key: keyByHeader('x-forwarded-for') }, async (req) => {
 *   return Response.json({ ok: true });
 * });
 * ```
 */
export function withRateLimit<Args extends unknown[]>(
  limiter: RateLimiter,
  options: FetchMiddlewareOptions,
  handler: (req: Request, ...args: Args) => Response | Promise<Response>,
) {
  return async (req: Request, ...args: Args): Promise<Response> => {
    const check = await checkRequest(limiter, req, options);
    if (check.response) return check.response;
    return withHeaders(await handler(req, ...args), check.headers);
  };
}

/** The parts of a Hono `Context` the middleware uses. */
export interface HonoLikeContext {
  req: { raw: Request };
  header(name: string, value: string): void;
}

export interface HonoMiddlewareOptions<C extends HonoLikeContext = HonoLikeContext>
  extends Omit<FetchMiddlewareOptions, 'key' | 'skip' | 'cost' | 'message'> {
  key: (c: C) => string | Promise<string>;
  skip?: (c: C) => boolean | Promise<boolean>;
  cost?: (c: C) => number | Promise<number>;
  message?: FetchMiddlewareOptions['message'];
}

/**
 * Middleware for Hono (and other `(c, next)` frameworks with `c.req.raw`
 * and `c.header()`), without depending on Hono.
 *
 * ```ts
 * app.use('/api/*', honoRateLimit(limiter, { key: (c) => c.req.header('cf-connecting-ip') ?? 'unknown' }));
 * ```
 */
export function honoRateLimit<C extends HonoLikeContext = HonoLikeContext>(
  limiter: RateLimiter,
  options: HonoMiddlewareOptions<C>,
) {
  return async (c: C, next: () => Promise<void>): Promise<Response | undefined> => {
    const { skip, cost, key } = options;
    const check = await checkRequest(limiter, c.req.raw, {
      ...options,
      key: () => key(c),
      skip: skip ? () => skip(c) : undefined,
      cost: cost ? () => cost(c) : undefined,
    });
    if (check.response) return check.response;
    for (const [name, value] of Object.entries(check.headers)) c.header(name, value);
    await next();
    return undefined;
  };
}
