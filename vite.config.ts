import { defineConfig } from 'vite';

// GitHub Pages ではリポジトリ名の下に置かれるので、ビルドの base は SITE_BASE で渡す
export default defineConfig({
  base: process.env.SITE_BASE ?? '/',
  server: { port: 5194 },
  build: { target: 'es2022' },
});
