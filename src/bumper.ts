/**
 * AXOVB Bumper — axodex-powered version bump detection.
 *
 * v2: Uses axodex code intelligence, NOT git diffs.
 *
 * A git diff is just text — it shows WHAT changed but not the SEMANTIC
 * IMPACT. A 100-line diff could be a trivial refactor (no bump) or a
 * breaking API change (major bump). The model can't tell from text.
 *
 * Instead, AXOVB uses axodex to understand the code:
 *   1. `axodex detect_changes` → get list of changed symbols
 *   2. `axodex impact <symbol> --direction upstream` → blast radius
 *   3. Analyze:
 *      - EXPORTED symbols REMOVED or CHANGED → major bump
 *      - New EXPORTED symbols ADDED → minor bump
 *      - Only INTERNAL symbols changed → patch bump
 *      - No code symbols changed (docs/config) → no bump
 *   4. If ambiguous → fall back to small ONNX model for classification
 *
 * This is CODE INTELLIGENCE, not text diffing.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const MODEL_CACHE_DIR = path.join(os.homedir(), ".axovb", "models");
const DEFAULT_MODEL = "Xenova/distilbert-base-uncased";

let _classifier: ((text: string) => Promise<Array<{ label: string; score: number }>>) | null = null;

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
  axodexAnalysis?: string;
  changedSymbols?: string[];
  blastRadius?: number;
}

export async function checkBumpNeeded(
  repoPath: string,
  opts: BumpOptions = {},
): Promise<BumpResult> {
  const { currentVersion, format } = readCurrentVersion(repoPath);
  if (!currentVersion) {
    return noBump("(unknown)", "semver", "No version found");
  }

  // Step 1: Run axodex detect_changes to get affected symbols
  const detectResult = runAxodex(repoPath, "detect_changes");
  if (!detectResult || detectResult.includes("[AXODEX ERROR]")) {
    // axodex not available — fall back to heuristic
    return heuristicBump(repoPath, currentVersion, format, detectResult);
  }

  const changedSymbols = parseSymbols(detectResult);
  if (changedSymbols.length === 0) {
    return noBump(currentVersion, format, "No code symbols changed — docs/config only");
  }

  // Step 2: Run axodex impact for each changed symbol to get blast radius
  let totalBlastRadius = 0;
  let hasExportedChanges = false;
  let hasRemovedExports = false;
  let hasNewExports = false;
  const impactReports: string[] = [];

  for (const symbol of changedSymbols.slice(0, 20)) { // Limit to 20 symbols
    const impact = runAxodex(repoPath, "impact", symbol, "--direction", "upstream");
    if (impact && !impact.includes("[AXODEX ERROR]")) {
      totalBlastRadius += countCallers(impact);
      impactReports.push(`${symbol}: ${impact.slice(0, 200)}`);

      // Check if this is an exported symbol
      if (isExportedSymbol(symbol, impact)) {
        hasExportedChanges = true;
        if (isRemovedSymbol(symbol, impact)) {
          hasRemovedExports = true;
        }
        if (isNewSymbol(symbol, impact)) {
          hasNewExports = true;
        }
      }
    }
  }

  // Step 3: Determine bump type from semantic analysis
  let bumpType: "patch" | "minor" | "major" | "none";
  let reason: string;
  let confidence: number;

  if (hasRemovedExports) {
    // Exported symbols removed or signatures changed → breaking change
    bumpType = "major";
    reason = `Exported symbol(s) removed/changed — ${totalBlastRadius} callers affected. Breaking change.`;
    confidence = 0.95;
  } else if (hasNewExports) {
    // New exported symbols added → backwards-compatible feature
    bumpType = "minor";
    reason = `New exported symbol(s) added — ${changedSymbols.length} symbols, ${totalBlastRadius} callers. Backwards compatible.`;
    confidence = 0.90;
  } else if (totalBlastRadius > 0) {
    // Internal symbols changed but callers exist → patch
    bumpType = "patch";
    reason = `${changedSymbols.length} internal symbol(s) modified, ${totalBlastRadius} callers affected. Non-breaking.`;
    confidence = 0.85;
  } else if (changedSymbols.length > 0) {
    // Symbols changed but no callers → patch (implementation detail)
    bumpType = "patch";
    reason = `${changedSymbols.length} symbol(s) modified, 0 external callers. Implementation change.`;
    confidence = 0.80;
  } else {
    // No code changes detected
    return noBump(currentVersion, format, "No code symbols changed");
  }

  // Step 4: If confidence is low or ambiguous, use the ONNX model as tiebreaker
  if (confidence < (opts.confidenceThreshold ?? 0.7)) {
    try {
      const modelResult = await runModelClassifier(
        impactReports.join("\n").slice(0, 2000),
        opts.modelPath,
      );
      if (modelResult && modelResult.confidence > confidence) {
        bumpType = modelResult.bumpType;
        reason += ` (model tiebreaker: ${modelResult.bumpType} at ${(modelResult.confidence * 100).toFixed(0)}%)`;
        confidence = modelResult.confidence;
      }
    } catch {
      // Model unavailable — use axodex analysis alone (that's fine)
    }
  }

  const suggestedVersion = bumpVersion(currentVersion, bumpType, format);

  return {
    needed: bumpType !== "none",
    currentVersion,
    suggestedVersion,
    bumpType,
    reason,
    confidence,
    format,
    axodexAnalysis: impactReports.join("\n").slice(0, 1000),
    changedSymbols,
    blastRadius: totalBlastRadius,
  };
}

export async function performBump(repoPath: string, result: BumpResult): Promise<boolean> {
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.version = result.format === "frazyim" ? toSemver(result.suggestedVersion) : result.suggestedVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

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

  try {
    execSync('git add package.json src/version.ts 2>/dev/null || git add package.json', {
      cwd: repoPath, stdio: "pipe",
    });
    execSync(
      `git commit -m "chore(version): ${result.currentVersion} → ${result.suggestedVersion} (${result.bumpType}, blast radius: ${result.blastRadius}, ${(result.confidence * 100).toFixed(0)}% confidence)"`,
      { cwd: repoPath, stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

/* ── Axodex integration ────────────────────────────────────────── */

function runAxodex(workspace: string, ...args: string[]): string | null {
  try {
    const cmd = `axodex ${args.join(" ")} 2>&1`;
    const result = execSync(cmd, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

function parseSymbols(detectOutput: string): string[] {
  // axodex detect_changes returns lines of symbol names
  return detectOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[") && !l.startsWith("#"))
    .slice(0, 50);
}

function countCallers(impactOutput: string): number {
  // Count lines that look like caller references
  const lines = impactOutput.split("\n").filter((l) => l.trim() && !l.startsWith("["));
  return Math.min(lines.length, 100);
}

function isExportedSymbol(symbol: string, impactOutput: string): boolean {
  // Heuristic: exported symbols appear in impact output with "export" or "public" markers
  const lower = impactOutput.toLowerCase();
  return lower.includes("export") || lower.includes("public") || lower.includes("external");
}

function isRemovedSymbol(symbol: string, impactOutput: string): boolean {
  const lower = impactOutput.toLowerCase();
  return lower.includes("removed") || lower.includes("deleted") || lower.includes("breaking");
}

function isNewSymbol(symbol: string, impactOutput: string): boolean {
  const lower = impactOutput.toLowerCase();
  return lower.includes("new") || lower.includes("added") || lower.includes("created");
}

/* ── ONNX model (tiebreaker only) ─────────────────────────────── */

async function runModelClassifier(
  input: string,
  modelPath?: string,
): Promise<{ bumpType: "patch" | "minor" | "major" | "none"; confidence: number } | null> {
  try {
    const classifier = await getClassifier(modelPath || DEFAULT_MODEL);
    const predictions = await classifier(input.slice(0, 2000));
    if (!predictions || predictions.length === 0) return null;

    const top = predictions[0];
    const LABEL_MAP = new Map([
      ["patch", "patch"], ["minor", "minor"], ["major", "major"], ["none", "none"],
      ["LABEL_0", "none"], ["LABEL_1", "patch"], ["LABEL_2", "minor"], ["LABEL_3", "major"],
    ]);
    const bumpType = LABEL_MAP.get(top.label) ?? "none";
    return { bumpType: bumpType as "patch" | "minor" | "major" | "none", confidence: top.score };
  } catch {
    return null;
  }
}

async function getClassifier(modelName: string) {
  if (_classifier) return _classifier;
  fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
  const { pipeline } = await import("@huggingface/transformers");
  _classifier = await pipeline("text-classification", modelName, {
    device: "cpu", cache_dir: MODEL_CACHE_DIR,
  }) as (text: string) => Promise<Array<{ label: string; score: number }>>;
  return _classifier;
}

/* ── Heuristic fallback (if axodex unavailable) ───────────────── */

function heuristicBump(
  repoPath: string,
  currentVersion: string,
  format: "semver" | "frazyim",
  axodexError: string | null,
): BumpResult {
  // If axodex isn't available, use git diff as a LAST RESORT
  // This is explicitly the non-PEAK fallback path
  try {
    const diff = execSync('git diff HEAD~1..HEAD --stat 2>/dev/null', {
      cwd: repoPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const sourceFiles = diff.split("\n").filter((l) => l.match(/\.(ts|js|py|go|rs|java)\|/)).length;
    const newFiles = diff.split("\n").filter((l) => l.includes("new file")).length;

    if (newFiles > 0) {
      return {
        needed: true, currentVersion, suggestedVersion: bumpVersion(currentVersion, "minor", format),
        bumpType: "minor", reason: `Heuristic: ${newFiles} new file(s) → minor (axodex unavailable: ${axodexError?.slice(0, 50) ?? "not installed"})`,
        confidence: 0.3, format,
      };
    }
    if (sourceFiles > 0) {
      return {
        needed: true, currentVersion, suggestedVersion: bumpVersion(currentVersion, "patch", format),
        bumpType: "patch", reason: `Heuristic: ${sourceFiles} source file(s) → patch (axodex unavailable)`,
        confidence: 0.3, format,
      };
    }
    return noBump(currentVersion, format, "No source changes (axodex unavailable, heuristic)");
  } catch {
    return noBump(currentVersion, format, "No changes detected (axodex unavailable)");
  }
}

/* ── Helpers ────────────────────────────────────────────────── */

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
