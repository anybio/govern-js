import type { NextConfig } from "next";

// Hosts allowed to load this dev server's own resources.
//
// The dev server blocks cross-origin requests for its resources, which is the
// right default. It bites when you run the example on a machine you reach by
// hostname or LAN address rather than on localhost: the client bundle never
// loads, the page renders as static HTML, and the send button stays disabled
// because nothing hydrated. If you browse to this example as anything other
// than localhost, list that host in GOVERN_EXAMPLE_DEV_ORIGINS (see
// .env.example). Dev only; `next build` ignores it.
const extraDevOrigins = (process.env.GOVERN_EXAMPLE_DEV_ORIGINS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["localhost", "127.0.0.1", ...extraDevOrigins],
};

export default nextConfig;
