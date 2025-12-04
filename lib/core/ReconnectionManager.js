/**
 * Reconnection Manager
 * Handles automatic reconnection logic with timeout protection
 */

class ReconnectionManager {
  constructor(state, connectionManager, callbacks = {}) {
    this.state = state;
    this.connectionManager = connectionManager;
    this.callbacks = {
      onLog: callbacks.onLog || (() => {}),
    };
    this.reconnectTimer = null;
    this.connectionTimeoutId = null;
  }

  /**
   * Check if reconnection should be attempted
   */
  shouldReconnect() {
    return (
      this.state.autoreconnect &&
      !this.state.manualDisconnect &&
      this.state.baseUrl &&
      !this.state.connected &&
      !this.state.isReconnecting &&
      !this.reconnectTimer
    );
  }

  /**
   * Schedule a reconnection attempt after the configured interval
   */
  schedule() {
    if (!this.shouldReconnect()) {
      return;
    }

    this.callbacks.onLog(
      "Scheduling reconnect in",
      this.state.reconnectInterval,
      "ms"
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attempt();
    }, this.state.reconnectInterval);
  }

  /**
   * Attempt a single reconnection with timeout protection
   */
  attempt() {
    if (!this.shouldReconnect()) {
      this.state.isReconnecting = false;
      this.clear();
      return;
    }

    this.state.isReconnecting = true;

    // Validate baseUrl before attempting
    if (!this.state.baseUrl) {
      this.state.isReconnecting = false;
      this.callbacks.onLog("Reconnect: baseUrl is missing, cannot reconnect");
      return;
    }

    this.callbacks.onLog("Attempting reconnect to", this.state.baseUrl);

    const connectionTimeout = Math.max(this.state.timeout * 2, 10000);
    let connectionCompleted = false;

    // Set up timeout to handle hanging connections
    this.connectionTimeoutId = setTimeout(() => {
      if (!connectionCompleted) {
        connectionCompleted = true;
        this.state.isReconnecting = false;
        this.callbacks.onLog(
          "Reconnect: timeout after",
          connectionTimeout,
          "ms"
        );
        // Schedule next attempt
        this.schedule();
      }
    }, connectionTimeout);

    // Attempt connection (fire and forget - callbacks handle success/failure)
    this.connectionManager
      .connect(this.state.baseUrl)
      .then(() => {
        // Connection succeeded - clear timeout if not already triggered
        if (!connectionCompleted) {
          connectionCompleted = true;
          if (this.connectionTimeoutId) {
            clearTimeout(this.connectionTimeoutId);
            this.connectionTimeoutId = null;
          }
          this.callbacks.onLog("Reconnect: connection succeeded");
          // Keep isReconnecting = true until onConnected callback clears it
        }
      })
      .catch((error) => {
        // Connection failed - clear timeout if not already triggered
        if (!connectionCompleted) {
          connectionCompleted = true;
          if (this.connectionTimeoutId) {
            clearTimeout(this.connectionTimeoutId);
            this.connectionTimeoutId = null;
          }
          this.state.isReconnecting = false;
          this.callbacks.onLog(
            "Reconnect: connection failed",
            this.state.baseUrl,
            "error:",
            error.message || String(error)
          );
          // Ensure baseUrl is preserved for next attempt
          if (!this.state.baseUrl) {
            this.callbacks.onLog(
              "Reconnect: baseUrl was cleared, stopping reconnection"
            );
            return;
          }
          // Schedule next attempt
          this.schedule();
        }
      });
  }

  /**
   * Clear all timers and reset state
   */
  clear() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectionTimeoutId) {
      clearTimeout(this.connectionTimeoutId);
      this.connectionTimeoutId = null;
    }
    this.state.isReconnecting = false;
  }

  /**
   * Stop reconnection attempts
   */
  stop() {
    this.clear();
  }

  /**
   * Update reconnect interval
   */
  setInterval(ms) {
    this.state.reconnectInterval = parseInt(ms, 10) || 3000;
  }
}

module.exports = ReconnectionManager;
