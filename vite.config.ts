import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const root = dirname(fileURLToPath(import.meta.url))
const apiPort = process.env.API_PORT ?? "3000"

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", proxy: { "/api": `http://127.0.0.1:${apiPort}`, "/health": `http://127.0.0.1:${apiPort}` } },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: "dist/web",
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        tracker: resolve(root, "tracker.html"),
      },
    },
  },
})
