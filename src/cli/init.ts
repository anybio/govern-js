/** `govern init`: detect the framework, print the lines to add, write them on `--write`. */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { detectProject, installCommand, type ProjectDetection } from "./detect";

export const ENV_KEY = "ANYBIO_GOVERN_KEY";
export const ENV_APPLICATION = "ANYBIO_GOVERN_APPLICATION";

export interface InitOptions {
  dir: string;
  write: boolean;
  channel: string;
  audience: string;
}

export function runInit(options: InitOptions): number {
  const dir = resolve(options.dir);
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    console.error(`No package.json in ${dir}. Run this from your project root, or pass --dir.`);
    return 1;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  const detection = detectProject(pkg, { has: (p) => existsSync(join(dir, p)) });
  const plan = planInit(detection, options);

  console.log(plan.summary);
  console.log("");
  console.log(`1. Install the SDK:\n\n   ${plan.install}\n`);
  console.log(`2. Set the application key (from the console, shown once) in your server environment:\n\n   ${ENV_KEY}=gk_...\n   ${ENV_APPLICATION}=<application id or a label>\n`);
  console.log(`3. Add ${plan.file}:\n`);
  console.log(indent(plan.contents));
  console.log(`\n4. Use it at model setup:\n`);
  console.log(indent(plan.usage));
  console.log(`\n5. Send a test message once the key is set:\n\n   npx @anybio/govern test-message\n`);

  if (!options.write) {
    console.log("Nothing was written. Re-run with --write to create the file and add the variable to .env.example.");
    return 0;
  }

  const target = join(dir, plan.file);
  if (existsSync(target)) {
    console.log(`Not overwriting ${plan.file}; it already exists. Merge the lines above by hand.`);
  } else {
    mkdirSync(join(dir, detection.libDir), { recursive: true });
    writeFileSync(target, plan.contents);
    console.log(`Wrote ${plan.file}.`);
  }
  const envExample = join(dir, ".env.example");
  const existing = existsSync(envExample) ? readFileSync(envExample, "utf8") : "";
  const lines: string[] = [];
  if (!existing.includes(`${ENV_KEY}=`)) lines.push(`${ENV_KEY}=`);
  if (!existing.includes(`${ENV_APPLICATION}=`)) lines.push(`${ENV_APPLICATION}=`);
  if (lines.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(envExample, `${prefix}# AnyBio Govern (server-side only; never expose to a browser)\n${lines.join("\n")}\n`);
    console.log(`Added ${lines.join(", ")} to .env.example. Put the real value in your server's environment, not in the repo.`);
  }
  return 0;
}

export interface InitPlan {
  summary: string;
  install: string;
  file: string;
  contents: string;
  usage: string;
}

export function planInit(detection: ProjectDetection, options: Pick<InitOptions, "channel" | "audience">): InitPlan {
  const ext = detection.typescript ? "ts" : "js";
  const file = `${detection.libDir}/govern.${ext}`;
  const framework = detection.framework === "both" ? "vercel-ai" : detection.framework;
  const summary =
    framework === "vercel-ai"
      ? `Detected the Vercel AI SDK (ai ${detection.aiVersion ?? ""})${detection.hasNext ? " in a Next.js project" : ""}.`
      : framework === "langchain"
        ? `Detected LangChain (${detection.langchainVersion ?? ""}).`
        : "No supported framework detected (looked for `ai` and `@langchain/*`). Showing the raw-client install.";
  const install = installCommand(detection.packageManager, "@anybio/govern");
  const client = detection.typescript
    ? `export const govern = new Govern({
  apiKey: process.env.${ENV_KEY}!,
  application: process.env.${ENV_APPLICATION} ?? "my-application",
});`
    : `export const govern = new Govern({
  apiKey: process.env.${ENV_KEY},
  application: process.env.${ENV_APPLICATION} ?? "my-application",
});`;

  if (framework === "vercel-ai") {
    const modelType = detection.typescript ? `: Parameters<typeof wrapLanguageModel>[0]["model"]` : "";
    return {
      summary,
      install,
      file,
      contents: `import { Govern } from "@anybio/govern";
import { withGovern } from "@anybio/govern/vercel-ai";
import { wrapLanguageModel } from "ai";

${client}

// One line at model setup. Patient audience streams are buffer-and-release:
// no token reaches the patient before the decision.
export function gate(model${modelType}) {
  return wrapLanguageModel({
    model,
    middleware: withGovern({ govern, channel: "${options.channel}", audience: "${options.audience}" }),
  });
}
`,
      usage: `import { gate, govern } from "./${detection.libDir}/govern";

// Once per conversation, when the session starts:
await govern.recordDisclosure({ conversationId: chatId, channel: "${options.channel}", textShown: DISCLOSURE_TEXT });

// Every turn:
const result = streamText({
  model: gate(yourModel),
  messages,
  providerOptions: { anybioGovern: { conversationId: chatId, turnId: messageId } },
});`,
    };
  }

  if (framework === "langchain") {
    return {
      summary,
      install,
      file,
      contents: `import { Govern } from "@anybio/govern";
import { governed } from "@anybio/govern/langchain";

${client}

// Wrap the model (or the chain) whose output reaches the patient. The wrapper
// gates; a callback handler alone can only record.
export const gate = ${detection.typescript ? "<I, O>(runnable: import(\"@langchain/core/runnables\").Runnable<I, O>) =>" : "(runnable) =>"}
  governed(runnable, { govern, channel: "${options.channel}", audience: "${options.audience}" });
`,
      usage: `import { gate, govern } from "./${detection.libDir}/govern";

await govern.recordDisclosure({ conversationId: threadId, channel: "${options.channel}", textShown: DISCLOSURE_TEXT });

const reply = await gate(model).invoke(messages, {
  configurable: { anybioGovern: { conversationId: threadId, turnId: messageId } },
});`,
    };
  }

  return {
    summary,
    install,
    file,
    contents: `import { Govern } from "@anybio/govern";

${client}
`,
    usage: `import { govern } from "./${detection.libDir}/govern";

const reply = await govern.guard(
  () => yourModel.complete(messages),
  { conversationId, turnId, channel: "${options.channel}", audience: "${options.audience}" },
);
// Empty when nothing is owed: an outbound hold with no holding line.
if (reply.text !== "") await deliver(reply.text);
await reply.ack();`,
  };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `   ${line}` : line))
    .join("\n");
}
