import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/; the deploy workflow sets VITE_BASE. Local dev: /.
  base: process.env.VITE_BASE ?? '/',
  server: {
    port: 5173,
    // No hot reload: multi-file edits hot-swapped into an open tab mid-change throw every frame,
    // and Vite's forwarded browser errors flooded the log until the dev server stalled.
    // Refresh the tab manually after changes.
    hmr: false,
  },
});
