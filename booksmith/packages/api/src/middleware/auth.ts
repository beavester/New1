import type { MiddlewareHandler } from "hono";

/**
 * Authentication middleware.
 *
 * Supports two auth methods:
 * 1. Session cookie (for dashboard users)
 * 2. API key in Authorization header (for API consumers)
 *
 * Sets c.set('userId') and c.set('organizationId') on success.
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer bks_")) {
    // API key authentication
    const apiKey = authHeader.slice(7);
    const prefix = apiKey.slice(0, 12);

    // TODO: Look up API key by prefix, verify hash, check expiry
    // const keyRecord = await db.query.apiKeys.findFirst({
    //   where: eq(apiKeys.prefix, prefix)
    // });
    // if (!keyRecord || !verifyHash(apiKey, keyRecord.keyHash)) {
    //   return c.json({ error: 'Invalid API key' }, 401);
    // }
    // c.set('userId', 'api');
    // c.set('organizationId', keyRecord.organizationId);

    await next();
    return;
  }

  // Session-based authentication (cookie)
  // TODO: Integrate with Better Auth session verification
  // const session = await auth.api.getSession({ headers: c.req.raw.headers });
  // if (!session) {
  //   return c.json({ error: 'Unauthorized' }, 401);
  // }
  // c.set('userId', session.user.id);
  // c.set('organizationId', session.user.organizationId);

  await next();
};
