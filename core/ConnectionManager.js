/**
 * Connection Manager
 * Handles networking concerns (HTTP, WebSocket, connection management)
 */

const { httpGet, WebSocketClient } = require("../utils/web-client");
const {
  encodeOSCBinary,
  parseOSCBinary,
} = require("../utils/osc-binary-codec");

/**
 * Connection Manager Class
 * Manages HTTP and WebSocket connections
 */
class ConnectionManager {
  constructor(state, parameterManager, callbacks = {}) {
    this.state = state;
    this.parameterManager = parameterManager;
    this.wsClient = null;
    this.callbacks = {
      onConnected: callbacks.onConnected || (() => {}),
      onDisconnected: callbacks.onDisconnected || (() => {}),
      onParameterChange: callbacks.onParameterChange || (() => {}),
      onParameterList: callbacks.onParameterList || (() => {}),
      onParameterSent: callbacks.onParameterSent || (() => {}),
      onError: callbacks.onError || (() => {}),
      onLog: callbacks.onLog || (() => {}),
    };
  }

  /**
   * Update a parameter value in paramsDict
   */
  updateParameterValue(path, value) {
    if (!this.state.paramsDict || !this.state.paramsDict.params) {
      return false;
    }

    // Parse path and update nested structure
    const pathParts = path.replace(/^\//, "").split("/").filter(Boolean);

    if (pathParts.length === 0) {
      return false;
    }

    // Navigate to the parameter and update its value
    let current = this.state.paramsDict.params;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!current[part]) {
        return false;
      }
      current = current[part];
    }

    const lastPart = pathParts[pathParts.length - 1];
    if (current[lastPart]) {
      // Update the value
      current[lastPart].value = value;
      return true;
    }

    return false;
  }

  /**
   * Connect to OSCQuery server
   */
  async connect(url) {
    if (this.state.connected) {
      this.disconnect();
    }

    try {
      const normalizedUrl = url.replace(/\/$/, "");
      this.state.baseUrl = normalizedUrl;

      this.callbacks.onLog(`Connecting to ${normalizedUrl}...`);

      // Fetch namespace
      const namespace = await httpGet(normalizedUrl, this.state.timeout);
      this.state.namespace = namespace;

      let hostInfo = null;
      try {
        hostInfo = await httpGet(
          `${normalizedUrl}?HOST_INFO`,
          this.state.timeout
        );
        this.state.hostInfo = hostInfo;
      } catch (e) {
        this.callbacks.onLog(
          "HOST_INFO not available, WebSocket may not be supported"
        );
      }

      // Parse and output parameter list
      const parameters = this.parameterManager.parseNamespace(namespace);
      const paramsDict = this.parameterManager.buildParameterList(parameters);
      this.state.paramsDict = paramsDict;
      this.callbacks.onParameterList(paramsDict);

      // Connect WebSocket if available
      if (hostInfo && hostInfo.EXTENSIONS && hostInfo.EXTENSIONS.LISTEN) {
        const wsUrl = hostInfo.WS_URL || normalizedUrl.replace(/^http/, "ws");
        await this.connectWebSocket(wsUrl);
        // Connection state is set inside connectWebSocket after WebSocket opens
      } else {
        this.callbacks.onLog("WebSocket not supported by server");
        this.state.connected = true; // Still connected via HTTP
        this.callbacks.onConnected();
        this.callbacks.onLog("Connected successfully (HTTP only)");
      }
    } catch (error) {
      this.callbacks.onLog(`Connection error: ${error.message}`);
      this.callbacks.onError(error);
      this.state.connected = false;
      this.callbacks.onDisconnected();
      throw error;
    }
  }

  /**
   * Send LISTEN command for a parameter path
   */
  sendListenCommand(path) {
    if (!this.wsClient) {
      throw new Error("WebSocket not connected");
    }
    this.wsClient.send(
      JSON.stringify({
        COMMAND: "LISTEN",
        DATA: path,
      })
    );
  }

  /**
   * Set up LISTEN commands for all parameters
   */
  setupListenCommands() {
    const namespace = this.state.namespace;
    if (!namespace) return;

    const parameters = this.parameterManager.parseNamespace(namespace);
    this.callbacks.onLog(
      `Setting up LISTEN for ${parameters.length} parameters`
    );

    parameters.forEach((param) => {
      try {
        this.sendListenCommand(param.path);
      } catch (sendError) {
        this.callbacks.onLog(
          `Error sending LISTEN for ${param.path}: ${sendError.message}`
        );
      }
    });
  }

  /**
   * Parse WebSocket message data
   */
  parseWebSocketMessage(data) {
    // Handle ArrayBuffer (from native WebSocket binary messages)
    if (data instanceof ArrayBuffer) {
      data = Buffer.from(data);
    }
    // Handle Uint8Array (another possible format from native WebSocket)
    else if (data instanceof Uint8Array) {
      data = Buffer.from(data);
    }
    // Note: Blob is handled in createMessageHandler since it requires async conversion

    if (Buffer.isBuffer(data)) {
      const parsed = parseOSCBinary(data);
      if (parsed) {
        return { type: "osc", ...parsed };
      }
      try {
        return { type: "json", data: JSON.parse(data.toString("utf8")) };
      } catch (e) {
        return null;
      }
    }

    if (typeof data === "string") {
      try {
        return { type: "json", data: JSON.parse(data) };
      } catch (e) {
        // If it's not valid JSON, treat as plain text
        return null;
      }
    }

    return null;
  }

  /**
   * Handle JSON message from WebSocket
   */
  handleJSONMessage(messageData) {
    this.callbacks.onLog(
      "handleJSONMessage:",
      JSON.stringify(messageData, null, 2)
    );
    if (messageData.PATH && messageData.VALUE !== undefined) {
      const updated = this.updateParameterValue(
        messageData.PATH,
        messageData.VALUE
      );
      if (updated) {
        this.callbacks.onParameterChange(messageData.PATH, messageData.VALUE);
      }
    } else if (messageData.COMMAND === "LISTEN" && messageData.DATA) {
      this.callbacks.onLog(`Listening to ${messageData.DATA}`);
    }
  }

  /**
   * Handle WebSocket message
   */
  handleWebSocketMessage(message) {
    if (message.type === "osc") {
      const updated = this.updateParameterValue(message.PATH, message.VALUE);
      if (updated) {
        this.callbacks.onParameterChange(message.PATH, message.VALUE);
      }
      return;
    }

    if (message.type === "json") {
      this.handleJSONMessage(message.data);
    }
  }

  /**
   * Create message handler for WebSocket
   */
  createMessageHandler() {
    return async (data) => {
      // Convert various formats to Buffer if needed (native WebSocket can send different types)
      let processedData = data;
      let dataInfo;

      if (data instanceof Blob) {
        // Blob needs to be converted via arrayBuffer() which is async
        try {
          const arrayBuffer = await data.arrayBuffer();
          processedData = Buffer.from(arrayBuffer);
          dataInfo = `Blob(${data.size} bytes): ${processedData
            .slice(0, 16)
            .toString("hex")}${data.size > 16 ? "..." : ""}`;
        } catch (e) {
          this.callbacks.onLog(`Error converting Blob to Buffer: ${e.message}`);
          return;
        }
      } else if (data instanceof ArrayBuffer) {
        processedData = Buffer.from(data);
        dataInfo = `ArrayBuffer(${data.byteLength} bytes): ${processedData
          .slice(0, 16)
          .toString("hex")}${data.byteLength > 16 ? "..." : ""}`;
      } else if (data instanceof Uint8Array) {
        processedData = Buffer.from(data);
        dataInfo = `Uint8Array(${data.length} bytes): ${processedData
          .slice(0, 16)
          .toString("hex")}${data.length > 16 ? "..." : ""}`;
      } else if (Buffer.isBuffer(data)) {
        dataInfo = `Buffer(${data.length} bytes): ${data
          .slice(0, 16)
          .toString("hex")}${data.length > 16 ? "..." : ""}`;
      } else if (typeof data === "string") {
        dataInfo = `String(${data.length}): ${data.substring(0, 100)}${
          data.length > 100 ? "..." : ""
        }`;
      } else {
        // Try to get more info about the object
        const constructorName = data?.constructor?.name || "Unknown";
        dataInfo = `${typeof data} (${constructorName})`;
        // Try to inspect the object
        if (data && typeof data === "object") {
          try {
            const keys = Object.keys(data);
            dataInfo += ` with keys: [${keys.join(", ")}]`;
          } catch (e) {
            // Ignore if we can't get keys
          }
        }
      }

      try {
        const message = this.parseWebSocketMessage(processedData);
        if (!message) {
          this.callbacks.onLog("Failed to parse WebSocket message");
          return;
        }

        this.handleWebSocketMessage(message);
      } catch (error) {
        this.callbacks.onLog(
          `Error processing WebSocket message: ${error.message}`,
          error.stack
        );
      }
    };
  }

  /**
   * Create connection handlers for WebSocket
   */
  createConnectionHandlers() {
    return {
      onOpen: () => {
        this.state.connected = true;
        this.callbacks.onConnected();
        this.callbacks.onLog("Connected successfully");
        this.setupListenCommands();
      },
      onMessage: this.createMessageHandler(),
      onError: (error) => {
        this.state.connected = false;
        this.callbacks.onDisconnected();
        this.callbacks.onError(error);
      },
      onClose: (code, reason) => {
        if (this.state.connected) {
          this.state.connected = false;
          this.callbacks.onDisconnected(true); // Pass true to indicate disconnect bang
        }
      },
    };
  }

  /**
   * Connect WebSocket
   */
  connectWebSocket(wsUrl) {
    const handlers = this.createConnectionHandlers();

    this.wsClient = new WebSocketClient({
      timeout: this.state.timeout,
      logger: (message, ...args) => this.callbacks.onLog(message, ...args),
      ...handlers,
    });

    return this.wsClient.connect(wsUrl);
  }

  /**
   * Disconnect from server
   */
  disconnect() {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }

    // Clear timeout timer
    if (this.state.timeoutTimer) {
      clearTimeout(this.state.timeoutTimer);
      this.state.timeoutTimer = null;
    }

    // Reset state
    const wasConnected = this.state.connected;
    this.state.baseUrl = null;
    this.state.hostInfo = null;
    this.state.namespace = null;
    this.state.paramsDict = null;
    this.state.connected = false;

    if (wasConnected) {
      this.callbacks.onDisconnected(true); // Pass true to indicate disconnect bang
    } else {
      this.callbacks.onDisconnected();
    }

    this.callbacks.onLog("Disconnected");
  }

  /**
   * Validate OSC packet
   */
  validateOSCPacket(packet) {
    if (!Buffer.isBuffer(packet)) {
      throw new Error("OSC encoding failed: result is not a Buffer");
    }
    if (packet.length === 0) {
      throw new Error("OSC encoding failed: empty packet");
    }
  }

  /**
   * Validate connection state
   */
  validateConnection() {
    if (!this.state.baseUrl) {
      throw new Error("Not connected");
    }
    if (!this.wsClient || !this.wsClient.isConnected()) {
      throw new Error(
        "WebSocket is not connected. Please ensure the WebSocket connection is established before setting values."
      );
    }
  }

  /**
   * Validate and encode parameter value
   */
  validateAndEncode(normalizedPath, valueArray) {
    const oscTypeInfo = this.parameterManager.getTypeInfo(
      normalizedPath,
      normalizedPath
    );

    if (!oscTypeInfo) {
      throw new Error(
        `Type information not available for ${normalizedPath}. Cannot send without exact type validation.`
      );
    }

    const validation = this.parameterManager.validateValueFormat(
      valueArray,
      oscTypeInfo
    );
    if (!validation.valid) {
      throw new Error(
        `Type validation failed for ${normalizedPath}: ${validation.error}`
      );
    }

    const oscPacket = encodeOSCBinary(normalizedPath, valueArray, oscTypeInfo);
    this.validateOSCPacket(oscPacket);

    return oscPacket;
  }

  /**
   * Set parameter value via WebSocket
   */
  setParameter(path, ...args) {
    this.validateConnection();

    const valueArray = this.parameterManager.convertToValueArray(args);
    const normalizedPath = this.parameterManager.normalizePath(path);

    try {
      const oscPacket = this.validateAndEncode(normalizedPath, valueArray);
      this.wsClient.send(oscPacket);

      const sentObject = { path: path, value: valueArray };
      this.callbacks.onParameterSent(sentObject);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.callbacks.onLog(
        `Failed to send value via WebSocket for ${path}: ${errorMessage}`
      );
      throw new Error(`Failed to send value via WebSocket: ${errorMessage}`);
    }
  }

  /**
   * Request parameter list refresh
   */
  async refreshList() {
    if (!this.state.connected || !this.state.baseUrl) {
      this.callbacks.onLog("Not connected");
      return;
    }

    try {
      const namespace = await httpGet(this.state.baseUrl, this.state.timeout);
      this.state.namespace = namespace;
      const parameters = this.parameterManager.parseNamespace(namespace);
      const paramsDict = this.parameterManager.buildParameterList(parameters);
      this.state.paramsDict = paramsDict;
      this.callbacks.onParameterList(paramsDict);
      this.callbacks.onLog("Parameter list refreshed");
    } catch (error) {
      this.callbacks.onLog(`Error refreshing list: ${error.message}`);
    }
  }
}

module.exports = ConnectionManager;
