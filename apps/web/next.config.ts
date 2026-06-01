import type { NextConfig } from 'next';

/**
 * Next config (T5.1).
 *
 * `@getbeyond/shared` is intentionally NOT in `transpilePackages`, and the web
 * app consumes it as TYPES ONLY (`import type ...`). Reason: the package ships a
 * CommonJS `dist/`, and pnpm symlinks it to `packages/shared` (outside
 * `node_modules`), so Next runs its React Fast Refresh loader over it and
 * injects `import.meta.webpackHot` — illegal in a CJS script → "Cannot use
 * 'import.meta' outside a module". `transpilePackages` does NOT fix this (it
 * doesn't change the module format). Type-only imports are erased at compile
 * time, so webpack never parses the build and the problem can't arise.
 *
 * Rule: import only TYPES from `@getbeyond/shared` here. If you need one of its
 * (tiny) runtime values, redefine it locally typed against the shared union —
 * see TERMINAL_TYPES in use-campaign-stream.ts. Don't import shared runtime
 * values into client modules until shared ships a real ESM/dual build.
 *
 * No remote-image config, no experimental flags — keep the surface boring.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
