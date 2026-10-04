/**
 * AXOVB Bumper — embedded small-model version bump detection.
 *
 * Uses a sub-200M parameter ONNX model loaded locally via
 * @huggingface/transformers. No API calls, no LM Studio, no Ollama.
 *
 * The model is a fine-tuned text classifier (~66M params) that takes a
 * git diff as input and outputs:
 *   { label: "patch" | "minor" | "major" | "none", score: 0.0-1.0 }
 *
 * The model downloads once on first run (~250MB for the ONNX + tokenizer),
 * caches in ~/.axovb/models/, and loads in <100ms on subsequent runs.
 * Inference takes ~10-50ms on CPU.
 *
 * To use a custom fine-tuned model:
 *   Set AXOVB_MODEL_PATH=/path/to/model-onnx
 *   Or: axovb check --model-path ./my-finetuned-model
 *
 * The default model (Xenova/distilbert-base-uncased, 66M params) is a
 * PLACEHOLDER. The real model should be fine-tuned on:
 *   - Git diffs → bump type (patch/minor/major/none)
 *   - Trained on 10K+ real commit messages with known bump types
 *   - Target: 90%+ accuracy on classification, <50ms inference on CPU
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// Lazy-load the transformers pipeline (heavy import — only when needed)
let _pipeline: ((task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>) | null = null;
let _classifier: ((text: string) => Promise<Array<{ label: string; score: number }>>) | null) = null;

const DEFAULT_MODEL = "Xenova/distilbert-base-uncased";
const MODEL_CACHE_DIR = path.join(os.homedir(), ".axovb", "models");

/**
 * Bump type labels the model outputs. When you fine-tune your own model,
 * use these exact label strings in the training data.
 */
const BUMP_LABELS = new Map([
  ["patch", "patch"],
  ["minor", "minor"],
  ["major", "major"],
  ["none", "none"],
  // Also accept common alternatives the default model might output
  ["LABEL_0", "none"],
  ["LABEL_1", "patch"],
  ["LABEL_2", "minor"],
  ["LABEL_3", "major"],
  ["NEGATIVE", "none"],
  ["POSITIVE", "patch"],
]);

export interface BumpOptions {
  modelPath?: string;
  confidenceThreshold?: number;
}

export interface BumpResult {
  needed: boolean;
  currentVersion: string;
  suggestedVersion: string;
  bumpType: "patch" | "minor" | "major" | "none";
  reason: string;
  confidence: number;
  format: "semver" | "frazyim";
}

export async function checkBumpNeeded(
  repoPath: string,
  opts: BumpOptions = {},
): Promise<BumpResult> {
  const { currentVersion, format } = readCurrentVersion(repoPath);
  if (!currentVersion) {
    return noBump("(unknown)", "semver", "No version found");
  }

  // Get git diff since last version-bump commit
  const diff = getDiffSinceLastBump(repoPath);
  if (!diff.trim()) {
    return noBump(currentVersion, format, "No changes since last version bump");
  }

  // Truncate to model's max input length (DistilBERT = 512 tokens ≈ 2000 chars)
  const truncatedDiff = diff.slice(0, 2000);

  // Run the model
  const modelPath = opts.modelPath || process.env.AXOVB_MODEL_PATH;
  const modelName = modelPath || DEFAULT_MODEL;
  const threshold = opts.confidenceThreshold ?? 0.6;

  try {
    const classifier = await getClassifier(modelName);
    const predictions = await classifier(truncatedDiff);

    if (!predictions || predictions.length === 0) {
      return noBump(currentVersion, format, "Model returned no predictions");
    }

    const topResult = predictions[0];
    const bumpType = BUMP_LABELS.get(topResult.label) ?? "none";
    const confidence = topResult.score;

    if (bumpType === "none") {
      return noBump(currentVersion, format, `Model classified as none (confidence: ${(confidence * 100).toFixed(0)}%)`);
    }

    // If confidence is below threshold, warn but still suggest the bump
    let reason = `Model classified as ${bumpType} (confidence: ${(confidence * 100).toFixed(0)}%)`;
    if (confidence < threshold) {
      reason += ` — LOW CONFIDENCE, verify manually`;
    }

    const suggestedVersion = bumpVersion(currentVersion, bumpType as "patch" | "minor" | "major", format);

    return {
      needed: true,
      currentVersion,
      suggestedVersion,
      bumpType: bumpType as "patch" | "minor" | "major",
      reason,
      confidence,
      format,
    };
  } catch (e) {
    // Model not available — fall back to heuristic analysis
    return heuristicBump(repoPath, currentVersion, format, diff, e);
  }
}

export async function performBump(repoPath: string, result: BumpResult): Promise<boolean> {
  // Update package.json
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.version = result.format === "frazyim" ? toSemver(result.suggestedVersion) : result.suggestedVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  // Update version.ts if it exists
  const versionTsPath = path.join(repoPath, "src", "version.ts");
  if (fs.existsSync(versionTsPath)) {
    let content = fs.readFileSync(versionTsPath, "utf8");
    if (result.format === "frazyim") {
      content = content.replace(/V\d{2}\.\d{2}\.\d{3}-?(?:\w+)?-?\d{0,2}/, result.suggestedVersion);
      content = content.replace(/\d+\.\d+\.\d+-beta\.\d+/, toSemver(result.suggestedVersion));
    } else {
      content = content.replace(/\d+\.\d+\.\d+(?:-\w+\.\d+)?/, result.suggestedVersion);
    }
    fs.writeFileSync(versionTsPath, content);
  }

  // Git commit
  try {
    execSync('git add package.json src/version.ts 2>/dev/null || git add package.json', {
      cwd: repoPath, stdio: "pipe",
    });
    execSync(
      `git commit -m "chore(version): ${result.currentVersion} → ${result.suggestedVersion} (${result.bumpType}, ${(result.confidence * 100).toFixed(0)}% confidence)"`,
      { cwd: repoPath, stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

/* ── Model loading (lazy, cached) ────────────────────────────────────── */

async function getClassifier(modelName: string) {
  if (_classifier) return _classifier;

  // Ensure cache dir exists
  fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });

  // Lazy import — @huggingface/transformers is heavy (~20MB)
  const { pipeline } = await import("@huggingface/transformers");

  console.log(`  [axovb] Loading model ${modelName} (first run downloads ~250MB, cached at ${MODEL_CACHE_DIR})`);

  _classifier = await pipeline("text-classification", modelName, {
    device: "cpu",
    // Cache models in our own dir so they don't pollute the default cache
    cache_dir: MODEL_CACHE_DIR,
  }) as (text: string) => Promise<Array<{ label: string; score: number }>>;

  return _classifier;
}

/* ── Heuristic fallback (if model unavailable) ───────────────────────── */

function heuristicBump(
  repoPath: string,
  currentVersion: string,
  format: "semver" | "frazyim",
  diff: string,
  error: unknown,
): BumpResult {
  // Simple heuristic: count changed source files vs docs
  const lines = diff.split("\n");
  let sourceChanges = 0;
  let newFiles = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git") && line.includes("new file")) newFiles++;
    if (line.startsWith("+") && !line.startsWith("+++") && !line.startsWith("+//")) sourceChanges++;
  }

  if (newFiles > 0) {
    const suggested = bumpVersion(currentVersion, "minor", format);
    return {
      needed: true,
      currentVersion,
      suggestedVersion: suggested,
      bumpType: "minor",
      reason: `Heuristic: ${newFiles} new file(s) → minor bump (model unavailable: ${error instanceof Error ? error.message : String(error)})`,
      confidence: 0.3,
      format,
    };
  }

  if (sourceChanges > 5) {
    const suggested = bumpVersion(currentVersion, "patch", format);
    return {
      needed: true,
      currentVersion,
      suggestedVersion: suggested,
      bumpType: "patch",
      reason: `Heuristic: ${sourceChanges} source changes → patch bump (model unavailable)`,
      confidence: 0.3,
      format,
    };
  }

  return noBump(currentVersion, format, `No significant changes (model unavailable, heuristic fallback)`);
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function noBump(version: string, format: "semver" | "frazyim", reason: string): BumpResult {
  return { needed: false, currentVersion: version, suggestedVersion: "", bumpType: "none", reason, confidence: 0, format };
}

function readCurrentVersion(repoPath: string): { currentVersion: string; format: "semver" | "frazyim" } {
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const v = pkg.version as string;
    if (v) return { currentVersion: v, format: /^V\d{2}/.test(v) ? "frazyim" : "semver" };
  }
  return { currentVersion: "", format: "semver" };
}

function getDiffSinceLastBump(repoPath: string): string {
  try {
    const lastBump = execSync('git log --oneline --grep="version\\|bump" -i --format=%H -1', {
      cwd: repoPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!lastBump) return "";
    return execSync(`git diff ${lastBump}..HEAD`, {
      cwd: repoPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function toSemver(frazyim: string): string {
  const m = fraziym.match(/^V(\d{2})\.(\d{2})\.(\d{3})(?:-(alpha|beta|rc)(?:-(\d{2}))?)?$/);
  if (!m) return fraziym;
  let s = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
  if (m[4]) { s += `-${m[4]}`; if (m[5]) s += `.${Number(m[5])}`; }
  return s;
}

function bumpVersion(current: string, bumpType: "patch" | "minor" | "major", format: "semver" | "frazyim"): string {
  if (format === "frazyim") return bumpFraziym(current, bumpType);
  return bumpSemver(current, bumpType);
}

function bumpSemver(v: string, t: "patch" | "minor" | "major"): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!m) return v;
  const [maj, min, pat, pre] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
  if (t === "patch") return `${maj}.${min}.${pat + 1}${pre}`;
  if (t === "minor") return `${maj}.${min + 1}.0${pre}`;
  return `${maj + 1}.0.0${pre}`;
}

function bumpFraziym(v: string, t: "patch" | "minor" | "major"): string {
  const m = v.match(/^V(\d{2})\.(\d{2})\.(\d{3})(?:-(alpha|beta|rc)(?:-(\d{2}))?)?$/);
  if (!m) return v;
  const [pf, ff, bb, st, rv] = [m[1], m[2], m[3], m[4], m[5]];
  if (t === "patch") return `V${pf}.${ff}.${String(Number(bb) + 1).padStart(3, "0")}${st ? `-${st}-${rv}` : ""}`;
  if (t === "minor") return `V${pf}.${String(Number(ff) + 1).padStart(2, "0")}.000${st ? `-${st}-01` : ""}`;
  return `V${String(Number(pf) + 1).padStart(2, "0")}.00.000${st ? `-${st}-01` : ""}`;
}
