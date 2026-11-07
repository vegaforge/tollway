---
date: 2026-11-07
feature: The website and docs move from Vercel to Netlify
scope: chore
packages: []
scenario-impact: none
---

# Website and docs move to Netlify

The Tollway website and docs now live at https://usetollway.netlify.app. The
old Vercel address returns an error (#110) and is no longer used.

`apps/web/netlify.toml` builds the site with the same command as before
(`pnpm turbo build --filter=@tollway/web`) from the repository root, so pnpm,
Node 22 and the lockfile come from the same files CI uses. Netlify adds its
Next.js runtime itself. Builds are skipped when nothing under `apps/web`,
`packages/theme`, the lockfile or the root `package.json` changed.

The Vercel config files (`apps/web/vercel.json` and both `.vercelignore`
files) are removed, and the site metadata and README point to the new address.
No package or behaviour changed.
