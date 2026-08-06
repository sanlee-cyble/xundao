export async function callModelWithFallback({
  primary,
  fallback,
  providers,
  request,
  attempts = 2,
  onAttempt = () => {},
}) {
  const order = [...new Set([primary, fallback].filter(Boolean))];
  let lastError = null;
  for (const providerName of order) {
    const provider = providers[providerName];
    if (!provider) continue;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        onAttempt({ provider: providerName, attempt, status: "started" });
        const result = await provider(request);
        onAttempt({ provider: providerName, attempt, status: "succeeded" });
        return result;
      } catch (error) {
        lastError = error;
        onAttempt({ provider: providerName, attempt, status: "failed", error: error.message });
      }
    }
  }
  throw lastError || new Error("没有可用模型");
}
