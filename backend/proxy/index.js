/**
 * Reverse proxy implementation.
 *
 * Uses Node's http.request with a pooled keep-alive agent (fast: sockets to
 * each backend are reused). We previously used the http-proxy package, but
 * it is unmaintained and breaks under concurrent keep-alive load on modern
 * Node, so this module implements the proxying directly:
 *   - forwards method, path, headers and body
 *   - streams the upstream response back (status, headers, body)
 *   - maps upstream failures to clean client errors (502/504), never
 *     leaking stack traces
 *   - buffers small request bodies (<=1MB) so a failed attempt can be
 *     retried on another backend instance
 */
const http = require('http');

const agent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });
const timeoutMs = () => Number(process.env.PROXY_TIMEOUT) || 8000;

function parseTarget(url) {
  const u = new URL(url);
  return { hostname: u.hostname, port: u.port || 80, path: '' };
}

function forward(req, res, targetUrl, t) {
  const target = parseTarget(targetUrl);
  const timeout = t || timeoutMs();

  return new Promise((resolve, reject) => {
    // Hop-by-hop headers must not cross a proxy hop with a shared agent.
    const headers = { ...req.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    headers.host = `${target.hostname}:${target.port}`;

    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.originalUrl || req.url,
        headers,
        agent,
        timeout,
      },
      (upRes) => {
        // Relay status line + headers, then pipe the body.
        const head = { ...upRes.headers };
        delete head.connection;
        delete head['keep-alive'];
        res.writeHead(upRes.statusCode, head);
        upRes.pipe(res);
        upRes.on('end', () => resolve());
        upRes.on('error', (err) => { if (!res.headersSent) reject(err); else resolve(); });
      }
    );

    upstream.setTimeout(timeout, () => {
      upstream.destroy(new Error('timeout'));
    });

    upstream.on('error', (err) => {
      if (res.headersSent) { res.destroy(); resolve(); return; }
      err.proxyCode = /timeout/i.test(err.message || '') || err.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable';
      reject(err);
    });

    // Send the request body: reuse a buffered body on retries, otherwise
    // buffer it once (lab-scale payloads are small).
    if (req._bodyBuffer) {
      finishUpstream(upstream, Buffer.from(req._bodyBuffer), resolve, reject);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large', message: 'Body exceeds 1MB proxy limit' }));
        upstream.destroy();
        resolve();
        req.removeAllListeners('data');
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => { upstream.destroy(); resolve(); });
    req.on('end', () => {
      req._bodyBuffer = Buffer.concat(chunks);
      finishUpstream(upstream, req._bodyBuffer, resolve, reject);
    });
  });
}

function finishUpstream(upstream, body, resolve, reject) {
  if (body.length) upstream.write(body);
  upstream.end();
}

module.exports = { forward };
