/**
 * Semantic Versioning 2.0.0 precedence for exact versions (`1.2.3`, `1.2.3-beta.1+build`). Build metadata is
 * ignored, as the spec requires. Only versions accepted by the contracts' `semverSchema` reach this code; anything
 * that does not parse sorts below every valid version so it can never displace one.
 */

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  core: [bigint, bigint, bigint];
  prerelease: string[];
}

function parse(version: string): ParsedVersion | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  return {
    core: [BigInt(match[1] ?? "0"), BigInt(match[2] ?? "0"), BigInt(match[3] ?? "0")],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

const NUMERIC = /^\d+$/;

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Negative when `left` precedes `right`, positive when it follows, zero when they have equal precedence. */
export function compareSemver(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index] ?? 0n;
    const y = b.core[index] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  // A version without a prerelease has higher precedence than the same core with one.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

export function isNewerSemver(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}
