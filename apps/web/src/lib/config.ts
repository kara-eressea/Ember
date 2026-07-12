// Runtime branding config (decisions.md §5): the build contains no product
// name. The serving Fastify injects `window.__CONFIG__` into index.html
// (M1 step 11); until then we fall back to fetching /config.json and finally
// to the working title.

export interface RuntimeConfig {
  appName: string;
}

declare global {
  interface Window {
    __CONFIG__?: RuntimeConfig;
  }
}

const FALLBACK: RuntimeConfig = { appName: "Emberline" };

let config: RuntimeConfig = FALLBACK;

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (window.__CONFIG__) {
    config = { ...FALLBACK, ...window.__CONFIG__ };
    return config;
  }
  try {
    const response = await fetch("/config.json");
    if (response.ok) {
      config = { ...FALLBACK, ...((await response.json()) as RuntimeConfig) };
    }
  } catch {
    // Dev server without a config endpoint — the fallback stands.
  }
  return config;
}

export function appConfig(): RuntimeConfig {
  return config;
}
