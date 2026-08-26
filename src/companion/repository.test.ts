import { describe, expect, it } from "vitest";
import {
  analyzeCSharpSource,
  deriveImpactedSystems,
  inferSystemId,
  resolveAsarUnpackedPath,
  type DependencyEdge,
} from "./repository.js";

describe("repository analysis", () => {
  it("maps Electron virtual asar parser paths to physical unpacked files", () => {
    expect(resolveAsarUnpackedPath(
      "C:\\Program Files\\Agent Hub\\resources\\app.asar\\node_modules\\parser.so",
    )).toBe(
      "C:\\Program Files\\Agent Hub\\resources\\app.asar.unpacked\\node_modules\\parser.so",
    );
    expect(resolveAsarUnpackedPath("C:\\repo\\node_modules\\parser.so")).toBe(
      "C:\\repo\\node_modules\\parser.so",
    );
  });

  it("groups Unity files into stable module scopes", () => {
    expect(inferSystemId("Assets/Vanguard/Inventory/Runtime/Bag.cs")).toBe(
      "Assets/Vanguard/Inventory",
    );
    expect(inferSystemId("Packages/com.example.tool/Runtime/Tool.cs")).toBe(
      "Packages/com.example.tool",
    );
  });

  it("extracts C# namespaces, dependencies, declarations, and public contracts", () => {
    const summary = analyzeCSharpSource(
      "Assets/Vanguard/Inventory/Bag.cs",
      `
        using Vanguard.Items;
        using Vanguard.Shared.Events;
        namespace Vanguard.Inventory;
        public sealed class Bag : IBag
        {
          public void Add(Item item) { }
          protected int Count { get; }
          private void Reindex() { }
        }
      `,
    );

    expect(summary.namespace).toBe("Vanguard.Inventory");
    expect(summary.imports).toEqual(["Vanguard.Items", "Vanguard.Shared.Events"]);
    expect(summary.declarations).toContain("Vanguard.Inventory.Bag");
    expect(summary.publicContracts).toContain("Add");
    expect(summary.publicContracts).toContain("Count");
    expect(summary.publicContracts).not.toContain("Reindex");
  });

  it("marks reverse dependencies as impacted", () => {
    const dependencies: DependencyEdge[] = [
      {
        fromSystemId: "Assets/Vanguard/Quest",
        toSystemId: "Assets/Vanguard/Inventory",
        kind: "code",
        confidence: 0.8,
        evidenceCount: 2,
      },
    ];

    expect(
      deriveImpactedSystems(["Assets/Vanguard/Inventory/Bag.cs"], dependencies),
    ).toEqual(["Assets/Vanguard/Inventory", "Assets/Vanguard/Quest"]);
  });
});
