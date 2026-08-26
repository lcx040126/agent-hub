import { describe, expect, it, vi } from "vitest";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";

describe("AgentHubClient", () => {
  it("sends the member token only in the Authorization header", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:4173/api/snapshot");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-member-token");
      expect(String(input)).not.toContain("secret-member-token");
      return new Response(JSON.stringify({ room: { name: "Test" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173/",
      memberToken: "secret-member-token",
      fetchImpl,
    });

    await expect(client.get("/api/snapshot")).resolves.toEqual({ room: { name: "Test" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves structured HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: "lease_conflict",
      message: "The path is occupied.",
      details: { path: "Assets/Main.unity" },
    }), { status: 409 })) as typeof fetch;
    const client = new AgentHubClient({
      serverUrl: "https://hub.example.test",
      memberToken: "token",
      fetchImpl,
    });

    const error = await client.post("/api/leases", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentHubHttpError);
    expect(error).toMatchObject({
      status: 409,
      code: "lease_conflict",
      message: "The path is occupied.",
      details: { path: "Assets/Main.unity" },
    });
  });
});
