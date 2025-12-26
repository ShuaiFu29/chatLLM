import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import viteCompression from 'vite-plugin-compression'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'fs'
import path from 'path'

// Custom plugin to inline optimization files
const inlineOptimization = () => {
  return {
    name: 'inline-optimization',
    transformIndexHtml(html: string) {
      const themeScript = fs.readFileSync(path.resolve(__dirname, 'src/optimization/theme.js'), 'utf-8');
      const loaderHtml = fs.readFileSync(path.resolve(__dirname, 'src/optimization/loader.html'), 'utf-8');

      return html
        .replace('<!-- INJECT_THEME_SCRIPT -->', `<script>${themeScript}</script>`)
        .replace('<!-- INJECT_LOADER -->', loaderHtml);
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    inlineOptimization(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'ChatLLM',
        short_name: 'ChatLLM',
        description: 'AI Chat Application with RAG capabilities',
        theme_color: '#111827',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365 // <== 365 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      }
    }),
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
    }),
    viteCompression({
      algorithm: 'brotliCompress',
      ext: '.br',
    })
  ],
  server: {
    port: 5173,
    strictPort: true, // Fail if port is in use, don't auto-switch
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-core': [
            'react',
            'react-dom',
            'react-router-dom',
            'axios',
            'zustand',
            'i18next',
            'react-i18next',
            'i18next-browser-languagedetector',
            'spark-md5'
          ],
          'vendor-ui': [
            'lucide-react',
            'sonner',
            'cmdk',
            '@radix-ui/react-dialog'
          ],
          'vendor-markdown': [
            'react-markdown',
            'rehype-raw',
            'remark-gfm',
          ],
        }
      }
    }
  }
})
