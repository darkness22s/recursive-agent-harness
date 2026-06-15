const runtimeUrl = requiredEnv("RECURSIVE_RUNTIME_URL");
const apiKey = requiredEnv("RECURSIVE_HARNESS_API_KEY");
const appId = process.env.RECURSIVE_HARNESS_APP_ID ?? "recursive-harness";
const workerId = process.env.RECURSIVE_AGENT_WORKER_ID ?? process.env.RECURSIVE_LOCAL_WORKER_ID ?? "sparky-vps";
const intervalMs = Number(process.env.RECURSIVE_AGENT_INTERVAL_MS ?? 30 * 60 * 1000);
const once = process.env.RECURSIVE_AGENT_ONCE === "1";

async function runCycle(): Promise<void> {
  const response = await fetch(`${runtimeUrl}/v1/agents/recursive-improvement-cycle`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      config: {
        appId,
        runtimeUrl,
        apiKey,
        optimization: "retention",
        autonomy: "full",
        model: { provider: "ollama" },
        agents: {
          workerId,
          autoQueueUpgrades: true
        },
        updates: process.env.RECURSIVE_UPDATE_WEBHOOK_URL
          ? {
              webhookUrl: process.env.RECURSIVE_UPDATE_WEBHOOK_URL,
              apiKey: process.env.RECURSIVE_UPDATE_API_KEY,
              channel: process.env.RECURSIVE_UPDATE_CHANNEL ?? "production"
            }
          : undefined,
        search: process.env.TINYFISH_API_KEY
          ? {
              enabled: true,
              provider: "tinyfish",
              mode: "freshness"
            }
          : undefined
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Recursive agent cycle failed: ${response.status} ${await response.text()}`);
  }
  console.log(JSON.stringify(await response.json()));
}

do {
  await runCycle();
  if (once) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
} while (true);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
