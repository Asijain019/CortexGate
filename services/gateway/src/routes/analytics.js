// GET /v1/analytics?range=15m|1h|24h|7d (default 1h). Shape: see CONTRACT2 / stats/analytics.js.
import { Router } from 'express';
import { getAnalytics, RANGES } from '../stats/analytics.js';

const router = Router();

router.get('/', async (req, res) => {
  const range = String(req.query.range || '1h');
  if (!RANGES[range]) {
    return res.status(400).json({ error: { message: `Invalid range '${range}'; use one of ${Object.keys(RANGES).join(', ')}` } });
  }
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getAnalytics(range));
  } catch (err) {
    console.warn(`[Analytics] ${err.message}`);
    res.status(500).json({ error: { message: 'Could not compute analytics' } });
  }
});

export default router;
