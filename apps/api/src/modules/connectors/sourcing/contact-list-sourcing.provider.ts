import type { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  CandidateCompany,
  FindCandidatesOptions,
  IcpCriteria,
  SourcingProvider,
  SourcingResult,
} from './sourcing-provider';

/**
 * No-key sourcing provider: the candidate pool is a ContactList the user
 * imported (e.g. via CSV). Ships today, no API key.
 *
 * Retrieval ignores the ICP — the pool is pre-defined by the user; ICP matching
 * is the orchestrator's qualifier job (and the Researcher derives + cites the
 * firmographics this provider can't supply). One instance is bound per run with
 * the prospect search's (orgId, listId).
 *
 * Cross-org isolation: every read is filtered through `list.orgId`, so a list
 * belonging to another org is structurally unreachable — it simply yields zero
 * candidates rather than leaking rows.
 *
 * Granularity: a ContactList holds *contacts* (people), but a candidate is a
 * *company*, so members are de-duplicated by normalized company name.
 */
export class ContactListSourcingProvider implements SourcingProvider {
  readonly name = 'contact_list';

  private readonly prisma: PrismaService;
  private readonly orgId: string;
  private readonly listId: string;

  constructor(prisma: PrismaService, orgId: string, listId: string) {
    this.prisma = prisma;
    this.orgId = orgId;
    this.listId = listId;
  }

  async findCandidates(
    _icp: IcpCriteria,
    opts?: FindCandidatesOptions,
  ): Promise<SourcingResult> {
    const members = await this.prisma.contactListMember.findMany({
      // `list: { orgId }` scopes to the caller's org — a cross-org listId
      // matches no rows.
      where: { listId: this.listId, list: { orgId: this.orgId } },
      include: { contact: true },
      orderBy: { addedAt: 'asc' },
    });

    const byCompany = new Map<string, CandidateCompany>();
    for (const member of members) {
      const contact = member.contact;
      const company = (contact.company ?? '').trim();
      // A candidate is a company; skip member rows with no company name.
      if (!company) continue;
      const key = company.toLowerCase();
      if (byCompany.has(key)) continue;
      byCompany.set(key, {
        name: company,
        domain: null,
        linkedinUrl: contact.linkedinUrl ?? null,
        employeeCount: null,
        fundingStage: null,
        raw: {
          contactId: contact.id,
          contactTitle: contact.title ?? null,
        },
      });
    }

    let candidates = [...byCompany.values()];
    const total = candidates.length;
    if (opts?.limit !== undefined && opts.limit >= 0) {
      candidates = candidates.slice(0, opts.limit);
    }

    const summary =
      members.length === 0
        ? `No accessible companies found in list ${this.listId}`
        : `Read ${members.length} contact(s) from your list → ${total} unique ` +
          `compan${total === 1 ? 'y' : 'ies'}` +
          (candidates.length < total ? ` (capped to ${candidates.length})` : '');

    return { candidates, summary };
  }
}
