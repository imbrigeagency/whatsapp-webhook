const http = require('http');
const https = require('https');
const url = require('url');

const VERIFY_TOKEN = 'imbrige2024';
const MAKE_WEBHOOK_URL = 'https://hook.us2.make.com/uyw1gqarup6sxoth24oa0q0vjjdw444v';

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const query = parsed.query;

  if (req.method === 'GET') {
    if (
      query['hub.mode'] === 'subscribe' &&
      query['hub.verify_token'] === VERIFY_TOKEN
    ) {
      res.writeHead(200);
      res.end(query['hub.challenge']);
    } else {
      res.writeHead(403);
      res.end('Forbidden');
    }
  } else if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const makeUrl = new URL(MAKE_WEBHOOK_URL);
      const options = {
        hostname: makeUrl.hostname,
        path: makeUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const proxyReq = https.request(options);
      proxyReq.write(body);
      proxyReq.end();
      res.writeHead(200);
      res.end('OK');
    });
  }
});

server.listen(process.env.PORT || 3000, '0.0.0.0');
