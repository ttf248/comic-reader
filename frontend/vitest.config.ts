import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // .smoke 里存着截图与临时检出（验证过程的产物），里面可能有一份
    // 完整的源码副本；不排除掉的话 vitest 会把它当成第二套测试跑一遍。
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**', '.smoke/**'],
  },
})
