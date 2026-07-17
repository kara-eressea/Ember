// Relative/absolute time labels shared by the profile surfaces (viewer
// header, history rail, mini card stale line, insights rows).

export function ago(atMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - atMs) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  return `${String(Math.floor(hours / 24))}d ago`;
}

export function dateLabel(atMs: number): string {
  return new Date(atMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
