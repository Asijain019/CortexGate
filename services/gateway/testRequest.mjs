import fetch from 'node-fetch';

const body = {
  model: 'gemini',
  messages: [{ role: 'user', content: 'Who is the prime minister of India?' }]
};

fetch('http://localhost:3002/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})
  .then(res => {
    console.log('Status:', res.status);
    return res.json();
  })
  .then(data => {
    console.log('Response:', JSON.stringify(data, null, 2));
  })
  .catch(err => console.error('Error:', err));
