/** @type {import('next').NextConfig} */
const nextConfig = {
  // Linting is handled by Biome at the repo root, not next lint.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
