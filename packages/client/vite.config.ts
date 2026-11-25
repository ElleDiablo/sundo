import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so the build works at any URL (localhost, CloudFront, a sub-folder).
  base: "./",
  build: {
    outDir: "dist",
    // Phaser is one big library (~1.2 MB); that's expected for a game, so don't warn about it.
    chunkSizeWarningLimit: 2000,
  },
});
