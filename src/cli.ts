#!/usr/bin/env node
/**
 * AXOVB CLI — Axo Version Bumper.
 *
 * Uses a small specialized ONNX model (<200M params) loaded locally.
 * No API calls, no LM Studio, no Ollama. Pure embedded inference.
 *
 * Usage:
 *   axovb check                    Check if a version bump is needed
 *   axovb bump                     Bump the version automatically
 *   axovb hook install             Install as a git pre-push hook
 *   axovb --version                Print version
 *   axovb --help                   Show help
 *
 * The model downloads on first run (~250MB, cached at ~/.axovb/models/).
 * To use a custom fine-tuned model:
 *   axovb check --model-path /path/to/my-finetuned-onnx
 *   Or: AXOVB_MODEL_PATH=/path/to/model axovb check
 *
 * Subscription: $0.90/mo with 1 month free tier.
 */

import process from "node:process";
import { AXOVB_VERSION, AXOVB_VERSION_SEMVER } from "./version.js";
import { checkBumpNeeded, performBump, type BumpOptions } from "./bumper.js";

const HELP = `
  AXOVB  ${AXOVB_VERSION}  — Axo Version Bumper

  Uses a sub-200M param specialized ONNX model. No API calls.
  Model runs locally on CPU in ~10-50ms per inference.

  USAGE
    axovb check                    Check if a version bump is needed
    axovb bump                     Bump the version automatically
    axovb hook install             Install as a git pre-push hook
    axovb hook remove              Remove the git pre-push hook
    axovb --version                Print version
    axovb --help                   Show this help

  MODEL
    Default: Xenova/distilbert-base-uncased (66M params)
    Cache:   ~/.axovb/models/
    Custom:  --model-path /path/to/fine-tuned-onnx
             or AXOVB_MODEL_PATH env var

    The default model is a PLACEHOLDER. For production accuracy,
    fine-tune on 10K+ git diffs → {patch|minor|major|none} labels.

  SUBSCRIPTION
    $0.90/mo with 1 month free tier.
    Set AXOVB_LICENSE_KEY env var to activate.

  FRAZIYM VERSIONING
    Supports both semver (0.1.0) and FRAZIYM (V00.01.000) formats.
`;

function parseOpts(args: string[]): BumpOptions {
  const opts: BumpOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model-path" && args[i + 1]) opts.modelPath = args[++i];
    if (args[i] === "--confidence" && args[i + 1]) opts.confidenceThreshold = parseFloat(args[++i]);
  }
  return opts;
}

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
      const result = await checkBumpNeeded(process.cwd(), parseOpts(args));
      if (result.needed) {
        console.log(`\n  [!] Version bump needed: ${result.reason}`);
        console.log(`      Current:   ${result.currentVersion}`);
        console.log(`      Suggested: ${result.suggestedVersion}`);
        console.log(`      Bump type: ${result.bumpType}`);
        console.log(`      Confidence: ${(result.confidence * 100).toFixed(0)}%\n`);
        process.exitCode = 1;
      } else {
        console.log(`\n  [+] Version is up to date (${result.currentVersion})\n`);
      }
      break;
    }
    case "bump": {
      const result = await checkBumpNeeded(process.cwd(), parseOpts(args));
      if (!result.needed) {
        console.log(`\n  [+] No bump needed. Current: ${result.currentVersion}\n`);
        return;
      }
      const bumped = await performBump(process.cwd(), result);
      if (bumped) {
        console.log(`\n  [+] Bumped ${result.currentVersion} → ${result.suggestedVersion}`);
        console.log(`      (${result.bumpType}, ${(result.confidence * 100).toFixed(0)}% confidence)\n`);
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
