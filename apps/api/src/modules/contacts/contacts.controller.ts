import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { InvalidEmailError, normalizeEmail } from './identity';

/**
 * Read-only contacts surface.
 *
 * /contacts        — paged list for the contacts table UI (T12.1).
 * /contacts/lookup — single-contact resolver by email; used by the SDR
 *                    Drafter form (T9.8).
 *
 * Both are tenant-scoped via AuthGuard's req.user.orgId. The list is
 * cursor-free for v1 (offset/limit) — the contacts table won't need
 * stable pagination across mutations until volume justifies it.
 */
export interface ContactLookupResponse {
  id: string;
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
}

export interface ContactListItem {
  id: string;
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  updatedAt: string;
}

export interface ContactListResponse {
  items: ContactListItem[];
  total: number;
  limit: number;
  offset: number;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

@Controller('contacts')
@UseGuards(AuthGuard)
export class ContactsController {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
    @Query('q') q?: string,
  ): Promise<ContactListResponse> {
    const limit = clampInt(limitParam, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(offsetParam, 0, 0, Number.MAX_SAFE_INTEGER);
    const search = q?.trim() ?? '';

    const where = {
      orgId: user.orgId,
      ...(search.length > 0
        ? {
            OR: [
              { normalizedEmail: { contains: search.toLowerCase() } },
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName: { contains: search, mode: 'insensitive' as const } },
              { company: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.contact.count({ where }),
    ]);

    return {
      items: rows.map((c) => ({
        id: c.id,
        primaryEmail: c.normalizedEmail,
        firstName: c.firstName,
        lastName: c.lastName,
        title: c.title,
        company: c.company,
        linkedinUrl: c.linkedinUrl,
        updatedAt: c.updatedAt.toISOString(),
      })),
      total,
      limit,
      offset,
    };
  }

  @Get('lookup')
  async lookup(
    @Query('email') email: string | undefined,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ContactLookupResponse> {
    if (!email || email.trim().length === 0) {
      throw new BadRequestException('email query parameter is required');
    }
    let normalized: string;
    try {
      normalized = normalizeEmail(email.trim());
    } catch (err) {
      if (err instanceof InvalidEmailError) {
        throw new BadRequestException(
          `email is not a valid address (${err.reason})`,
        );
      }
      throw err;
    }
    const contact = await this.prisma.contact.findFirst({
      where: { orgId: user.orgId, normalizedEmail: normalized },
    });
    if (!contact) {
      throw new NotFoundException(
        `No contact in your org matches ${email.trim()}`,
      );
    }
    return {
      id: contact.id,
      primaryEmail: contact.normalizedEmail,
      firstName: contact.firstName,
      lastName: contact.lastName,
      title: contact.title,
      company: contact.company,
    };
  }
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
