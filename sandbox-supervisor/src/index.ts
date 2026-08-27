import { initPool } from './pool.js';
import { createSupervisorApp } from './api.js';

const PORT = parseInt(process.env['SUPERVISOR_PORT'] ?? '3001', 10);

async function main(): Promise<void> {
  await initPool();

  const app = createSupervisorApp();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[supervisor] listening on port ${PORT}`);
  });
}

main().catch(err => {
  console.error('[supervisor] fatal startup error:', err);
  process.exit(1);
});
