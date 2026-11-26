const http = require('http');
const data = JSON.stringify({
  model: 'gemini',
  messages: [{ role: 'user', content: 'Who is the prime minister of India?' }]
});

const options = {
  hostname: 'localhost',
  port: 3002,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = http.request(options, (res) => {
  let raw = '';
  res.on('data', (chunk) => raw += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Body:', raw);
  });
});

req.on('error', (e) => console.error(e));
req.write(data);
req.end();
