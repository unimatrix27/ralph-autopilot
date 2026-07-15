import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "@/components/icons";

/**
 * The aggregate-first repo filter (epic #106): the control plane is global across
 * all target repos (capacity is one shared build budget, ADR-0020), with repo as a
 * *filter*, not a primary axis. `ALL` is the default. The selection lives in a
 * context so every view can scope to it; the repo list is empty in the foundations
 * slice (filled from the read API in slice 1).
 */
export const ALL_REPOS = "__all__";

interface RepoFilterContextValue {
  repo: string;
  setRepo: (repo: string) => void;
  repos: string[];
}

const RepoFilterContext = React.createContext<RepoFilterContextValue | null>(null);

export function RepoFilterProvider({ children, repos = [] }: { children: React.ReactNode; repos?: string[] }) {
  const [repo, setRepo] = React.useState<string>(ALL_REPOS);
  const value = React.useMemo(() => ({ repo, setRepo, repos }), [repo, repos]);
  return <RepoFilterContext.Provider value={value}>{children}</RepoFilterContext.Provider>;
}

export function useRepoFilter(): RepoFilterContextValue {
  const ctx = React.useContext(RepoFilterContext);
  if (!ctx) {
    throw new Error("useRepoFilter must be used within a RepoFilterProvider");
  }
  return ctx;
}

export function RepoFilter({ className }: { className?: string }) {
  const { repo, setRepo, repos } = useRepoFilter();
  return (
    <div className={cn("relative", className)}>
      <select
        aria-label="Filter by repository"
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        className="h-9 w-full appearance-none rounded-md border border-input bg-background py-1 pl-3 pr-8 text-sm shadow-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value={ALL_REPOS}>All repos</option>
        {repos.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 opacity-60" />
    </div>
  );
}
