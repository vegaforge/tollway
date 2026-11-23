/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ioredis opens sockets and is meant to run from node_modules as is.
  serverExternalPackages: ["ioredis"],
};

export default nextConfig;
