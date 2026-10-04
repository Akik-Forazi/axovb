/**
 * AXOVB Bumper — LLM-powered version bump detection.
 *
 * Instead of regex-matching filenames, this module sends the actual git
 * diff to a small LLM (3B-8B) that understands code semantics. The LLM
 * reads the diff, understands WHAT changed (new feature? bugfix? breaking
 * change? docs only?), and returns a structured recommendation.
 *
 * Supports any OpenAI-compatible endpoint:
 *   - LM Studio (localhost:1234/v1)
 *   - Ollama (localhost:11434/v1)
 *   - OpenAI (api.openai.com/v1)
 *   - Groq, Together, Mistral, DeepSeek, etc.
 *
 * Usage:
 *   const result = await checkBumpNeeded(repoPath, {
 *     provider: "lmstudio",
 *     baseUrl: "http://localhost:1234/v1",
 *     model: "qwen2.5-coder-7b-instruct",
 *   });
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface BumpOptions {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface BumpResult {
  needed: boolean;
  currentVersion: string;
  suggestedVersion: string;
  bumpType: "patch" | "minor" | "major" | "none";
  reason: string;
  format: "semver" | "frazyim";
  llmAnalysis?: string;
}

const ANALYSIS_PROMPT = `You are AXOVB — an expert version bumper. Analyze the following git diff and determine if a version bump is needed.

Rules:
- patch: Bug fixes, small changes, non-breaking (e.g. fix a typo, update a config value)
- minor: New features, new files, new exports — backwards compatible
- major: Breaking changes (removed exports, changed signatures, renamed APIs)
- none: Only docs/config/CI files changed (README, .yml, .gitignore)

Respond with STRICT JSON only (no prose, no markdown):
{"bump": "patch"|"minor"|"major"|"none", "reason": "one sentence explaining why"}

Git diff:`;

export async function checkBumpNeeded(
  repoPath: string,
  opts: BumpOptions = {},
): Promise<BumpResult> {
  const { currentVersion, format } = readCurrentVersion(repoPath);
  if (!currentVersion) {
    return noBump("(unknown)", "semver", "No version found");
  }

  // Get the git diff since the last version-bump commit
  const diff = getDiffSinceLastBump(repoPath);
  if (!diff.trim()) {
    return noBump(currentVersion, format, "No changes since last version bump");
  }

  // Truncate diff to fit context window (LLMs have limits)
  const truncatedDiff = diff.slice(0, 12000);

  // Call the LLM to analyze the diff
  const llmResult = await callLLM(opts, ANALYSIS_PROMPT, truncatedDiff);

  // Parse the LLM response
  const analysis = parseLLMResponse(llmResult);

  if (analysis.bump === "none") {
    return noBump(currentVersion, format, analysis.reason);
  }

  const suggestedVersion = bumpVersion(currentVersion, analysis.bump, format);

  return {
    needed: true,
    currentVersion,
    suggestedVersion,
    bumpType: analysis.bump,
    reason: analysis.reason,
    format,
    llmAnalysis: llmResult,
  };
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
      `git commit -m "chore(version): ${result.currentVersion} → ${result.suggestedVersion} (${result.bumpType}) — ${result.reason}"`,
      { cwd: repoPath, stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

/* ── LLM call ────────────────────────────────────────────────────────── */

async function callLLM(opts: BumpOptions, systemPrompt: string, userContent: string): Promise<string> {
  const baseUrl = opts.baseUrl || process.env.AXOVB_BASE_URL || "http://localhost:1234/v1";
  const apiKey = opts.apiKey || process.env.AXOVB_API_KEY || "";
  const model = opts.model || process.env.AXOVB_MODEL || "qwen2.5-coder-7b-instruct";

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return `{"bump": "none", "reason": "LLM call failed: ${res.status} ${res.statusText}"}`;
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    return `{"bump": "none", "reason": "LLM unreachable: ${e instanceof Error ? e.message : String(e)}"}`;
  }
}

function parseLLMResponse(response: string): { bump: "patch" | "minor" | "major" | "none"; reason: string } {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/\{[^}]+\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const bump = parsed.bump as "patch" | "minor" | "major" | "none";
      if (["patch", "minor", "major", "none"].includes(bump)) {
        return { bump, reason: String(parsed.reason ?? "") };
      }
    } catch {
      /* fall through */
    }
  }
  // Fallback: scan for keywords
  const lower = response.toLowerCase();
  if (lower.includes("major") || lower.includes("breaking")) return { bump: "major", reason: "Breaking change detected" };
  if (lower.includes("minor") || lower.includes("feature") || lower.includes("new")) return { bump: "minor", reason: "New feature detected" };
  if (lower.includes("patch") || lower.includes("fix") || lower.includes("bug")) return { bump: "patch", reason: "Bug fix detected" };
  return { bump: "none", reason: "No significant changes" };
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function noBump(version: string, format: "semver" | "frazyim", reason: string): BumpResult {
  return { needed: false, currentVersion: version, suggestedVersion: "", bumpType: "none", reason, format };
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
