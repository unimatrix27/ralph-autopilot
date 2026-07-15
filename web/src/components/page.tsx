import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** A page header (title + optional subtitle). */
export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

/**
 * A placeholder card for a route whose feature ships in a later slice — so the
 * shell is fully navigable today while making the roadmap legible (epic #106).
 */
export function ComingSoon({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}
