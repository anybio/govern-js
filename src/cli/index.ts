/**
 * `npx @anybio/govern <command>`
 *
 *   init [--write] [--dir <path>] [--channel <c>] [--audience <a>]
 *   test-message [--channel <c>] [--audience <a>] [--base-url <url>] [--content <text>] [--conversation-id <id>] [--skip-disclosure]
 *   decision <id> [--base-url <url>]
 */

import { SDK_NAME, SDK_VERSION } from "../version";
import { runInit } from "./init";
import { runDecision, runTestMessage } from "./test-message";

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

const HELP = `${SDK_NAME} ${SDK_VERSION}

Usage: npx @anybio/govern <command> [options]

Commands:
  init            Detect the framework and print the lines to add. --write creates the file.
                  Options: --write, --dir <path>, --channel <web_chat|sms|app_message|voice|email>, --audience <patient|clinician>
  test-message    Post a synthetic draft with a prohibited claim and print the decision.
                  Options: --channel, --audience, --base-url <url>, --content <text>, --conversation-id <id>, --skip-disclosure
  decision <id>   Fetch a decision and its review state. Options: --base-url <url>

Environment:
  ANYBIO_GOVERN_KEY           the application key (server-side secret)
  ANYBIO_GOVERN_APPLICATION   the application id or a label (optional)
  ANYBIO_GOVERN_BASE_URL      override the API origin (optional; for a mock server)
`;

function flagString(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  if (!command || command === "help" || flags.help === true) {
    console.log(HELP);
    return 0;
  }
  if (flags.version === true || command === "version") {
    console.log(SDK_VERSION);
    return 0;
  }
  switch (command) {
    case "init":
      return runInit({
        dir: flagString(flags, "dir") ?? process.cwd(),
        write: flags.write === true,
        channel: flagString(flags, "channel") ?? "web_chat",
        audience: flagString(flags, "audience") ?? "patient",
      });
    case "test-message":
      return runTestMessage({
        channel: flagString(flags, "channel") ?? "web_chat",
        audience: flagString(flags, "audience") ?? "patient",
        baseUrl: flagString(flags, "base-url"),
        content: flagString(flags, "content"),
        conversationId: flagString(flags, "conversation-id"),
        skipDisclosure: flags["skip-disclosure"] === true,
      });
    case "decision": {
      const id = positionals[0];
      if (!id) {
        console.error("usage: govern decision <id>");
        return 1;
      }
      return runDecision(id, flagString(flags, "base-url"));
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

const invokedDirectly =
  typeof process !== "undefined" && Array.isArray(process.argv) && /(^|[\\/])(cli\.(js|cjs|mjs|ts)|govern)$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      process.exitCode = 1;
    },
  );
}
