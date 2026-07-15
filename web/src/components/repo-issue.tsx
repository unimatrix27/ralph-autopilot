/** A short repo + issue chip, used across every section of every view. */
export function RepoIssue({ repo, issue }: { repo: string; issue: number }) {
  return (
    <span className="font-mono text-xs text-muted-foreground">
      {repo}
      <span className="text-foreground"> #{issue}</span>
    </span>
  );
}
