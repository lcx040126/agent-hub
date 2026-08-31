import { describe, expect, it } from "vitest";
import {
  candidateGitPaths,
  formatGitExecutionError,
  GitExecutableUnavailableError,
  resolveGitExecutable,
} from "./git-executable.js";

describe("Git executable discovery", () => {
  it("uses an explicit executable before PATH", () => {
    const explicit = "C:\\custom\\git.exe";
    expect(resolveGitExecutable(explicit, {
      platform: "win32",
      env: { PATH: "C:\\path-git" },
      isFile: (candidate) => candidate === explicit,
    })).toBe(explicit);
  });

  it("uses PATH before standard installation directories", () => {
    const candidates = candidateGitPaths("win32", {
      PATH: "C:\\path-git",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\member\\AppData\\Local",
    }, "C:\\Users\\member", undefined,
      () => [
        { name: "app-5.52.3", isDirectory: () => true } as never,
      ]);
    expect(candidates[0]).toBe("C:\\path-git\\git.exe");
    expect(candidates).toContain("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(candidates).toContain("C:\\Users\\member\\AppData\\Local\\UGit\\app-5.52.3\\resources\\app\\git\\cmd\\git.exe");
  });

  it("selects the newest available UGit bundled Git", () => {
    const selected = resolveGitExecutable(undefined, {
      platform: "win32",
      env: {
        PATH: "",
        LOCALAPPDATA: "C:\\Users\\member\\AppData\\Local",
      },
      homeDirectory: "C:\\Users\\member",
      readDirectories: () => [
        { name: "app-5.52.3", isDirectory: () => true } as never,
        { name: "app-5.51.0", isDirectory: () => true } as never,
      ],
      isFile: (candidate) => candidate.endsWith("app-5.52.3\\resources\\app\\git\\cmd\\git.exe"),
    });
    expect(selected).toContain("UGit\\app-5.52.3\\resources\\app\\git\\cmd\\git.exe");
  });

  it("reports actionable diagnostics when no Git candidate is available", () => {
    expect(() => resolveGitExecutable(undefined, {
      platform: "win32",
      env: { PATH: "", LOCALAPPDATA: "C:\\missing" },
      homeDirectory: "C:\\Users\\member",
      isFile: () => false,
    })).toThrow(GitExecutableUnavailableError);
    try {
      resolveGitExecutable(undefined, {
        platform: "win32",
        env: { PATH: "", LOCALAPPDATA: "C:\\missing" },
        homeDirectory: "C:\\Users\\member",
        isFile: () => false,
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "AGENT_HUB_GIT_UNAVAILABLE" });
      expect((error as GitExecutableUnavailableError).message).toContain("安装 Git for Windows");
      expect((error as GitExecutableUnavailableError).candidates.length).toBeGreaterThan(0);
    }
  });

  it("does not add standard Windows paths on non-Windows platforms", () => {
    const candidates = candidateGitPaths("linux", { PATH: "/usr/bin" }, "/home/member");
    expect(candidates).toEqual(["/usr/bin/git"]);
  });

  it("distinguishes missing Git from execution permission failures", () => {
    expect(formatGitExecutionError({ code: "ENOENT" }, "C:\\Git\\git.exe")).toContain("无法启动 Git");
    expect(formatGitExecutionError({ code: "EACCES" }, "C:\\Git\\git.exe")).toContain("没有权限");
  });
});
