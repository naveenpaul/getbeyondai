import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { ResearchRunForm } from '@/components/ResearchRunForm';

export default function NewResearchPage(): React.JSX.Element {
  return (
    <main className="container space-y-6 py-12">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <ResearchRunForm />
      </Suspense>
    </main>
  );
}
