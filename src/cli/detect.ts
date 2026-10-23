/** Framework detection from a project's package.json and a few file probes. Pure, so it is testable on fixtures. */

export type Framework = "vercel-ai" | "langchain" | "both" | "none";
export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export interface FileProbe {
  has(relativePath: string): boolean;
}

export interface ProjectDetection {
  framework: Framework;
  hasAi: boolean;
  hasLangChain: boolean;
  hasNext: boolean;
  typescript: boolean;
  packageManager: PackageManager;
  /** Where the init template goes: `lib/`, `src/lib/`, or the project root. */
  libDir: string;
  aiVersion: string | null;
  langchainVersion: string | null;
}

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
};

export function detectProject(pkg: PackageJson, files: FileProbe): ProjectDetection {
  const deps: Record<string, string> = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  const hasAi = "ai" in deps;
  const hasLangChain = Object.keys(deps).some((name) => name === "langchain" || name.startsWith("@langchain/"));
  const framework: Framework = hasAi && hasLangChain ? "both" : hasAi ? "vercel-ai" : hasLangChain ? "langchain" : "none";
  const hasNext = "next" in deps;
  const typescript = "typescript" in deps || files.has("tsconfig.json");
  const libDir = files.has("src/lib") ? "src/lib" : files.has("lib") ? "lib" : files.has("src") ? "src/lib" : "lib";
  return {
    framework,
    hasAi,
    hasLangChain,
    hasNext,
    typescript,
    packageManager: detectPackageManager(pkg, files),
    libDir,
    aiVersion: deps.ai ?? null,
    langchainVersion: deps["@langchain/core"] ?? deps.langchain ?? null,
  };
}

export function detectPackageManager(pkg: PackageJson, files: FileProbe): PackageManager {
  const declared = pkg.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lockb") || files.has("bun.lock")) return "bun";
  return "npm";
}

export function installCommand(pm: PackageManager, pkg: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm add ${pkg}`;
    case "yarn":
      return `yarn add ${pkg}`;
    case "bun":
      return `bun add ${pkg}`;
    default:
      return `npm install ${pkg}`;
  }
}
