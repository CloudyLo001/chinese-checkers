import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only endpoint for grabbing the WebGL canvas to a file.
 *
 * The renderer is the one part of this app that unit tests cannot check, so
 * being able to pull a real frame out of a running browser is worth the twenty
 * lines. POST a data URL to /__capture and it lands in .captures/.
 *
 *   await fetch('/__capture?name=board', { method: 'POST', body: dataUrl })
 *
 * Never registered in a production build.
 */
function captureEndpoint(): Plugin {
  return {
    name: 'capture-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__capture', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end('POST only');
          return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const base64 = body.slice(body.indexOf(',') + 1);
            const name = new URL(request.url ?? '', 'http://localhost').searchParams.get('name');
            const safeName = (name ?? 'capture').replace(/[^a-z0-9_-]/gi, '');
            const file = resolve(process.cwd(), '.captures', `${safeName}.jpg`);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, Buffer.from(base64, 'base64'));
            response.end(file);
          } catch (error) {
            response.statusCode = 500;
            response.end(String(error));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [captureEndpoint()],
  server: {
    port: 5191,
    strictPort: true,
  },
  preview: {
    port: 4191,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
});
