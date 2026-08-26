import { describe, expect, it } from "vitest";
import {
  classifyRiskCategory,
  createDefaultRiskPolicy,
  evaluateRiskPolicy,
  normalizeRiskPolicyRules,
  type RiskPolicy,
} from "./risk-policy.js";

describe("room risk policy", () => {
  it("uses safe defaults and keeps every Luban scope warning-only", () => {
    const policy = createDefaultRiskPolicy();
    expect(evaluateRiskPolicy("Assets/Vanguard/Inventory/Bag.cs", policy)).toMatchObject({
      category: "normal_source",
      level: "warning",
    });
    expect(evaluateRiskPolicy("Assets/Scenes/Raid.unity", policy)).toMatchObject({
      category: "unity_scene_prefab",
      level: "blocking",
    });
    expect(evaluateRiskPolicy("Config/Luban/TbItem.xlsx", policy)).toMatchObject({
      category: "luban",
      level: "warning",
    });
    expect(evaluateRiskPolicy("Assets/Generated/Luban/tbitem.json", policy)).toMatchObject({
      category: "luban",
      level: "warning",
    });
  });

  it("lets the owner policy change Luban to blocking", () => {
    const policy = createDefaultRiskPolicy();
    policy.rules = policy.rules.map((rule) =>
      rule.kind === "category" && rule.selector === "luban"
        ? { ...rule, level: "blocking" }
        : rule);
    expect(evaluateRiskPolicy("Config/Luban/TbItem.xlsx", policy).level).toBe("blocking");
  });

  it("matches file, longest directory, extension, then category", () => {
    const policy: RiskPolicy = {
      version: 7,
      rules: [
        ...createDefaultRiskPolicy().rules,
        { kind: "extension", selector: ".cs", level: "blocking" },
        { kind: "directory", selector: "Assets/Vanguard", level: "blocking" },
        { kind: "directory", selector: "Assets/Vanguard/Inventory", level: "warning" },
        { kind: "file", selector: "Assets/Vanguard/Inventory/Critical.cs", level: "blocking" },
      ],
    };
    expect(evaluateRiskPolicy("Assets/Other/Service.cs", policy).matchedRule.kind).toBe("extension");
    expect(evaluateRiskPolicy("Assets/Vanguard/Combat/Weapon.cs", policy).matchedRule).toMatchObject({
      kind: "directory",
      selector: "Assets/Vanguard",
    });
    expect(evaluateRiskPolicy("Assets/Vanguard/Inventory/Bag.cs", policy).matchedRule).toMatchObject({
      kind: "directory",
      selector: "Assets/Vanguard/Inventory",
    });
    expect(evaluateRiskPolicy("Assets/Vanguard/Inventory/Critical.cs", policy).matchedRule.kind).toBe("file");
  });

  it("downgrades automatic and ordinary overlap when blocking protection is off", () => {
    const result = evaluateRiskPolicy("ProjectSettings/ProjectSettings.asset", createDefaultRiskPolicy(), false);
    expect(result).toMatchObject({ configuredLevel: "blocking", level: "warning" });
    expect(result.reason).toContain("disabled");
  });

  it("rejects duplicate and unsafe custom rules", () => {
    expect(() => normalizeRiskPolicyRules([
      { kind: "extension", selector: "cs", level: "warning" },
      { kind: "extension", selector: ".CS", level: "blocking" },
    ])).toThrow(/Duplicate/);
    expect(() => normalizeRiskPolicyRules([
      { kind: "directory", selector: "../outside", level: "blocking" },
    ])).toThrow(/repository-relative/);
  });

  it("classifies common project control paths", () => {
    expect(classifyRiskCategory("ProjectSettings/TagManager.asset")).toBe("project_settings");
    expect(classifyRiskCategory(".github/workflows/ci.yml")).toBe("git_ci");
    expect(classifyRiskCategory("config/runtime.json")).toBe("structured_config");
    expect(classifyRiskCategory("README.md")).toBe("other");
  });
});
