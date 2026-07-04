const { WebSocketManager } = require("@discordjs/ws");
const { Routes } = require("discord-api-types/v10");

const RETRYABLE_GATEWAY_STATUSES = new Set([429, 500, 502, 503, 504]);
const GATEWAY_BOT_TIMEOUT_MS = 20_000;

function installDiscordGatewayFallback() {
  const prototype = WebSocketManager?.prototype;

  if (!prototype || prototype.__ultronGatewayFallbackInstalled) {
    return;
  }

  const originalFetchGatewayInformation = prototype.fetchGatewayInformation;

  prototype.fetchGatewayInformation = async function fetchGatewayInformationWithFallback(force = false) {
    try {
      return await withTimeout(
        originalFetchGatewayInformation.call(this, force),
        GATEWAY_BOT_TIMEOUT_MS
      );
    } catch (error) {
      const status = Number(error?.status ?? error?.code);

      if (error?.code !== "GATEWAY_BOT_TIMEOUT" && !RETRYABLE_GATEWAY_STATUSES.has(status)) {
        throw error;
      }

      console.warn(
        `[Discord] /gateway/bot fallo (${error?.code || `status ${status}`}); usando /gateway como fallback temporal.`
      );

      const gateway = await this.options.rest.get(Routes.gateway());
      const data = {
        url: gateway.url,
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: 1000,
          reset_after: 5000,
          max_concurrency: 1
        }
      };

      this.gatewayInformation = {
        data,
        expiresAt: Date.now() + 5000
      };

      return data;
    }
  };

  prototype.__ultronGatewayFallbackInstalled = true;
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error(`/gateway/bot no respondio en ${timeoutMs}ms`);
      error.code = "GATEWAY_BOT_TIMEOUT";
      reject(error);
    }, timeoutMs);

    promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

module.exports = { installDiscordGatewayFallback };
