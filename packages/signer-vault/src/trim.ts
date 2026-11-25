/** Returns `value` without its leading and trailing `/` characters. */
export function trimSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === "/") start += 1;
  return trimTrailingSlashes(value.slice(start));
}

/** Returns `value` without its trailing `/` characters. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
