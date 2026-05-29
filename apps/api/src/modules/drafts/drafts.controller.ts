import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { DraftStatus, DraftType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';

/**
 * Drafts inbox surface (T12.2).
 *
 * Powers the approval-queue UI: list pending/approved/rejected drafts
 * across all teammates, drill into a single draft to see its body and
 * the Claims it carries (each tied to a Citation when not abstained).
 *
 * Read-only for v1. Edit / approve / reject / send live in a separate
 * controller once the send destinations are wired — keeps the inbox
 * surface stable while the action side evolves.
 */

const VALID_STATUSES = new Set<DraftStatus>([
  'pending',
  'approved',
  'rejected',
  'edited',
  'sent',
  'partial',
  'failed',
]);

const VALID_TYPES = new Set<DraftType>([
  'email',
  'linkedin_dm',
  'linkedin_post',
  'twitter_post',
  'research_brief',
]);

export interface DraftListItem {
  id: string;
  teammate: string;
  type: DraftType;
  status: DraftStatus;
  recipient: Prisma.JsonValue;
  contentPreview: string;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftListResponse {
  items: DraftListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface DraftDetailClaim {
  id: string;
  text: string;
  abstained: boolean;
  confidence: number | null;
  citation: {
    id: string;
    url: string;
    title: string | null;
    excerpt: string | null;
  } | null;
}

export interface DraftDetailResponse {
  id: string;
  teammate: string;
  type: DraftType;
  status: DraftStatus;
  recipient: Prisma.JsonValue;
  content: Prisma.JsonValue;
  runId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  scheduledFor: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
  claims: DraftDetailClaim[];
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const PREVIEW_CHARS = 240;

@Controller('drafts')
@UseGuards(AuthGuard)
export class DraftsController {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('status') statusParam?: string,
    @Query('teammate') teammateParam?: string,
    @Query('type') typeParam?: string,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
  ): Promise<DraftListResponse> {
    const limit = clampInt(limitParam, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(offsetParam, 0, 0, Number.MAX_SAFE_INTEGER);

    const status = isValidStatus(statusParam) ? statusParam : undefined;
    const type = isValidType(typeParam) ? typeParam : undefined;
    const teammate = teammateParam?.trim() || undefined;

    const where: Prisma.DraftWhereInput = {
      orgId: user.orgId,
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      ...(teammate ? { teammate } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.draft.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.draft.count({ where }),
    ]);

    return {
      items: rows.map((d) => ({
        id: d.id,
        teammate: d.teammate,
        type: d.type,
        status: d.status,
        recipient: d.recipient,
        contentPreview: previewFromContent(d.content),
        runId: d.runId,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      })),
      total,
      limit,
      offset,
    };
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<DraftDetailResponse> {
    const draft = await this.prisma.draft.findFirst({
      where: { id, orgId: user.orgId },
      include: {
        claims: {
          include: { citation: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!draft) {
      throw new NotFoundException(`Draft ${id} not found in your org`);
    }
    return {
      id: draft.id,
      teammate: draft.teammate,
      type: draft.type,
      status: draft.status,
      recipient: draft.recipient,
      content: draft.content,
      runId: draft.runId,
      approvedBy: draft.approvedBy,
      approvedAt: draft.approvedAt ? draft.approvedAt.toISOString() : null,
      scheduledFor: draft.scheduledFor
        ? draft.scheduledFor.toISOString()
        : null,
      postedAt: draft.postedAt ? draft.postedAt.toISOString() : null,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
      claims: draft.claims.map((c) => ({
        id: c.id,
        text: c.text,
        abstained: c.abstained,
        confidence: c.confidence,
        citation: c.citation
          ? {
              id: c.citation.id,
              url: c.citation.url,
              title: c.citation.title,
              excerpt: c.citation.excerpt,
            }
          : null,
      })),
    };
  }
}

function isValidStatus(s: string | undefined): s is DraftStatus {
  return s !== undefined && VALID_STATUSES.has(s as DraftStatus);
}

function isValidType(t: string | undefined): t is DraftType {
  return t !== undefined && VALID_TYPES.has(t as DraftType);
}

export function clampInt(
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

export function previewFromContent(content: Prisma.JsonValue): string {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return '';
  }
  const c = content as Record<string, unknown>;
  // Prefer titles over body. SDR Drafter emits { subject, body }.
  // Researcher emits { headline, body }. Content Drafter emits { body }.
  // Fallback to { content } for any future shape.
  const candidates: unknown[] = [c.subject, c.headline, c.body, c.content];
  for (const v of candidates) {
    if (typeof v === 'string' && v.length > 0) {
      return v.length > PREVIEW_CHARS ? `${v.slice(0, PREVIEW_CHARS)}…` : v;
    }
  }
  return '';
}
