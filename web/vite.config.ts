import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Point the dev server at a backend on another port with API_TARGET=http://localhost:3100.
    proxy: {
      '/api': process.env.API_TARGET ?? 'http://localhost:3000',
      '/health': process.env.API_TARGET ?? 'http://localhost:3000',
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'markdown', test: /node_modules[\/](react-markdown|remark|rehype|unified|micromark|mdast|hast|highlight\.js|lowlight|vfile|unist|property-information|space-separated|comma-separated|decode-named|character-|trim-lines|bail|trough|devlop|is-plain)/ },
            { name: 'assistant-ui', test: /node_modules[\/]@assistant-ui/ },
            { name: 'react', test: /node_modules[\/](react|react-dom|scheduler)[\/]/ },
          ],
        },
      },
    },
  },
})
