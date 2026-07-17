#!/usr/bin/env node
// Registers every extension package in this monorepo with Pi's global settings
// so they are auto-discovered (loaded via jiti from their TypeScript source).
//
//   pnpm setup
//
// Safe to re-run: it only adds missing package directory paths to the
// `extensions` array and never touches other settings keys.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packagesDir = join(repoRoot, "packages");
const settingsPath = join(homedir(), ".pi", "agent", "settings.json");

function discoverPackageDirs() {
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir)
    .map((name) => join(packagesDir, name))
    .filter((full) => statSync(full).isDirectory());
}

function main() {
  const dirs = discoverPackageDirs();
  if (dirs.length === 0) {
    console.log(`No packages found in ${packagesDir}`);
    return;
  }

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (err) {
      console.error(`Failed to parse ${settingsPath}: ${err.message}`);
      process.exit(1);
    }
  }

  const existing = Array.isArray(settings.extensions) ? settings.extensions : [];
  const toAdd = dirs.filter((d) => !existing.includes(d));
  settings.extensions = [...existing, ...toAdd];

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  console.log(`Registered ${dirs.length} extension package(s) in ${settingsPath}`);
  if (toAdd.length > 0) {
    console.log("Added:");
    for (const d of toAdd) console.log(`  ${d}`);
  } else {
    console.log("All packages already registered.");
  }
  console.log("Reload Pi (/reload) to pick up changes.");
}

main();
