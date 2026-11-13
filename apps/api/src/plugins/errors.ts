import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { pgErrorInfo, PG_ERRORS } from '@pms/db';
import { DomainError } from '@pms/domain';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'not_found',
        message: `No route for ${req.method} ${req.url.split('?')[0]}`,
        requestId: req.id,
      },
    } satisfies ErrorBody);
  });

  app.setErrorHandler((err: FastifyError | DomainError | Error, req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.httpStatus).send({
        error: { code: err.code, message: err.message, details: err.details, requestId: req.id },
      } satisfies ErrorBody);
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({
        path: v.instancePath.replace(/^\//, '').replace(/\//g, '.'),
        message: v.message,
      }));
      const first = issues[0];
      return reply.status(400).send({
        error: {
          code: 'validation',
          message: first
            ? `${first.path ? `${first.path}: ` : ''}${first.message}`
            : 'Invalid request',
          details: { issues },
          requestId: req.id,
        },
      } satisfies ErrorBody);
    }

    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response did not match its schema');
      return reply.status(500).send({
        error: { code: 'internal', message: 'Something went wrong on our side', requestId: req.id },
      } satisfies ErrorBody);
    }

    const fastifyError = err as FastifyError;
    if (
      typeof fastifyError.statusCode === 'number' &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      const code =
        fastifyError.statusCode === 429
          ? 'rate_limited'
          : fastifyError.statusCode === 413
            ? 'validation'
            : 'bad_request';
      return reply.status(fastifyError.statusCode).send({
        error: { code, message: fastifyError.message, requestId: req.id },
      } satisfies ErrorBody);
    }

    // A constraint the domain layer did not translate: report it as a conflict
    // rather than a server fault, without leaking SQL.
    const pg = pgErrorInfo(err);
    if (pg && (pg.code === PG_ERRORS.uniqueViolation || pg.code === PG_ERRORS.exclusionViolation)) {
      req.log.warn({ err, constraint: pg.constraint }, 'untranslated constraint violation');
      return reply.status(409).send({
        error: {
          code: 'conflict',
          message: 'That conflicts with existing data',
          requestId: req.id,
        },
      } satisfies ErrorBody);
    }

    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'internal', message: 'Something went wrong on our side', requestId: req.id },
    } satisfies ErrorBody);
  });
}
