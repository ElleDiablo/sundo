/**
 * Vite settings for the browser game. Vite serves the game during development (`npm run dev`,
 * with instant reload) and bundles it for production (`npm run build` → dist/, which CI uploads).
 * Files in public/ (map, tiles, sprites) are copied into dist/ as they are.
 */
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so the build works at any URL (localhost, CloudFront, a sub-folder).
  base: "./",
  build: {
    outDir: "dist", // the folder the SundoWeb stack uploads
    // Phaser is one big library (~1.2 MB); that's expected for a game, so don't warn about it.
    chunkSizeWarningLimit: 2000,
  },
});
