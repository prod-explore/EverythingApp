import * as readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { McpConnection } from './mcp-client.js';
import { ToolRegistry } from './tool-registry.js';
import { ApprovalGate } from './approval.js';
import { runTurn } from './anthropic-loop.js';
import { loadHistory, saveHistory, clearHistory, historyPath } from './history-store.js';
import { loadPendingBatches, savePendingBatches } from './batch-store.js';
import { submitBatch, checkBatch } from './batch.js';
import { UsageTracker } from './usage-tracker.js';

const SYSTEM_PROMPT = `Jesteś osobistym asystentem Mikołaja w EverythingApp — jego self-hosted, BYOK
systemie AI. Masz dostęp do narzędzi wystawionych przez podłączone serwery MCP (sandbox
deweloperski z bash/git, i/lub jego Vault Obsidian). Każde wywołanie narzędzia z efektem
ubocznym przechodzi przez Approval Gate — jeśli zostanie odrzucone, poinformuj o tym
użytkownika i zaproponuj alternatywę zamiast ponawiać to samo wywołanie w kółko. Odpowiadaj
po polsku, konkretnie, bez zbędnego lania wody.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  const connections = config.mcpServers.map(cfg => new McpConnection(cfg));
  for (const conn of connections) {
    try {
      await conn.connect();
      console.log(`[mcp] połączono z '${conn.name}'`);
    } catch (err) {
      console.error(`[mcp] nie udało się połączyć z '${conn.name}':`, (err as Error).message);
    }
  }

  const registry = new ToolRegistry(config.autoApproveTools);
  await registry.loadFrom(connections);
  const toolCount = registry.toAnthropicTools().length;
  console.log(
    `[tools] załadowano ${toolCount} narzędzi z MCP` +
      (config.webSearchEnabled ? ' + web_search' : ' (web_search wyłączony)'),
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const approvalGate = new ApprovalGate(rl);
  const usageTracker = new UsageTracker();
  const serverTools: Anthropic.ToolUnion[] = config.webSearchEnabled
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    : [];
  let history: Anthropic.MessageParam[] = await loadHistory();
  if (history.length > 0) {
    console.log(`[history] wczytano ${history.length} wiadomości z poprzedniej sesji (${historyPath()})`);
  }

  console.log("\nGotowe. Pisz wiadomości, '/clear' żeby wyczyścić historię, '/schedule <wiadomość>'\n" +
    "żeby wysłać jako batch (taniej, bez narzędzi, wynik później), '/batches' żeby sprawdzić\n" +
    "oczekujące batch'e, '/usage' żeby zobaczyć zużycie/koszt sesji, 'exit' żeby zakończyć.\n");

  async function resolvePendingBatches(): Promise<void> {
    const pending = await loadPendingBatches();
    if (pending.length === 0) return;

    const stillPending = [];
    for (const entry of pending) {
      let resolution;
      try {
        resolution = await checkBatch(anthropic, entry);
      } catch (err) {
        console.error(`[batch] błąd sprawdzania ${entry.batchId}:`, (err as Error).message);
        stillPending.push(entry);
        continue;
      }
      if (!resolution) {
        stillPending.push(entry);
        continue;
      }
      if (resolution.status === 'succeeded' && resolution.text) {
        console.log(`\n[batch] gotowe (zlecono: "${entry.preview}"):`);
        console.log(`claude> ${resolution.text}\n`);
        history.push({ role: 'assistant', content: resolution.text });
        await saveHistory(history);
      } else {
        console.log(
          `\n[batch] "${entry.preview}" zakończone ze statusem '${resolution.status}'` +
            (resolution.errorDetail ? `: ${resolution.errorDetail}` : ''),
        );
      }
    }
    await savePendingBatches(stillPending);
  }

  await resolvePendingBatches();

  try {
    for (;;) {
      const userText = await rl.question('ty> ');
      const trimmed = userText.trim().toLowerCase();
      if (['exit', 'quit', ':q'].includes(trimmed)) break;
      if (trimmed === '/clear') {
        history = [];
        await clearHistory();
        console.log('[history] wyczyszczono');
        continue;
      }
      if (trimmed === '/batches') {
        await resolvePendingBatches();
        const pending = await loadPendingBatches();
        console.log(pending.length === 0 ? '[batch] brak oczekujących' : `[batch] wciąż w toku: ${pending.length}`);
        continue;
      }
      if (trimmed === '/usage') {
        console.log(`[usage] ${usageTracker.summary()}`);
        continue;
      }
      if (userText.trim().startsWith('/schedule ')) {
        const scheduledText = userText.trim().slice('/schedule '.length);
        try {
          const entry = await submitBatch(anthropic, config.model, SYSTEM_PROMPT, history, scheduledText);
          history.push({ role: 'user', content: scheduledText });
          await saveHistory(history);
          const pending = await loadPendingBatches();
          await savePendingBatches([...pending, entry]);
          console.log(
            `[batch] zakolejkowano (id: ${entry.batchId}). Bez narzędzi, wynik zwykle w 1-6h (do 24h).\n` +
              `Sprawdzę automatycznie przy starcie CLI, albo wpisz '/batches'.`,
          );
        } catch (err) {
          console.error('[batch] nie udało się zakolejkować:', (err as Error).message);
        }
        continue;
      }
      if (!userText.trim()) continue;

      history = await runTurn(
        {
          anthropic,
          model: config.model,
          tools: registry,
          systemPrompt: SYSTEM_PROMPT,
          serverTools,
          confirm: (label, args) => approvalGate.confirm(label, args),
          onAssistantText: text => process.stdout.write(`\nclaude> ${text}\n`),
          onToolStart: label => console.log(`[tool] wykonuję: ${label}`),
          onUsage: usage => {
            const cost = usageTracker.record(usage);
            console.log(`[usage] ta odpowiedź: ≈$${cost.toFixed(4)} | ${usageTracker.summary()}`);
          },
        },
        history,
        userText,
      );
      await saveHistory(history);
    }
  } finally {
    rl.close();
    await Promise.all(connections.map(c => c.close()));
  }
}

main().catch(err => {
  console.error('[cli] fatal error:', err);
  process.exit(1);
});
