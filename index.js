const http = require('http');
const url = require('url');

const VERIFY_TOKEN = 'imbrige2024';

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
    res.writeHead(200);
    res.end('OK');
  }
});

server.listen(process.env.PORT || 3000);
