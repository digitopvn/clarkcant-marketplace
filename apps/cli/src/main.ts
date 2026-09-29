import { runCli } from "./cli";
import { FileTokenStore, defaultConfigDir } from "./file-token-store";

/** Process entry: real stdio, environment and the credential file in the OS config directory. */
export async function main(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", interrupt);
  try {
    return await runCli(argv, {
      stdout: (text) => void process.stdout.write(text),
      stderr: (text) => void process.stderr.write(text),
      env: process.env,
      tokenStore: new FileTokenStore(defaultConfigDir(process.env)),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", interrupt);
  }
}
