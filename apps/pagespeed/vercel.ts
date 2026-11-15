import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  regions: ["sin1"],
  // Skip the release commit that semantic-release pushes (exit 0 = skip).
  ignoreCommand:
    "echo \"$VERCEL_GIT_COMMIT_MESSAGE\" | grep -q '^chore(release)'",
};
