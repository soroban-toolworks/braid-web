/** Static dev server. Vercel serves these files directly; this is for local work. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

// WebAssembly.instantiateStreaming refuses anything but application/wasm.
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.rs': 'text/plain; charset=utf-8',
};
const port = Number(process.env.PORT) || 8080;

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // normalize() collapses any ../ before we join, so the served tree stays put.
    const file = join(process.cwd(), normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(process.cwd())) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => console.log(`braid-web on http://localhost:${port}`));
