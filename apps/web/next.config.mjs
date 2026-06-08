import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Linting is handled by Biome at the repo root, not next lint.
  eslint: { ignoreDuringBuilds: true },
};

export default withMDX(config);
