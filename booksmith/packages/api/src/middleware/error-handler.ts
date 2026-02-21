import type { MiddlewareHandler } from "hono";
import { ZodError } from "zod";

/**
 * Global error handler middleware.
 *
 * Catches all errors and returns RFC 7807 Problem Details responses.
 */
export const errorHandler: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json(
        {
          type: "https://api.booksmith.app/errors/validation",
          title: "Validation Error",
          status: 400,
          detail: "Request body failed validation.",
          errors: err.errors.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        },
        400
      );
    }

    if (err instanceof AppError) {
      return c.json(
        {
          type: `https://api.booksmith.app/errors/${err.code}`,
          title: err.title,
          status: err.status,
          detail: err.message,
        },
        err.status as 400 | 401 | 403 | 404 | 409 | 429 | 500
      );
    }

    console.error("Unhandled error:", err);
    return c.json(
      {
        type: "https://api.booksmith.app/errors/internal",
        title: "Internal Server Error",
        status: 500,
        detail: "An unexpected error occurred.",
      },
      500
    );
  }
};

/**
 * Application-specific error class.
 */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    public title: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }

  static notFound(resource: string, id: string) {
    return new AppError(
      404,
      "not-found",
      "Not Found",
      `${resource} with ID ${id} does not exist.`
    );
  }

  static conflict(message: string) {
    return new AppError(409, "conflict", "Conflict", message);
  }

  static forbidden(message: string) {
    return new AppError(403, "forbidden", "Forbidden", message);
  }

  static badRequest(message: string) {
    return new AppError(400, "bad-request", "Bad Request", message);
  }
}
