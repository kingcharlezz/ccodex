// The App's user input as an ACP prompt (content blocks). Reading a local image is the only IO, and it is passed in.
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { invalidParams, type JsonObject, type UserInput } from "../protocol/codex.js";

const MEDIA_TYPES: Readonly<Record<string, string>> = { ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const DATA_IMAGE = /^data:(image\/[a-z+.-]+);base64,([\s\S]*)$/iu;

export type ReadFile = (path: string) => Promise<Buffer>;

/** `context`: what the model reads before the user's message (the chat so far for a new session, injected items). */
export async function promptBlocks(input: readonly UserInput[], cwd: string, context: readonly string[] = [], read: ReadFile = readFile): Promise<JsonObject[]> {
  const blocks: JsonObject[] = context.filter(Boolean).map((text) => ({ type: "text", text }));
  for (const item of input) {
    if (item.type === "text") blocks.push({ type: "text", text: item.text });
    // A file the user mentions: the CLI reads it, as for `@path` in its own prompt.
    else if (item.type === "mention") blocks.push({ type: "resource_link", uri: pathToFileURL(isAbsolute(item.path) ? item.path : resolve(cwd, item.path)).href, name: item.name });
    else if (item.type === "skill") blocks.push({ type: "text", text: `$${item.name} (${item.path})` });
    else if (item.type === "image") {
      const inline = DATA_IMAGE.exec(item.url);
      blocks.push(inline ? { type: "image", mimeType: inline[1]!.toLowerCase(), data: inline[2]!.replace(/\s+/gu, "") } : { type: "resource_link", uri: item.url, name: "image" });
    } else if (item.type === "localImage") {
      const path = isAbsolute(item.path) ? item.path : resolve(cwd, item.path);
      const mimeType = MEDIA_TYPES[extname(path).toLowerCase()];
      if (!mimeType) throw invalidParams(`Unsupported image type for '${item.path}'.`);
      blocks.push({ type: "image", mimeType, data: (await read(path)).toString("base64") });
    } else {
      throw invalidParams("Audio input is not supported in Gemini threads.");
    }
  }
  return blocks;
}
