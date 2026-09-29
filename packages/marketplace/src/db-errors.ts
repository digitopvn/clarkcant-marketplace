/**
 * True when `error` is a D1/SQLite constraint failure mentioning `column` (for example `pages.slug`). D1 reports
 * constraint failures only in the message, and drizzle may wrap the original error as `cause`.
 */
export function isConstraintViolation(error: unknown, column: string): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) {
      if (/constraint failed/i.test(current.message) && current.message.includes(column)) return true;
      current = current.cause;
    } else {
      break;
    }
  }
  return false;
}
