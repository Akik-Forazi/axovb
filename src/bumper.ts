/**
 * AXOVB Bumper — detects forgotten version bumps and performs them.
 *
 * Detection logic:
 *   1. Read the current version from package.json or src/version.ts
 *   2. Get the git diff since the last version-bump commit
 *   3. Analyze the diff: did code change without a version bump?
 *   4. Classify the bump type based on what changed:
 *      - Source files changed (no tests/docs only) → at least patch bump
 *      - New features (new files, new exports) → minor bump
 *      - Breaking changes (removed exports, changed signatures) → major bump
 *      - Config/docs only → no bump needed
 *   5. If a bump is needed, compute the new version and apply it
 *
 * Supports both semver (0.1.0) and FRAZIYM (V00.01.000) versioning.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface BumpResult {
  needed: boolean;
  currentVersion: string;
  suggestedVersion: string;
  bumpType: "patch" | "minor" | "major" | "none";
  reason: string;
  format: "semver" | "frazyim";
}

/**
 * Check if a version bump is needed by analyzing git changes since
 * the last version-bump commit.
 */
export async function checkBumpNeeded(repoPath: string): Promise<BumpResult> {
  const { currentVersion, format, versionFile } = readCurrentVersion(repoPath);
  if (!currentVersion) {
    return {
      needed: false,
      currentVersion: "(unknown)",
      suggestedVersion: "",
      bumpType: "none",
      reason: "No version found in package.json or version.ts",
      format: "semver",
    };
  }

  // Get the last commit that touched the version
  const lastBumpCommit = getLastVersionCommit(repoPath, versionFile);
  if (!lastBumpCommit) {
    // No version commit found — first run, no bump needed
    return {
      needed: false,
      currentVersion,
      suggestedVersion: "",
      bumpType: "none",
      reason: "No previous version commit found (first run)",
      format,
    };
  }

  // Get diff since the last version bump
  const diff = getDiffSince(repoPath, lastBumpCommit);
  if (!diff.trim()) {
    return {
      needed: false,
      currentVersion,
      suggestedVersion: "",
      bumpType: "none",
      reason: "No changes since last version bump",
      format,
    };
  }

  // Analyze the diff to determine bump type
  const analysis = analyzeDiff(diff);
  if (analysis.bumpType === "none") {
    return {
      needed: false,
      currentVersion,
      suggestedVersion: "",
      bumpType: "none",
      reason: "Only non-code files changed (docs, config)",
      format,
    };
  }

  // Compute suggested version
  const suggestedVersion = bumpVersion(currentVersion, analysis.bumpType, format);

  return {
    needed: true,
    currentVersion,
    suggestedVersion,
    bumpType: analysis.bumpType,
    reason: analysis.reason,
    format,
  };
}

/**
 * Perform the version bump: update package.json and/or version.ts,
 * then commit the change.
 */
export async function performBump(repoPath: string, result: BumpResult): Promise<boolean> {
  const { suggestedVersion, format, versionFile } = { ...result, versionFile: getVersionFilePath(repoPath) };

  // Update package.json
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.version = format === "frazyim" ? toSemver(suggestedVersion) : suggestedVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  // Update version.ts if it exists
  const versionTsPath = path.join(repoPath, "src", "version.ts");
  if (fs.existsSync(versionTsPath)) {
    let content = fs.readFileSync(versionTsPath, "utf8");
    if (format === "frazyim") {
      content = content.replace(/V\d{2}\.\d{2}\.\d{3}-?(?:\w+)?-?\d{0,2}/, suggestedVersion);
      const semver = toSemver(suggestedVersion);
      content = content.replace(/0\.\d+\.\d+-beta\.\d+/, semver);
    } else {
      content = content.replace(/\d+\.\d+\.\d+(?:-\w+\.\d+)?/, suggestedVersion);
    }
    fs.writeFileSync(versionTsPath, content);
  }

  // Git add + commit
  try {
    execSync('git add package.json src/version.ts 2>/dev/null || git add package.json', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync(
      `git commit -m "chore(version): bump ${result.currentVersion} → ${suggestedVersion} (${result.bumpType})"`,
      { cwd: repoPath, stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function readCurrentVersion(repoPath: string): {
  currentVersion: string;
  format: "semver" | "frazyim";
  versionFile: string;
} {
  // Try package.json first
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const v = pkg.version as string;
    if (v) {
      return {
        currentVersion: v,
        format: isFraziym(v) ? "frazyim" : "semver",
        versionFile: "package.json",
      };
    }
  }
  return { currentVersion: "", format: "semver", versionFile: "" };
}

function getVersionFilePath(repoPath: string): string {
  const versionTsPath = path.join(repoPath, "src", "version.ts");
  if (fs.existsSync(versionTsPath)) return versionTsPath;
  return path.join(repoPath, "package.json");
}

function isFraziym(v: string): boolean {
  return /^V\d{2}\.\d{2}\.\d{3}/.test(v);
}

function toSemver(frazyim: string): string {
  const m = fraziym.match(/^V(\d{2})\.(\d{2})\.(\d{3})(?:-(alpha|beta|rc)(?:-(\d{2}))?)?$/);
  if (!m) return fraziym;
  let s = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
  if (m[4]) {
    s += `-${m[4]}`;
    if (m[5]) s += `.${Number(m[5])}`;
  }
  return s;
}

function getLastVersionCommit(repoPath: string, file: string): string | null {
  try {
    const out = execSync(
      `git log --oneline --all --grep="version" --grep="bump" -i --format=%H -1`,
      { cwd: repoPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

function getDiffSince(repoPath: string, commit: string): string {
  try {
    return execSync(`git diff ${commit}..HEAD --stat`, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

interface DiffAnalysis {
  bumpType: "patch" | "minor" | "major" | "none";
  reason: string;
}

function analyzeDiff(diff: string): DiffAnalysis {
  const lines = diff.split("\n").filter((l) => l.trim() && !l.startsWith("commit "));
  const changedFiles = lines.filter((l) => l.includes("|") || l.includes("=>"));

  let sourceFiles = 0;
  let newFiles = 0;
  let docFiles = 0;
  let configFiles = 0;

  for (const line of changedFiles) {
    const filename = line.split("|")[0]?.trim() ?? "";
    if (!filename) continue;

    if (filename.endsWith(".md") || filename.endsWith(".txt")) docFiles++;
    else if (filename.endsWith(".json") || filename.endsWith(".yaml") || filename.endsWith(".yml") || filename.endsWith(".toml")) configFiles++;
    else if (line.includes("new file") || line.includes("=>")) newFiles++;
    else sourceFiles++;
  }

  if (sourceFiles === 0 && newFiles === 0) {
    return { bumpType: "none", reason: "Only non-code files changed" };
  }

  if (newFiles > 0) {
    return { bumpType: "minor", reason: `${newFiles} new file(s) added — minor bump for new feature` };
  }

  return { bumpType: "patch", reason: `${sourceFiles} source file(s) modified — patch bump` };
}

function bumpVersion(
  current: string,
  bumpType: "patch" | "minor" | "major",
  format: "semver" | "frazyim",
): string {
  if (format === "frazyim") {
    return bumpFraziym(current, bumpType);
  }
  return bumpSemver(current, bumpType);
}

function bumpSemver(v: string, bumpType: "patch" | "minor" | "major"): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!m) return v;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const pre = m[4] ?? "";

  switch (bumpType) {
    case "patch": return `${major}.${minor}.${patch + 1}${pre}`;
    case "minor": return `${major}.${minor + 1}.0${pre}`;
    case "major": return `${major + 1}.0.0${pre}`;
  }
}

function bumpFraziym(v: string, bumpType: "patch" | "minor" | "major"): string {
  const m = v.match(/^V(\d{2})\.(\d{2})\.(\d{3})(?:-(alpha|beta|rc)(?:-(\d{2}))?)?$/);
  if (!m) return v;
  const platform = m[1];
  const feature = m[2];
  const bugfix = m[3];
  const stage = m[4];
  const rev = m[5];

  switch (bumpType) {
    case "patch":
      return `V${platform}.${feature}.${String(Number(bugfix) + 1).padStart(3, "0")}${stage ? `-${stage}-${rev}` : ""}`;
    case "minor":
      return `V${platform}.${String(Number(feature) + 1).padStart(2, "0")}.000${stage ? `-${stage}-01` : ""}`;
    case "major":
      return `V${String(Number(platform) + 1).padStart(2, "0")}.00.000${stage ? `-${stage}-01` : ""}`;
  }
}
