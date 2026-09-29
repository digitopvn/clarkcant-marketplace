import { useState, type SubmitEvent } from "react";

import { describeError, requestJson } from "./request";
import { Button, Notice, inputClass } from "./ui";

type Step = "enter" | "confirm" | "approved" | "denied";

/**
 * Device authorization (RFC 8628) verification. Looking the code up first claims it for this signed-in session;
 * Better Auth refuses approval of a code that no verifying session has claimed.
 */
export default function DeviceApproval({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [step, setStep] = useState<Step>("enter");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const normalized = code.trim().toUpperCase();

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setPending(false);
    }
  }

  function onLookup(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      await requestJson(`/api/auth/device?user_code=${encodeURIComponent(normalized)}`);
      setStep("confirm");
    });
  }

  const decide = (approve: boolean) =>
    run(async () => {
      await requestJson(approve ? "/api/auth/device/approve" : "/api/auth/device/deny", { method: "POST", body: { userCode: normalized } });
      setStep(approve ? "approved" : "denied");
    });

  if (step === "approved") return <Notice tone="success">Device approved. You can return to your terminal.</Notice>;
  if (step === "denied") return <Notice tone="info">Request denied. The device was not signed in.</Notice>;

  return (
    <div className="space-y-4">
      {step === "enter" ? (
        <form onSubmit={onLookup} className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Code shown on your device</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              className={`${inputClass} font-mono text-lg tracking-widest uppercase`}
            />
          </label>
          <Button type="submit" disabled={pending || normalized === ""}>
            {pending ? "Checking…" : "Continue"}
          </Button>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            A device is asking to sign in to your marketplace account with code <code className="font-mono">{normalized}</code>. Approve
            only if you started this sign-in yourself, for example with <code className="font-mono">clark-market login</code>.
          </p>
          <div className="flex gap-2">
            <Button disabled={pending} onClick={() => void decide(true)}>
              Approve
            </Button>
            <Button tone="secondary" disabled={pending} onClick={() => void decide(false)}>
              Deny
            </Button>
          </div>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
