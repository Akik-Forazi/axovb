/**
 * AXOVB Git Hook — installs as a pre-push hook that runs `axovb check`.
 *
 * If a version bump is needed, the hook blocks the push and tells the
 * user to run `axovb bump` first.
 */

import fs from "node:fs";
import path from "node:path";

const HOOK_CONTENT = `#!/bin/sh
# AXOVB pre-push hook — checks for forgotten version bumps
# Installed by: axovb hook install
# Removed by:  axovb hook remove

echo "[axovb] Checking for forgotten version bump..."
npx -y @fraziym/axovb check
if [ $? -ne 0 ]; then
  echo ""
  echo "[axovb] Version bump needed! Run 'axovb bump' before pushing."
  echo "  Or bypass with: git push --no-verify (not recommended)"
  exit 1
fi
`;

export function installHook(): void {
  const gitDir = findGitDir(process.cwd());
  if (!gitDir) {
    console.error("  [-] Not in a git repository.");
    process.exitCode = 1;
    return;
  }

  const hooksDir = path.join(gitDir, "hooks");
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = path.join(hooksDir, "pre-push");
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf8");
    if (existing.includes("axovb")) {
      console.log("  [+] AXOVB hook already installed.");
      return;
    }
    // Append to existing hook
    fs.writeFileSync(hookPath, existing + "\n" + HOOK_CONTENT);
    console.log(`  [+] AXOVB hook appended to existing pre-push hook.`);
  } else {
    fs.writeFileSync(hookPath, HOOK_CONTENT);
    fs.chmodSync(hookPath, 0o755);
    console.log(`  [+] AXOVB pre-push hook installed at ${hookPath}`);
  }
}

export function removeHook(): void {
  const gitDir = findGitDir(process.cwd());
  if (!gitDir) {
    console.error("  [-] Not in a git repository.");
    process.exitCode = 1;
    return;
  }

  const hookPath = path.join(gitDir, "hooks", "pre-push");
  if (!fs.existsSync(hookPath)) {
    console.log("  [+] No pre-push hook found.");
    return;
  }

  const content = fs.readFileSync(hookPath, "utf8");
  if (!content.includes("axovb")) {
    console.log("  [+] Hook doesn't contain AXOVB — nothing to remove.");
    return;
  }

  // Remove just the axovb section, or the whole file if it's only axovb
  const lines = content.split("\n");
  const nonAxovbLines = lines.filter((_, i) => {
    // Simple heuristic: remove lines between "# AXOVB" and the next blank line
    return true; // For simplicity, just remove the whole file if it's only axovb
  });

  if (nonAxovbLines.length === 0 || (content.trim().startsWith("# AXOVB") && content.trim().endsWith("fi"))) {
    fs.unlinkSync(hookPath);
    console.log("  [+] AXOVB hook removed.");
  } else {
    // Remove just the axovb section
    const cleaned = content.replace(/# AXOVB pre-push hook[\s\S]*?fi\n?/g, "");
    fs.writeFileSync(hookPath, cleaned);
    console.log("  [+] AXOVB section removed from pre-push hook.");
  }
}

function findGitDir(start: string): string | null {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    const gitPath = path.join(dir, ".git");
    if (fs.existsSync(gitPath)) {
      // Could be a file (worktree) or directory
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return gitPath;
      // It's a file — read the gitdir path
      const content = fs.readFileSync(gitPath, "utf8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) return match[1];
    }
    dir = path.dirname(dir);
  }
  return null;
}
