import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findGemini } from "../../src/config.js";
import { AcpFailure, parseFrame, splitLines, startAcp } from "../../src/gemini/acp.js";
import { unifiedDiff } from "../../src/gemini/diff.js";
import { promptBlocks } from "../../src/gemini/input.js";
import { geminiDisplayName, geminiModelId, isGeminiModel, listedModels, mapGeminiModel } from "../../src/gemini/models.js";
import { approvalRequest, geminiMode, permissionOutcome, unaskedDecision } from "../../src/gemini/permissions.js";
import { failureText, geminiSpawn } from "../../src/gemini/session.js";
import { otherProviderRequested, settingsFrom } from "../../src/gemini/thread.js";

const FAKE_GEMINI = fileURLToPath(new URL("../fixtures/fakeGemini.mjs", import.meta.url));

describe("ACP framing", () => {
  it("splits what was read into whole lines and the unfinished rest", () => {
    expect(splitLines("", '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
    expect(splitLines('{"b"', ':2}\n\n  \n')).toEqual({ lines: ['{"b":2}'], rest: "" });
  });

  it("tells responses, requests and notifications apart, and noise from all of them", () => {
    expect(parseFrame('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({ kind: "response", id: 1, result: { ok: true } });
    expect(parseFrame('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"no"}}')).toEqual({ kind: "response", id: 2, error: { code: -32000, message: "no" } });
    expect(parseFrame('{"jsonrpc":"2.0","id":"a-1","method":"session/request_permission","params":{"x":1}}')).toEqual({ kind: "request", id: "a-1", method: "session/request_permission", params: { x: 1 } });
    expect(parseFrame('{"jsonrpc":"2.0","method":"session/update"}')).toEqual({ kind: "notification", method: "session/update", params: {} });
    expect(parseFrame("Loaded cached credentials.").kind).toBe("noise");
    expect(parseFrame("42").kind).toBe("noise");
  });

  it("speaks with a real child: answers, errors with their code, and the end of the process", async () => {
    const exited = new Promise<string>((resolve) => {
      const acp = startAcp(geminiSpawn(FAKE_GEMINI, tmpdir(), { ...process.env, FAKE_GEMINI_HOME: undefined }), {
        onNotification: () => undefined, onRequest: async () => ({}), onExit: resolve,
      });
      void (async () => {
        expect((await acp.request("initialize", { protocolVersion: 1 })).protocolVersion).toBe(1);
        const failure = await acp.request("session/nope", {}).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AcpFailure);
        expect((failure as AcpFailure).code).toBe(-32601);
        const { sessionId } = await acp.request("session/new", { cwd: tmpdir(), mcpServers: [] });
        const dying = acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "crash" }] }).catch((error: Error) => error.message);
        expect(await dying).toMatch(/exited \(code 3\)/u);
        await expect(acp.request("initialize", {})).rejects.toThrow(/not running/u);
      })();
    });
    expect(await exited).toMatch(/exited \(code 3\)/u);
  });
});

describe("starting the Gemini CLI", () => {
  it("runs a node script on this process's Node, anything else as it is", () => {
    const script = geminiSpawn(FAKE_GEMINI, "/work", { PATH: "/bin", CCODEX_SHIM_ACTIVE: "1" });
    expect(script).toMatchObject({ command: process.execPath, args: [FAKE_GEMINI, "--acp"], cwd: "/work", env: { PATH: "/bin" } });
    expect(script.env).not.toHaveProperty("CCODEX_SHIM_ACTIVE");
    expect(geminiSpawn("gemini", "/work", {})).toMatchObject({ command: "gemini", args: ["--acp"] });
  });

  it("finds the configured CLI, else the first on PATH", () => {
    const bin = mkdtempSync(join(tmpdir(), "ccodex-gemini-bin-"));
    writeFileSync(join(bin, "gemini"), "#!/bin/sh\n");
    expect(findGemini({ geminiBinary: "/opt/custom/gemini" }, bin)).toBe("/opt/custom/gemini");
    expect(findGemini({}, `/nowhere:${bin}`)).toBe(join(bin, "gemini"));
  });

  it("says in words why a turn failed", () => {
    expect(failureText(new AcpFailure(-32000, "Authentication required."))).toMatch(/not signed in.*ccodex auth gemini.*Authentication required/u);
    expect(failureText(new Error("could not start gemini: spawn gemini ENOENT"))).toMatch(/npm i -g @google\/gemini-cli/u);
    expect(failureText(new Error("quota exhausted"))).toBe("Gemini: quota exhausted");
  });
});

describe("Gemini models in the picker", () => {
  it("lists a model as stock lists one, named as Gemini's", () => {
    expect(mapGeminiModel({ modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }, "gemini:")).toMatchObject({
      id: "gemini:gemini-2.5-pro", model: "gemini:gemini-2.5-pro", displayName: "Gemini 2.5 Pro", hidden: false, supportedReasoningEfforts: [], isDefault: false,
    });
    expect(geminiDisplayName({ modelId: "auto", name: "Auto" })).toBe("Gemini (auto)");
    expect(geminiDisplayName({ modelId: "gemini-3-flash-preview" })).toBe("Gemini 3 Flash Preview");
    expect(geminiDisplayName({ modelId: "x", name: "Flash" })).toBe("Gemini Flash");
  });

  it("lists the CLI's own models once known, without repeats, auto always among them", () => {
    expect(listedModels(undefined).map((model) => model.modelId)).toEqual(["auto", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);
    expect(listedModels([{ modelId: "gemini-3-pro-preview" }, { modelId: "gemini-3-pro-preview" }]).map((model) => model.modelId)).toEqual(["auto", "gemini-3-pro-preview"]);
  });

  it("tells its models by their prefix", () => {
    expect(isGeminiModel("gemini:auto", "gemini:")).toBe(true);
    expect(isGeminiModel("claude:opus", "gemini:")).toBe(false);
    expect(isGeminiModel(null, "gemini:")).toBe(false);
    expect(geminiModelId("gemini:gemini-2.5-pro", "gemini:")).toBe("gemini-2.5-pro");
  });
});

describe("the App's permissions as Gemini's approval modes", () => {
  it("maps each App control to a mode, and to the default one where the CLI offers no such mode", () => {
    expect(geminiMode({ permissionMode: "bypassPermissions", plan: false })).toBe("yolo");
    expect(geminiMode({ permissionMode: "auto", plan: false })).toBe("autoEdit");
    expect(geminiMode({ permissionMode: "default", plan: false })).toBe("default");
    expect(geminiMode({ permissionMode: "dontAsk", plan: false })).toBe("default");
    expect(geminiMode({ permissionMode: "bypassPermissions", plan: true })).toBe("plan");
    expect(geminiMode({ permissionMode: "bypassPermissions", plan: true }, ["default", "autoEdit", "yolo"])).toBe("yolo");
    expect(geminiMode({ permissionMode: "bypassPermissions", plan: false }, ["default"])).toBe("default");
  });

  it("answers the CLI's permission prompt with the option the App's decision means", () => {
    const options = [
      { optionId: "proceed_always", kind: "allow_always" }, { optionId: "proceed_once", kind: "allow_once" }, { optionId: "cancel", kind: "reject_once" },
    ];
    expect(permissionOutcome("accept", options)).toEqual({ outcome: "selected", optionId: "proceed_once" });
    expect(permissionOutcome("acceptForSession", options)).toEqual({ outcome: "selected", optionId: "proceed_always" });
    expect(permissionOutcome({ acceptWithExecpolicyAmendment: {} }, options)).toEqual({ outcome: "selected", optionId: "proceed_always" });
    expect(permissionOutcome("decline", options)).toEqual({ outcome: "selected", optionId: "cancel" });
    expect(permissionOutcome("cancel", options)).toEqual({ outcome: "cancelled" });
    // No session-wide option offered: once.
    expect(permissionOutcome("acceptForSession", options.slice(1))).toEqual({ outcome: "selected", optionId: "proceed_once" });
    expect(permissionOutcome("accept", [])).toEqual({ outcome: "cancelled" });
  });

  it("decides without asking only where the chat's permissions say so", () => {
    expect(unaskedDecision("dontAsk")).toBe("decline");
    expect(unaskedDecision("bypassPermissions")).toBe("accept");
    expect(unaskedDecision("default")).toBeUndefined();
    expect(unaskedDecision("auto")).toBeUndefined();
  });

  it("asks about a file change on its item, about anything else as a command", () => {
    const context = { threadId: "t", turnId: "turn", itemId: "i", cwd: "/work", title: "Edit a.ts", startedAtMs: 5 };
    expect(approvalRequest({ type: "fileChange", id: "i", changes: [], status: "inProgress" }, context)).toEqual({
      method: "item/fileChange/requestApproval", params: { threadId: "t", turnId: "turn", itemId: "i", startedAtMs: 5, reason: "Edit a.ts", grantRoot: null },
    });
    const command = approvalRequest(undefined, { ...context, title: "rm -rf build" });
    expect(command.method).toBe("item/commandExecution/requestApproval");
    expect(command.params).toMatchObject({ command: "rm -rf build", cwd: "/work", commandActions: [{ type: "unknown", command: "rm -rf build" }], availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] });
  });

  it("takes a chat's settings from a request, and knows another provider's model", () => {
    const current = { cwd: "/work", model: "auto", permissionMode: "default" as const, plan: false };
    expect(settingsFrom({ model: "gemini:gemini-2.5-pro", cwd: "/other", approvalPolicy: "never", sandbox: "danger-full-access" }, current, "gemini:"))
      .toEqual({ cwd: "/other", model: "gemini-2.5-pro", permissionMode: "bypassPermissions", plan: false });
    expect(settingsFrom({ collaborationMode: { mode: "plan", settings: { model: "gemini:auto" } } }, current, "gemini:")).toEqual({ ...current, plan: true });
    expect(settingsFrom({}, current, "gemini:")).toEqual(current);
    expect(otherProviderRequested({ model: "gpt-6" }, "gemini:")).toBe(true);
    expect(otherProviderRequested({ collaborationMode: { settings: { model: "claude:opus" } } }, "gemini:")).toBe(true);
    expect(otherProviderRequested({ model: "gemini:auto" }, "gemini:")).toBe(false);
    expect(otherProviderRequested({}, "gemini:")).toBe(false);
  });
});

describe("a file's old and new text as a unified diff", () => {
  it("shows a change with its context and line numbers", () => {
    const before = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 5", "LINE FIVE");
    expect(unifiedDiff(`${before}\n`, `${after}\n`)).toBe("@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-line 5\n+LINE FIVE\n line 6\n line 7\n line 8");
  });

  it("gives far-apart changes hunks of their own, near ones a shared hunk", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `l${index + 1}`);
    const far = lines.map((line, index) => index === 1 || index === 25 ? `${line}!` : line);
    expect(unifiedDiff(lines.join("\n"), far.join("\n")).match(/^@@/gmu)).toHaveLength(2);
    const near = lines.map((line, index) => index === 10 || index === 13 ? `${line}!` : line);
    expect(unifiedDiff(lines.join("\n"), near.join("\n")).match(/^@@/gmu)).toHaveLength(1);
  });

  it("handles additions, removals, and no change", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\nc\n")).toBe("@@ -1,2 +1,3 @@\n a\n b\n+c");
    expect(unifiedDiff("a\nb\nc\n", "a\nc\n")).toBe("@@ -1,3 +1,2 @@\n a\n-b\n c");
    expect(unifiedDiff("", "new\n")).toBe("@@ -0,0 +1,1 @@\n+new");
    expect(unifiedDiff("same\n", "same\n")).toBe("");
  });
});

describe("the App's input as an ACP prompt", () => {
  it("puts the context before the message, files as links the CLI reads, images inline", async () => {
    const read = async (path: string) => Buffer.from(`bytes of ${path}`);
    const blocks = await promptBlocks([
      { type: "text", text: "look at this" },
      { type: "mention", name: "a.ts", path: "src/a.ts" },
      { type: "image", url: "data:image/PNG;base64,QUJD\n" },
      { type: "image", url: "https://example.com/x.png" },
      { type: "localImage", path: "shot.jpg" },
      { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
    ], "/work", ["earlier", ""], read);
    expect(blocks).toEqual([
      { type: "text", text: "earlier" },
      { type: "text", text: "look at this" },
      { type: "resource_link", uri: "file:///work/src/a.ts", name: "a.ts" },
      { type: "image", mimeType: "image/png", data: "QUJD" },
      { type: "resource_link", uri: "https://example.com/x.png", name: "image" },
      { type: "image", mimeType: "image/jpeg", data: Buffer.from("bytes of /work/shot.jpg").toString("base64") },
      { type: "text", text: "$review (/skills/review/SKILL.md)" },
    ]);
  });

  it("refuses what the CLI can't take", async () => {
    await expect(promptBlocks([{ type: "localImage", path: "a.bmp" }], "/work")).rejects.toThrow(/Unsupported image type/u);
    await expect(promptBlocks([{ type: "audio", url: "x" }], "/work")).rejects.toThrow(/Audio input/u);
  });
});
