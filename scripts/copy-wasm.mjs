import { copyFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(root, "node_modules/sshclient-wasm/dist");
const publicDir = resolve(root, "public");
const files = ["sshclient.wasm", "wasm_exec.js"];

await mkdir(publicDir, { recursive: true });

for (const file of files) {
  const source = resolve(sourceDir, file);
  try {
    await access(source, constants.R_OK);
  } catch {
    throw new Error(
      `Missing ${source}. Run pnpm install first; sshclient-wasm must provide dist/${file}.`
    );
  }
  await copyFile(source, resolve(publicDir, file));
}

console.log("Copied sshclient-wasm runtime assets into public/.");
