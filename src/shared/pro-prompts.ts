// The prompts the dashboard hands to the owner's AI agent to install FounderData Pro or to update a deployment
// (docs/PRO.md "Install Pro", "Updates"). The agent merges with git, so the owner's own changes to the code survive.
import { CORE_REPO, PRO_REPO } from './product';

const CHECKS = `Then run \`npm install\` and \`npm run typecheck && npm test\`, and fix whatever my own changes broke. Finish with \`npm run setup\`: it applies the new migrations and deploys, and keeps the existing password and data. Tell me what changed and which conflicts you resolved.`;

/** For a core deployment that bought Pro. */
export const PRO_INSTALL_PROMPT = `Install FounderData Pro into this FounderData checkout and deploy it.

1. Run \`git status\`. Commit my uncommitted changes first, so nothing is lost.
2. Merge Pro:
   git remote add pro ${PRO_REPO}.git   (skip this if a "pro" remote exists)
   git fetch pro
   git merge pro/main
   My GitHub account got read access to that repository when I bought Pro. If git refuses, ask me to accept the GitHub invitation from FounderData Pro, or to sign in with \`gh auth login\`.
3. Resolve every conflict so that my changes and Pro's both survive. Pro adds the pro/ folder and changes src/worker/edition.ts and src/dashboard/edition.ts, so a conflict comes from a file I changed.
4. ${CHECKS}`;

/** For a deployment that wants the latest release of its edition. */
export function updatePrompt(edition: 'core' | 'pro', latest?: string): string {
  const target = latest ? ` ${latest}` : '';
  const remote =
    edition === 'pro'
      ? `   git remote add pro ${PRO_REPO}.git   (skip this if a "pro" remote exists)
   git fetch pro
   git merge pro/main
   Pro includes every core release, so this one merge brings both.`
      : `   git remote add upstream ${CORE_REPO}.git   (skip this if a remote already points there)
   git fetch upstream
   git merge upstream/main`;
  return `Update this FounderData checkout to the latest release${target} and deploy it.

1. Run \`git status\`. Commit my uncommitted changes first, so nothing is lost.
2. Merge the release:
${remote}
3. Resolve every conflict so that my changes and the release's both survive.
4. ${CHECKS}`;
}
