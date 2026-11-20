import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { syncPlugin } from './src/server/syncPlugin'

export default defineConfig({
  plugins: [react(), syncPlugin()],
  server: {
    host: true,                     // 외부(LAN, 터널)에서도 접근 허용
    port: 5000,                     // 기본 포트를 5000 로 지정
    allowedHosts: true,             // 터널 등 외부 도메인 호스트 허용
  },
  preview: {
    host: true,                     // 외부(LAN, 터널)에서도 접근 허용
    port: 5000,                     // 기본 포트 5000
    allowedHosts: true,             // 터널 등 외부 도메인 호스트 허용
  },
})
