import express from 'express';
import dotenv from 'dotenv';
import chatRouter from './routes/chat.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

app.use('/v1/chat', chatRouter);

app.listen(PORT, () => {
  console.log(`CortexGate Gateway listening on port ${PORT}`);
});

export default app;
