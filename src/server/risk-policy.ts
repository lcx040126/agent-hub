export const RISK_CATEGORIES = [
  "repository_scope",
  "normal_source",
  "unity_scene_prefab",
  "unity_serialized",
  "project_settings",
  "git_ci",
  "structured_config",
  "luban",
  "other",
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export type RiskLevel = "warning" | "blocking";
export type RiskRuleKind = "category" | "extension" | "file" | "directory";

export interface RiskPolicyRule {
  id?: string;
  kind: RiskRuleKind;
  selector: string;
  level: RiskLevel;
}

export interface RiskPolicy {
  version: number;
  rules: RiskPolicyRule[];
}

export interface RiskEvaluation {
  path: string;
  category: RiskCategory;
  level: RiskLevel;
  configuredLevel: RiskLevel;
  matchedRule: RiskPolicyRule;
  reason: string;
}

const DEFAULT_CATEGORY_LEVELS: Record<RiskCategory, RiskLevel> = {
  repository_scope: "blocking",
  normal_source: "warning",
  unity_scene_prefab: "blocking",
  unity_serialized: "blocking",
  project_settings: "blocking",
  git_ci: "blocking",
  structured_config: "blocking",
  luban: "warning",
  other: "warning",
};

const UNITY_SERIALIZED_EXTENSIONS = new Set([
  ".anim",
  ".asset",
  ".controller",
  ".lighting",
  ".mat",
  ".meta",
  ".overridecontroller",
  ".physicmaterial",
  ".playable",
  ".rendertexture",
]);

const STRUCTURED_CONFIG_EXTENSIONS = new Set([
  ".config",
  ".csv",
  ".ini",
  ".json",
  ".toml",
  ".tsv",
  ".xls",
  ".xlsm",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml",
]);

export function createDefaultRiskPolicy(version = 1): RiskPolicy {
  return {
    version,
    rules: RISK_CATEGORIES.map((category) => ({
      kind: "category" as const,
      selector: category,
      level: DEFAULT_CATEGORY_LEVELS[category],
    })),
  };
}

export function evaluateRiskPolicy(
  inputPath: string,
  policy: RiskPolicy,
  blockingProtectionEnabled = true,
): RiskEvaluation {
  const path = normalizeRepositoryPath(inputPath);
  const category = classifyRiskCategory(path);
  const rules = normalizeRiskPolicyRules(policy.rules);
  const matchedRule = matchRule(path, category, rules)
    ?? { kind: "category", selector: category, level: DEFAULT_CATEGORY_LEVELS[category] };
  const configuredLevel = matchedRule.level;
  const level = blockingProtectionEnabled ? configuredLevel : "warning";
  const source = ruleDescription(matchedRule, category);
  return {
    path,
    category,
    level,
    configuredLevel,
    matchedRule,
    reason: blockingProtectionEnabled || configuredLevel === "warning"
      ? source
      : `${source} Critical-range blocking is disabled for this room, so the overlap is warning-only.`,
  };
}

export function normalizeRiskPolicyRules(rules: RiskPolicyRule[]): RiskPolicyRule[] {
  if (!Array.isArray(rules)) throw new Error("Risk policy rules must be an array.");
  const normalized: RiskPolicyRule[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule || !["category", "extension", "file", "directory"].includes(rule.kind)) {
      throw new Error("Risk policy rule kind is invalid.");
    }
    if (rule.level !== "warning" && rule.level !== "blocking") {
      throw new Error("Risk policy rule level must be warning or blocking.");
    }
    let selector = rule.selector?.trim();
    if (!selector) throw new Error("Risk policy rule selector is required.");
    if (rule.kind === "category") {
      selector = selector.toLocaleLowerCase("en-US");
      if (!RISK_CATEGORIES.includes(selector as RiskCategory)) {
        throw new Error(`Unknown risk category: ${selector}.`);
      }
    } else if (rule.kind === "extension") {
      selector = selector.toLocaleLowerCase("en-US");
      if (!selector.startsWith(".")) selector = `.${selector}`;
      if (!/^\.[a-z0-9][a-z0-9._-]{0,31}$/.test(selector)) {
        throw new Error(`Invalid file extension rule: ${selector}.`);
      }
    } else {
      selector = normalizeRepositoryPath(selector);
      if (rule.kind === "directory") selector = selector.replace(/\/$/, "");
    }
    const key = `${rule.kind}\0${selector.toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) throw new Error(`Duplicate risk policy rule: ${rule.kind} ${selector}.`);
    seen.add(key);
    normalized.push({ ...rule, selector });
  }
  return normalized;
}

export function classifyRiskCategory(inputPath: string): RiskCategory {
  const path = normalizeRepositoryPath(inputPath);
  const lower = path.toLocaleLowerCase("en-US");
  if (lower === ".") return "repository_scope";
  if (isLubanPath(lower)) return "luban";
  if (
    lower.startsWith("projectsettings/")
    || lower.startsWith("usersettings/")
    || lower === "packages/manifest.json"
    || lower === "packages/packages-lock.json"
  ) return "project_settings";
  if (
    lower.startsWith(".github/")
    || lower.startsWith(".gitlab/")
    || lower === ".gitlab-ci.yml"
    || lower === "dockerfile"
    || lower === "compose.yaml"
    || lower === "compose.yml"
  ) return "git_ci";
  const extension = fileExtension(lower);
  if (extension === ".unity" || extension === ".prefab") return "unity_scene_prefab";
  if (UNITY_SERIALIZED_EXTENSIONS.has(extension)) return "unity_serialized";
  if (STRUCTURED_CONFIG_EXTENSIONS.has(extension)) return "structured_config";
  if (/\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|kt|lua|m|mm|php|py|rb|rs|sh|swift|ts|tsx|vue)$/.test(lower)) {
    return "normal_source";
  }
  return "other";
}

function matchRule(
  path: string,
  category: RiskCategory,
  rules: RiskPolicyRule[],
): RiskPolicyRule | undefined {
  const key = path.toLocaleLowerCase("en-US");
  const exact = rules.find((rule) => rule.kind === "file" && rule.selector.toLocaleLowerCase("en-US") === key);
  if (exact) return exact;
  const directory = rules
    .filter((rule) => rule.kind === "directory" && pathScopeCovers(rule.selector, path))
    .sort((left, right) => right.selector.length - left.selector.length)[0];
  if (directory) return directory;
  const extension = fileExtension(key);
  const extensionRule = rules.find((rule) => rule.kind === "extension" && rule.selector === extension);
  if (extensionRule) return extensionRule;
  return rules.find((rule) => rule.kind === "category" && rule.selector === category);
}

function isLubanPath(path: string): boolean {
  return path.includes("luban")
    || /(?:^|\/)gen[_-]?luban(?:\.|\/|$)/.test(path)
    || /(?:^|\/)datas\/excel(?:\/|$)/.test(path);
}

function pathScopeCovers(scope: string, candidate: string): boolean {
  const normalizedScope = scope.toLocaleLowerCase("en-US").replace(/\/$/, "");
  const normalizedCandidate = candidate.toLocaleLowerCase("en-US").replace(/\/$/, "");
  return normalizedScope === "."
    || normalizedScope === normalizedCandidate
    || normalizedCandidate.startsWith(`${normalizedScope}/`);
}

function normalizeRepositoryPath(value: string): string {
  if (typeof value !== "string") throw new Error("Risk policy paths must be strings.");
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized === ".") return ".";
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Risk policy path must be repository-relative: ${value}.`);
  }
  return normalized.replace(/\/$/, "");
}

function fileExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index).toLocaleLowerCase("en-US") : "";
}

function ruleDescription(rule: RiskPolicyRule, category: RiskCategory): string {
  const result = rule.level === "blocking" ? "blocking" : "warning";
  if (rule.kind === "category") return `The ${category} category is configured as ${result}.`;
  return `The ${rule.kind} rule '${rule.selector}' is configured as ${result}.`;
}
