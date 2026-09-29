import type { PackageDetail, PackageSecurityCheck } from "@marketplace/contracts";

/**
 * Plain-language labels for what a package declares. These describe requests made in `clarkcant.json`; ClarkCant
 * decides and asks for consent at install time. Nothing on the marketplace grants a permission.
 */

export type RiskLevel = "low" | "moderate" | "high";

export interface IsolationLane {
  label: string;
  risk: RiskLevel;
  summary: string;
}

const ISOLATION_LANES: Record<string, IsolationLane> = {
  declarative: {
    label: "Declarative",
    risk: "low",
    summary: "Data and configuration only. It ships no code that runs on your machine.",
  },
  "isolated-ui": {
    label: "Isolated UI",
    risk: "low",
    summary: "Runs in its own sandboxed surface, never inside the ClarkCant window or other packages.",
  },
  service: {
    label: "Service",
    risk: "moderate",
    summary: "Runs a background process that ClarkCant starts, supervises and can stop.",
  },
  "trusted-native": {
    label: "Trusted native",
    risk: "high",
    summary: "Runs native code with your account's privileges. Install only from publishers you trust.",
  },
};

export function isolationLane(isolation: string): IsolationLane {
  return ISOLATION_LANES[isolation] ?? { label: isolation, risk: "high", summary: "Unknown isolation class; treat it as untrusted." };
}

export const ISOLATION_OPTIONS = Object.entries(ISOLATION_LANES).map(([value, lane]) => ({ value, label: lane.label }));

export const KIND_OPTIONS = ["widget", "ui", "tools", "skills", "prompts", "themes", "setup", "driver", "voice"].map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

export const PLATFORM_OPTIONS = [
  { value: "web", label: "Web" },
  { value: "darwin-arm64", label: "macOS (Apple silicon)" },
  { value: "darwin-x64", label: "macOS (Intel)" },
  { value: "linux-x64", label: "Linux x64" },
  { value: "linux-arm64", label: "Linux ARM64" },
  { value: "win32-x64", label: "Windows x64" },
  { value: "win32-arm64", label: "Windows ARM64" },
];

export function platformLabel(platform: string): string {
  return PLATFORM_OPTIONS.find((option) => option.value === platform)?.label ?? platform;
}

type Permission = NonNullable<PackageDetail["latest"]>["permissions"][number];

export interface PermissionLine {
  risk: RiskLevel;
  title: string;
  detail: string;
}

/** One sentence per requested permission, with the lane it falls in. */
export function describePermission(permission: Permission): PermissionLine {
  switch (permission.kind) {
    case "network":
      return { risk: "moderate", title: "Network access", detail: `Can connect to ${permission.value}` };
    case "filesystem":
      return {
        risk: permission.access === "read" ? "moderate" : "high",
        // Widget-dialect manifests list bare paths without an access mode; assume the wider one.
        title: permission.access === "read" ? "Reads files" : permission.access === "write" ? "Reads and writes files" : "File access",
        detail: permission.value,
      };
    case "microphone":
      return { risk: "high", title: "Microphone", detail: "Can record audio while running" };
    case "camera":
      return { risk: "high", title: "Camera", detail: "Can capture video while running" };
    case "lifecycle":
      return { risk: "high", title: "Lifecycle script", detail: `Runs "${permission.value}" during install or update` };
    case "capability":
      return { risk: "moderate", title: "Host capability", detail: permission.value };
  }
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: "Lower risk",
  moderate: "Needs your consent",
  high: "Higher risk",
};

const CHECK_LABELS: Record<string, string> = {
  integrity: "Tarball integrity",
  provenance: "Build provenance",
  "install-scripts": "Install scripts",
  previews: "Preview images",
};

export function checkLabel(check: PackageSecurityCheck): string {
  return CHECK_LABELS[check.check] ?? check.check;
}

/** A short, honest sentence for an automated check. */
export function checkSummary(check: PackageSecurityCheck): string {
  const details = (check.details ?? {}) as Record<string, unknown>;
  switch (check.check) {
    case "integrity":
      return "The npm tarball matched its published sha512 digest when it was indexed.";
    case "provenance":
      return check.result === "pass"
        ? "npm lists a provenance attestation. The marketplace records it but has not verified the signature."
        : "npm lists no provenance attestation for this version.";
    case "install-scripts": {
      const scripts = Array.isArray(details.scripts) ? details.scripts.map(String) : [];
      return scripts.length > 0
        ? `package.json declares npm install scripts: ${scripts.join(", ")}.`
        : "package.json declares no npm install scripts.";
    }
    case "previews":
      return "Some preview images were not valid PNG, JPEG, GIF or WebP files and were skipped.";
    default:
      return check.result === "pass" ? "Passed." : "Needs attention.";
  }
}
