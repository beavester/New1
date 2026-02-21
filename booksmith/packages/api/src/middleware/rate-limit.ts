import type { MiddlewareHandler } from "hono";

/**
 * Rate limiting middleware.
 *
 * Uses Redis sliding window counter.
 * Limits are per-organization, based on their plan tier.
 *
 * Sets headers:
 *   X-RateLimit-Limit
 *   X-RateLimit-Remaining
 *   X-RateLimit-Reset
 */
export const rateLimiter: MiddlewareHandler = async (c, next) => {
  // TODO: Implement Redis-based rate limiting
  //
  // const orgId = c.get('organizationId');
  // const plan = await getOrgPlan(orgId);
  // const limit = PLAN_LIMITS[plan].apiCallsPerDay;
  // const key = `ratelimit:${orgId}:${todayKey()}`;
  //
  // const current = await redis.incr(key);
  // if (current === 1) {
  //   await redis.expire(key, 86400); // 24 hours
  // }
  //
  // c.header('X-RateLimit-Limit', String(limit));
  // c.header('X-RateLimit-Remaining', String(Math.max(0, limit - current)));
  // c.header('X-RateLimit-Reset', String(endOfDayTimestamp()));
  //
  // if (current > limit) {
  //   return c.json({ error: 'Rate limit exceeded' }, 429);
  // }

  await next();
};
