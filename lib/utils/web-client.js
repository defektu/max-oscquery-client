/**
 * Web Client for OSCQuery
 * Handles HTTP and WebSocket communication
 * Uses ws package for WebSocket support
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

// Use ws package for WebSocket (native WebSocket disabled)
let WebSocket;
let useNativeWebSocket = false;

// Use ws library for WebSocket support
try {
  WebSocket = require("ws");
} catch (e) {
  throw new Error(
    "WebSocket not available. Please install the 'ws' package: npm install ws"
  );
}

/**
 * HTTP GET helper
 */
function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === "https:";
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    };

    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

/**
 * WebSocket Client for OSCQuery
 */
class WebSocketClient {
  constructor(options = {}) {
    this.wsConnection = null;
    this.timeout = options.timeout || 5000;
    this.onOpen = options.onOpen || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onError = options.onError || (() => {});
    this.onClose = options.onClose || (() => {});
    this.logger = options.logger || (() => {});
  }

  /**
   * Connect to WebSocket server
   */
  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      // Track if we've resolved/rejected to prevent multiple calls
      let resolved = false;

      try {
        this.logger(`Connecting WebSocket to ${wsUrl}...`);
        this.wsConnection = new WebSocket(wsUrl);

        // Set timeout for connection
        const connectionTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.wsConnection.close();
            const error = new Error("WebSocket connection timeout");
            this.logger("WebSocket connection timeout");
            reject(error);
          }
        }, this.timeout);

        // Use the appropriate API based on WebSocket type
        if (useNativeWebSocket) {
          // Native WebSocket API (Node.js v21+)
          this.wsConnection.addEventListener("open", () => {
            if (resolved) return;
            clearTimeout(connectionTimeout);
            resolved = true;

            this.logger("WebSocket connected");
            this.onOpen();
            resolve();
          });

          this.wsConnection.addEventListener("message", (event) => {
            this.onMessage(event.data);
          });

          this.wsConnection.addEventListener("error", (error) => {
            if (resolved) return;
            clearTimeout(connectionTimeout);
            resolved = true;

            // Native WebSocket error can be an Error object or Event object
            const err =
              error instanceof Error
                ? error
                : error.error || new Error("WebSocket error");
            this.logger("WebSocket error:", err.message || err);
            this.onError(err);
            reject(err);
          });

          this.wsConnection.addEventListener("close", (event) => {
            clearTimeout(connectionTimeout);
            const code = event.code;
            const reason = event.reason;

            if (resolved) {
              // Only output disconnect if we were previously connected
              this.logger(
                `WebSocket closed (code: ${code}, reason: ${reason || "none"})`
              );
              this.onClose(code, reason);
            } else {
              // Connection closed before opening (connection failed)
              resolved = true;
              const error = new Error(
                `WebSocket closed before opening (code: ${code})`
              );
              this.logger("WebSocket connection failed");
              this.onError(error);
              reject(error);
            }
          });
        } else {
          // ws library API
          this.wsConnection.on("open", () => {
            if (resolved) return;
            clearTimeout(connectionTimeout);
            resolved = true;

            this.logger("WebSocket connected");
            this.onOpen();
            resolve();
          });

          this.wsConnection.on("message", (data) => {
            this.onMessage(data);
          });

          this.wsConnection.on("error", (error) => {
            if (resolved) return;
            clearTimeout(connectionTimeout);
            resolved = true;

            this.logger("WebSocket error:", error.message || error);
            this.onError(error);
            reject(error);
          });

          this.wsConnection.on("close", (code, reason) => {
            clearTimeout(connectionTimeout);

            if (resolved) {
              // Only output disconnect if we were previously connected
              this.logger(
                `WebSocket closed (code: ${code}, reason: ${reason || "none"})`
              );
              this.onClose(code, reason);
            } else {
              // Connection closed before opening (connection failed)
              resolved = true;
              const error = new Error(
                `WebSocket closed before opening (code: ${code})`
              );
              this.logger("WebSocket connection failed");
              this.onError(error);
              reject(error);
            }
          });
        }
      } catch (error) {
        if (!resolved) {
          resolved = true;
          this.logger("Error creating WebSocket:", error.message);
          this.onError(error);
          reject(error);
        }
      }
    });
  }

  /**
   * Send data via WebSocket
   */
  send(data) {
    if (!this.wsConnection) {
      throw new Error("WebSocket not connected");
    }

    // Check readyState - both native and ws library use the same constants
    const OPEN = WebSocket.OPEN || 1;
    if (this.wsConnection.readyState !== OPEN) {
      throw new Error("WebSocket is not open");
    }

    this.wsConnection.send(data);
  }

  /**
   * Close WebSocket connection
   */
  close() {
    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected() {
    if (!this.wsConnection) {
      return false;
    }
    // Native WebSocket uses constants: WebSocket.OPEN = 1
    // ws library also uses WebSocket.OPEN
    const OPEN = WebSocket.OPEN || 1;
    return this.wsConnection.readyState === OPEN;
  }
}

module.exports = {
  httpGet,
  WebSocketClient,
};
