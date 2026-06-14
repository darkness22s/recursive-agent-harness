import { nanoid } from "nanoid";
import type { AppUpdatePackage, HarnessConfig } from "./types.js";

export async function deliverAppUpdate(config: HarnessConfig, update: AppUpdatePackage): Promise<AppUpdatePackage> {
  const saved: AppUpdatePackage = {
    ...update,
    id: update.id ?? nanoid(),
    appId: update.appId ?? config.appId,
    channel: update.channel ?? config.updates?.channel ?? "default",
    createdAt: update.createdAt ?? new Date().toISOString()
  };

  if (!config.updates?.webhookUrl) {
    return saved;
  }

  const response = await fetch(config.updates.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.updates.apiKey ? { authorization: `Bearer ${config.updates.apiKey}` } : {})
    },
    body: JSON.stringify(saved)
  });

  if (!response.ok) {
    throw new Error(`Update delivery failed: ${response.status} ${await response.text()}`);
  }

  return saved;
}
