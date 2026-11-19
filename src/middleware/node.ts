import { rateLimitHeaders } from '../headers.js';
import type { RateLimiter } from '../limiter.js';
import type { RateLimitResult } from '../types.js';
import { type BaseMiddlewareOptions, renderMessage } from './shared.js';

/** The parts of a Node, Express or Connect request the middleware reads. */
export interface NodeLikeRequest {
  /** Set by Express (respects `trust proxy`). */
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
  /** Set by the middleware so later handlers can read the quota. */
  rateLimit?: RateLimitResult;
}

/** The parts of a Node `ServerResponse` the middleware uses. */
export interface NodeLikeResponse {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

export type NextFunction = (err?: unknown) => void;

export interface NodeMiddlewareOptions<Req extends NodeLikeRequest = NodeLikeRequest>
  extends BaseMiddlewareOptions<Req> {
  /** Which bucket a request belongs to. Default: `req.ip`, then the socket address. */
  key?: (req: Req) => string | Promise<string>;
  /** Replace the default 429 response. You must end the response or call `next`. */
  onLimited?: (req: Req, res: NodeLikeResponse, next: NextFunction, result: RateLimitResult) => unknown;
}

/**
 * Middleware for Express, Connect, Polka, router and plain `node:http`
 * style `(req, res, next)` handlers.
 *
 * ```ts
 * app.use(rateLimit(limiter));
 * app.post('/login', rateLimit(loginLimiter, { key: (req) => req.body.email }), login);
 * ```
 */
export function rateLimit<Req extends NodeLikeRequest = NodeLikeRequest>(
  limiter: RateLimiter,
  options: NodeMiddlewareOptions<Req> = {},
) {
  const key = options.key ?? ((req: Req) => req.ip ?? req.socket?.remoteAddress ?? 'unknown');
  return async function rateLimitMiddleware(req: Req, res: NodeLikeResponse, next: NextFunction) {
    let result: RateLimitResult;
    try {
      if (await options.skip?.(req)) return next();
      const cost = options.cost ? await options.cost(req) : 1;
      result = await limiter.consume(await key(req), cost);
    } catch (err) {
      return options.failOpen ? next() : next(err);
    }
    req.rateLimit = result;
    if (options.headers !== false && !res.headersSent) {
      for (const [name, value] of Object.entries(rateLimitHeaders(result, options.headers))) {
        res.setHeader(name, value);
      }
    }
    if (result.allowed) return next();
    if (options.onLimited) return options.onLimited(req, res, next, result);
    try {
      const { body, contentType } = await renderMessage(options, req, result);
      res.statusCode = options.statusCode ?? 429;
      res.setHeader('Content-Type', contentType);
      res.end(body);
    } catch (err) {
      next(err);
    }
  };
}
