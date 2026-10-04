#!/usr/bin/env node
/**
 * AXOVB CLI — Axo Version Bumper.
 *
 * Detects forgotten version bumps and does them automatically.
 *
 * Usage:
 *   axovb check          Check if a version bump is needed (dry run)
 *   axovb bump           Bump the version automatically if needed
 *   axovb hook install   Install as a git pre-push hook
 *   axovb --version      Print version
 *   axovb --help         Show help
 *
 * Works with any coding agent (Claude, Codex, Cursor, AXONIZ, etc.) —
 * just run `axovb check` after the agent finishes, or install as a
 * git hook so it runs automatically on every push.
 *
 * Subscription: $0.90/mo with 1 month free tier.
 * Set AXOVB_LICENSE_KEY to activate.
 */

import process from "node:process";
import { AXOVB_VERSION, AXOVB_VERSION_SEMVER } from "./version.js";
import { checkBumpNeeded, performBump } from "./bumper.js";

const HELP = `
  AXOVB  ${AXOVB_VERSION}  — Axo Version Bumper

  Detects forgotten version bumps and does them automatically.
  Works with any coding agent (Claude, Codex, Cursor, AXONIZ, etc.).

  USAGE
    axovb check          Check if a version bump is needed (dry run)
    axovb bump           Bump the version automatically if needed
    axovb hook install   Install as a git pre-push hook
    axovb hook remove    Remove the git pre-push hook
    axovb --version      Print version
    axovb --help         Show this help

  SUBSCRIPTION
    $0.90/mo with 1 month free tier.
    Set AXOVB_LICENSE_KEY env var to activate.
    Without a key, runs in free-tier mode (limited to 10 checks/day).

  FRAZIYM VERSIONING
    Supports both semver (0.1.0) and FRAZIYM (V00.01.000) formats.
    Detects the format from the existing version string and bumps
    accordingly.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "--version" || cmd === "-v") {
    console.log(`axovb ${AXOVB_VERSION}  (npm: ${AXOVB_VERSION_SEMVER})`);
    return;
  }

  if (cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "check": {
      const result = await checkBumpNeeded(process.cwd());
      if (result.needed) {
        console.log(`\n  [!] Version bump needed: ${result.reason}`);
        console.log(`      Current: ${result.currentVersion}`);
        console.log(`      Suggested: ${result.suggestedVersion}`);
        console.log(`      Bump type: ${result.bumpType}\n`);
        process.exitCode = 1; // Non-zero so CI can detect
      } else {
        console.log(`\n  [+] Version is up to date (${result.currentVersion})\n`);
      }
      break;
    }
    case "bump": {
      const result = await checkBumpNeeded(process.cwd());
      if (!result.needed) {
        console.log(`\n  [+] No bump needed. Current: ${result.currentVersion}\n`);
        return;
      }
      const bumped = await performBump(process.cwd(), result);
      if (bumped) {
        console.log(`\n  [+] Bumped ${result.currentVersion} → ${result.suggestedVersion}`);
        console.log(`      (${result.bumpType}: ${result.reason})\n`);
      } else {
        console.log(`\n  [-] Could not perform bump automatically.\n`);
        process.exitCode = 1;
      }
      break;
    }
    case "hook": {
      const action = args[1];
      if (action === "install") {
        const { installHook } = await import("./hook.js");
        installHook();
      } else if (action === "remove") {
        const { removeHook } = await import("./hook.js");
        removeHook();
      } else {
        console.log("Usage: axovb hook install|remove");
        process.exitCode = 1;
      }
      break;
    }
    default:
      console.log(HELP);
      break;
  }
}

void main();
