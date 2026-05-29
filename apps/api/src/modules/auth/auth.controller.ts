import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createAuth } from './auth.config';

/**
 * Mounts better-auth's catch-all handler at `/api/auth/*` (T6.2).
 *
 * better-auth ships a fetch-compatible `auth.handler(Request)` that
 * returns a `Response`. NestJS+Fastify gives us `FastifyRequest` /
 * `FastifyReply`, so this controller translates between the two:
 *   - Fastify req → Web Request (URL, headers, body)
 *   - Web Response ← Fastify reply (status, headers, body)
 *
 * The handler covers every auth route: /sign-in/magic-link,
 * /sign-out, /get-session, /sign-in/social, etc. Adding a new auth
 * method = adding a plugin in auth.config.ts; this controller doesn't
 * change.
 */
@Controller('api/auth')
export class AuthController {
  private readonly prisma: PrismaService;
  private readonly auth: ReturnType<typeof createAuth>;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
    this.auth = createAuth(prisma);
  }

  @All('*')
  async handle(
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) reply: FastifyReply,
  ): Promise<FastifyReply> {
    const url = new URL(
      req.url,
      `${req.protocol}://${req.headers.host ?? 'localhost'}`,
    );

    // better-auth needs the body as a JSON string (or undefined for GET).
    // Fastify pre-parses JSON bodies into objects; re-serialize for the
    // Fetch Request constructor.
    const body =
      req.method === 'GET' || req.method === 'HEAD' || req.body === undefined
        ? undefined
        : typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);

    // Fastify's headers are `IncomingHttpHeaders` (string | string[] | undefined).
    // Fetch's Headers wants string. Coerce + flatten.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) headers.set(k, v.join(', '));
      else headers.set(k, String(v));
    }

    const webRequest = new Request(url.toString(), {
      method: req.method,
      headers,
      body,
    });

    const auth = await this.auth;
    const response = await auth.handler(webRequest);

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      // Fastify uses `set-cookie` as a special array-aware header. Web
      // Headers concatenates them into a single comma-joined string which
      // browsers reject. Use append for set-cookie.
      if (key.toLowerCase() === 'set-cookie') {
        // Split safely — Headers.getSetCookie() exists on modern Node but
        // not on every Headers implementation; the manual split handles
        // both cases.
        const cookies = (
          'getSetCookie' in response.headers &&
          typeof (response.headers as Headers).getSetCookie === 'function'
            ? (response.headers as Headers).getSetCookie()
            : value.split(/, (?=[^;]+=)/g)
        );
        for (const cookie of cookies) reply.header('set-cookie', cookie);
      } else {
        reply.header(key, value);
      }
    });
    const responseBody = await response.text();
    return reply.send(responseBody);
  }
}
