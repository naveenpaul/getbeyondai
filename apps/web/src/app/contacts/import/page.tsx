'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CsvImportFlow } from '@/components/CsvImportFlow';

/**
 * Standalone CSV import page. The flow itself lives in <CsvImportFlow> so it can
 * be reused in-context (e.g. inside the campaign composer's SourcePicker modal)
 * without navigating away. This page just supplies the chrome + a "View
 * contacts" exit once the import finishes.
 */
export default function ImportContactsPage(): React.JSX.Element {
  const router = useRouter();

  return (
    <main className="container space-y-6 py-12">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 text-sm text-muted-foreground"
      >
        <Link href="/contacts" className="hover:text-foreground">
          Contacts
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-foreground">Import</span>
      </nav>

      <Card className="mx-auto max-w-3xl">
        <CardHeader>
          <CardTitle>Import contacts from CSV</CardTitle>
          <CardDescription>
            Drop a CSV. We&apos;ll show the headers, you confirm the mapping, and
            we import.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CsvImportFlow
            primaryAction={{
              label: 'View contacts',
              onClick: () => router.push('/contacts'),
            }}
          />
        </CardContent>
      </Card>
    </main>
  );
}
