import type { FastifyRequest } from 'fastify';

/**
 * A request limit counted per signed-in person rather than per address: the
 * staff of one hotel share an address, and one busy colleague must not use up
 * everyone's allowance.
 */
export const perUser = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest): string => req.session?.user.id ?? req.ip,
  },
});
