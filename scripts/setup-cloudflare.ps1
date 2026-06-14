param(
  [string]$RuntimeKey,
  [string]$OllamaApiKey
)

Write-Host "1. Create a free Cloudflare KV namespace for harness state:"
Write-Host "   npx wrangler kv namespace create HARNESS_STATE"
Write-Host ""
Write-Host "2. Copy the returned namespace id into wrangler.jsonc."
Write-Host ""
if ($RuntimeKey) {
  $env:RECURSIVE_HARNESS_API_KEY = $RuntimeKey
  Write-Host "3. Set the runtime auth secret:"
  Write-Host "   `$env:RECURSIVE_HARNESS_API_KEY | npx wrangler secret put RECURSIVE_HARNESS_API_KEY"
} else {
  Write-Host "3. Set the runtime auth secret:"
  Write-Host "   npx wrangler secret put RECURSIVE_HARNESS_API_KEY"
}
if ($OllamaApiKey) {
  $env:OLLAMA_API_KEY = $OllamaApiKey
  Write-Host "4. Set the Ollama Cloud secret:"
  Write-Host "   `$env:OLLAMA_API_KEY | npx wrangler secret put OLLAMA_API_KEY"
} else {
  Write-Host "4. Set the Ollama Cloud secret:"
  Write-Host "   npx wrangler secret put OLLAMA_API_KEY"
}
Write-Host ""
Write-Host "5. Deploy:"
Write-Host "   npm run deploy:cloudflare"
