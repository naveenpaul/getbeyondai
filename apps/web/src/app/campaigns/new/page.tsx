import { CampaignComposer } from '@/components/CampaignComposer';

/**
 * Standalone "start a campaign" entry. The same composer lives on the home
 * screen; this route exists so the create flow is linkable (e.g. a "new
 * campaign" affordance) without the campaign list around it.
 */
export default function NewCampaignPage(): React.JSX.Element {
  return (
    <main className="container max-w-2xl space-y-6 py-12">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Start a search
        </h1>
        <p className="text-sm text-muted-foreground">
          Describe your goal. We&apos;ll derive your ICP, source lookalikes, and
          rank them by fit — every signal cited.
        </p>
      </header>
      <CampaignComposer variant="inline" autoFocus />
    </main>
  );
}
