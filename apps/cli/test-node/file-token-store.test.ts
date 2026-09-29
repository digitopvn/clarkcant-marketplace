import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileTokenStore, defaultConfigDir } from "../src/file-token-store";

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, "../bin/clark-market.mjs");

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clark-market-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileTokenStore", () => {
  it("stores credentials per API origin in a private file", async () => {
    const store = new FileTokenStore(path.join(dir, "config"));
    expect(await store.get("https://a.example")).toBeNull();
    const credential = { token: "secret-a", kind: "device" as const, savedAt: new Date(0).toISOString() };
    await store.set("https://a.example", credential);
    await store.set("https://b.example", { ...credential, token: "secret-b" });

    expect(await store.get("https://a.example")).toEqual(credential);
    expect(JSON.parse(await readFile(store.location, "utf8"))).toHaveProperty(["https://b.example", "token"], "secret-b");
    if (process.platform !== "win32") {
      expect((await stat(store.location)).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(dir, "config"))).mode & 0o777).toBe(0o700);
    }

    expect(await store.delete("https://a.example")).toBe(true);
    expect(await store.delete("https://a.example")).toBe(false);
    expect(await store.get("https://b.example")).toMatchObject({ token: "secret-b" });
  });

  it("reports a corrupted file instead of overwriting it silently", async () => {
    const store = new FileTokenStore(dir);
    await writeFile(store.location, "{not json");
    await expect(store.get("https://a.example")).rejects.toThrow("not valid JSON");
  });

  it("uses the OS config directory unless overridden", () => {
    expect(defaultConfigDir({ CLARK_MARKET_CONFIG_DIR: "/custom" }, "linux")).toBe("/custom");
    expect(defaultConfigDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "clark-market"));
    expect(defaultConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(path.join("/xdg", "clark-market"));
    expect(defaultConfigDir({}, "darwin")).toContain(path.join("Library", "Application Support", "clark-market"));
  });
});

describe("clark-market executable", () => {
  const env = () => ({ ...process.env, CLARK_MARKET_CONFIG_DIR: dir, CLARK_MARKET_TOKEN: "" });

  it("prints its version and exits 0", async () => {
    const { stdout } = await run(process.execPath, [BIN, "--version"], { env: env() });
    expect(stdout.trim()).toBe("0.1.0");
  }, 30_000);

  it("exits 7 with a JSON error when the marketplace is unreachable", async () => {
    const failure = await run(process.execPath, [BIN, "search", "clock", "--json", "--api-url", "http://127.0.0.1:9"], { env: env() }).catch(
      (error: { code?: number; stdout?: string }) => error,
    );
    expect("code" in failure ? failure.code : 0).toBe(7);
    expect(JSON.parse(String(failure.stdout).trim())).toMatchObject({ error: { code: "network_error" } });
  }, 30_000);
});
