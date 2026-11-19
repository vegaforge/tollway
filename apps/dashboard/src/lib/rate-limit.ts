const attempts = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

function recentAttempts(key: string): number[] {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((timestamp) => now - timestamp < WINDOW_MS);
  attempts.set(key, recent);
  return recent;
}

export function isRateLimited(key: string): boolean {
  return recentAttempts(key).length >= MAX_ATTEMPTS;
}

export function recordFailure(key: string): void {
  const recent = recentAttempts(key);
  recent.push(Date.now());
}

export function resetRateLimit(): void {
  attempts.clear();
}
