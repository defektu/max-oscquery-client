/**
 * Max/MSP OSCQuery Client
 * A node.script-based external object for connecting to OSCQuery servers
 *
 * Usage in Max:
 *   [node.script oscquery.client.js]
 *   |
 *   [route param change state disconnect]
 *   |
 *   [param( [outlet 0]  // Parameter list
 *   [change( [outlet 1]  // Parameter changes
 *   [state( [outlet 2]  // Connection state
 *   [disconnect( [outlet 3]  // Disconnect bang
 *
 * Note: node.script has only 1 output edge. Data is sent with routing tags:
 *   - "param" for parameter list (outlet 0)
 *   - "change" for parameter changes (outlet 1)
 *   - "state" for connection state (outlet 2)
 *   - "disconnect" for disconnect bang (outlet 3)
 *
 * Inlets: 1 (all messages)
 * Outlets: 1 (with routing tags - use [route] to split)
 */

const maxAPI = require("max-api");

// Import utilities
const {
  parseNamespace: parseNamespaceUtil,
  parseNode,
  extractValue,
} = require("./utils/oscquery-parser");
const { encodeOSCBinary, parseOSCBinary } = require("./utils/osc-binary-codec");
const { httpGet, WebSocketClient } = require("./utils/web-client");

// State management
let baseUrl = null;
let wsClient = null;
let hostInfo = null;
let namespace = null;
let connected = false;
let autoconnect = false;
let timeout = 5000;
let timeoutTimer = null;
let pathTypeInfo = new Map();
let paramsDict = null; // Keep paramsDict in memory
let updateMode = false; // Update mode: true = batch updates (no output), false = output on each update

//parse process.argv's but skip the first 2 arguments
const args = process.argv.slice(2);
maxAPI.post({ args: args });
const updateModeArg = args.find((arg) => arg.startsWith("update_mode="));
updateMode = updateModeArg ? updateModeArg.split("=")[1] === "true" : false;

const urlArg = args.find((arg) => arg.startsWith("url="));
baseUrl = urlArg ? urlArg.split("=")[1] : "http://localhost:5678";

const autoconnectArg = args.find((arg) => arg.startsWith("autoconnect="));
autoconnect = autoconnectArg ? autoconnectArg.split("=")[1] === "true" : false;
maxAPI.post(
  "AUTOINIT: baseUrl: ",
  baseUrl,
  "updateMode: ",
  updateMode,
  "autoconnect: ",
  autoconnect
);

// node.script has only 1 output edge
// We send data with routing tags so Max can route to different destinations
// Format: [tag, ...data] where tag identifies the outlet type
function outletTo(index, ...args) {
  let tag;
  switch (index) {
    case 0:
      tag = "param"; // Parameter list
      break;
    case 1:
      tag = "change"; // Parameter changes
      break;
    case 2:
      tag = "state"; // Connection state
      break;
    case 3:
      tag = "disconnect"; // Disconnect bang
      maxAPI.outlet("disconnect", "bang");
      return;
    case 4:
      tag = "sent"; // Sent parameter
      break;
    default:
      tag = "unknown";
  }
  // Send with routing tag as first argument
  maxAPI.outlet(tag, ...args);
}

// OSC Binary Codec is now imported from utils

// HTTP GET is now imported from utils/web-client

/**
 * Parse namespace using the proper parser utility
 * Returns array of parsed nodes, filtering for parameter nodes only
 */
function parseNamespace(namespace) {
  // Use the proper parser utility
  const nodes = parseNamespaceUtil(namespace);

  // Filter for parameter nodes (those with FULL_PATH and TYPE)
  // and store type info for later use
  const parameters = [];
  for (const node of nodes) {
    if (node.fullPath && node.type) {
      parameters.push({
        path: node.fullPath,
        type: node.type,
        value: extractValue(node.value, node.typeInfo),
        range: node.range,
        description: node.description,
        access: node.access,
        typeInfo: node.typeInfo,
      });

      // Store type info for later use in parameter setting
      if (node.typeInfo) {
        pathTypeInfo.set(node.fullPath, node.typeInfo);
      }
    }
  }

  return parameters;
}

/**
 * Helper function to set a nested value in an object based on a path array
 */
function setNestedValue(obj, pathParts, value) {
  let current = obj;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    if (!current[part]) {
      current[part] = {};
    }
    current = current[part];
  }
  const lastPart = pathParts[pathParts.length - 1];
  current[lastPart] = value;
}

/**
 * Validate that incoming arguments match the expected typeInfo format
 */
function validateValueFormat(valueArray, typeInfo) {
  if (!typeInfo) {
    // Type info is required for exact type validation
    return {
      valid: false,
      error:
        "Type information not available for this parameter. Cannot validate exact type.",
    };
  }

  const expectedLength = typeInfo.length || 1;
  const actualLength = valueArray.length;

  // Exact length matching required
  if (actualLength !== expectedLength) {
    return {
      valid: false,
      error: `Expected exactly ${expectedLength} value(s) (${
        typeInfo.isArray ? "array" : "single"
      } type), got ${actualLength}`,
    };
  }

  // Validate each value's type - exact matching required
  for (let i = 0; i < expectedLength; i++) {
    const value = valueArray[i];
    let expectedType;

    if (typeInfo.isArray && typeInfo.structure && typeInfo.structure[i]) {
      const structureItem = typeInfo.structure[i];
      if (structureItem?.type === "array" && structureItem.elements?.[0]) {
        expectedType = structureItem.elements[0].oscType;
      } else if (structureItem?.type === "primitive") {
        expectedType = structureItem.oscType;
      } else {
        expectedType = typeInfo.baseType;
      }
    } else {
      expectedType = typeInfo.baseType;
    }

    if (!expectedType) {
      return {
        valid: false,
        error: `No type information available for value at index ${i}`,
      };
    }

    // Check value type matches expected OSC type exactly
    const typeMatch = checkValueType(value, expectedType);
    if (!typeMatch.valid) {
      return {
        valid: false,
        error: `Value at index ${i}: ${typeMatch.error}. Expected exact type: ${expectedType}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Check if a value matches the expected OSC type
 */
function checkValueType(value, expectedOscType) {
  // Handle null/undefined for nil/impulse types
  if (value === null || value === undefined) {
    if (expectedOscType === "N" || expectedOscType === "I") {
      return { valid: true };
    }
    return {
      valid: false,
      error: `null/undefined not allowed for type ${expectedOscType}`,
    };
  }

  switch (expectedOscType) {
    case "i": // int32 - exact integer type required
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return {
          valid: false,
          error: `Expected integer (int32), got ${typeof value}${
            typeof value === "number" ? " (not an integer)" : ""
          }`,
        };
      }
      // Check int32 range
      if (value < -2147483648 || value > 2147483647) {
        return {
          valid: false,
          error: `Integer value ${value} out of int32 range (-2147483648 to 2147483647)`,
        };
      }
      break;

    case "f": // float32 - exact float type required
      if (typeof value !== "number") {
        return {
          valid: false,
          error: `Expected number (float32), got ${typeof value}`,
        };
      }
      break;

    case "d": // double - exact double type required
      if (typeof value !== "number") {
        return {
          valid: false,
          error: `Expected number (double), got ${typeof value}`,
        };
      }
      break;

    case "s": // string
    case "S": // symbol
      if (typeof value !== "string") {
        return {
          valid: false,
          error: `Expected string, got ${typeof value}`,
        };
      }
      break;

    case "b": // blob - exact array or Buffer required
      if (!Array.isArray(value) && !Buffer.isBuffer(value)) {
        return {
          valid: false,
          error: `Expected array or Buffer for blob, got ${typeof value}`,
        };
      }
      // Validate blob content is numeric bytes
      if (Array.isArray(value)) {
        for (let j = 0; j < value.length; j++) {
          if (
            typeof value[j] !== "number" ||
            !Number.isInteger(value[j]) ||
            value[j] < 0 ||
            value[j] > 255
          ) {
            return {
              valid: false,
              error: `Blob array must contain integers 0-255, got invalid value at index ${j}`,
            };
          }
        }
      }
      break;

    case "h": // int64
      if (typeof value !== "number" && typeof value !== "bigint") {
        return {
          valid: false,
          error: `Expected number or bigint, got ${typeof value}`,
        };
      }
      break;

    case "c": // char
      if (typeof value !== "string" || value.length !== 1) {
        return {
          valid: false,
          error: `Expected single character string, got ${typeof value}`,
        };
      }
      break;

    case "r": // RGBA
      if (
        typeof value !== "string" &&
        !Array.isArray(value) &&
        typeof value !== "object"
      ) {
        return {
          valid: false,
          error: `Expected string, array, or object for RGBA, got ${typeof value}`,
        };
      }
      break;

    case "m": // MIDI - exact 4-byte array required
      if (!Array.isArray(value)) {
        return {
          valid: false,
          error: `Expected array for MIDI, got ${typeof value}`,
        };
      }
      if (value.length !== 4) {
        return {
          valid: false,
          error: `Expected exactly 4 bytes for MIDI, got ${value.length}`,
        };
      }
      // Validate each byte is 0-255
      for (let j = 0; j < 4; j++) {
        if (
          typeof value[j] !== "number" ||
          !Number.isInteger(value[j]) ||
          value[j] < 0 ||
          value[j] > 255
        ) {
          return {
            valid: false,
            error: `MIDI byte at index ${j} must be integer 0-255, got ${value[j]}`,
          };
        }
      }
      break;

    case "T": // true - exact boolean true required
      if (value !== true) {
        return {
          valid: false,
          error: `Expected exact boolean true, got ${typeof value} (${value})`,
        };
      }
      break;

    case "F": // false - exact boolean false required
      if (value !== false) {
        return {
          valid: false,
          error: `Expected exact boolean false, got ${typeof value} (${value})`,
        };
      }
      break;

    case "N": // nil
    case "I": // impulse
      if (value !== null && value !== undefined) {
        return {
          valid: false,
          error: `Expected null/undefined for ${expectedOscType}, got ${typeof value}`,
        };
      }
      break;

    default:
      // Unknown type, allow it (might be custom)
      break;
  }

  return { valid: true };
}

/**
 * Update a parameter value in paramsDict and output the updated dict
 */
function updateParameterValue(path, value) {
  if (!paramsDict || !paramsDict.params) {
    maxAPI.post("paramsDict not initialized");
    return;
  }

  // Parse path and update nested structure
  const pathParts = path.replace(/^\//, "").split("/").filter(Boolean);

  if (pathParts.length === 0) {
    maxAPI.post("Invalid path:", path);
    return;
  }

  // Navigate to the parameter and update its value
  let current = paramsDict.params;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    if (!current[part]) {
      maxAPI.post(`Path segment not found: ${part} in path ${path}`);
      return;
    }
    current = current[part];
  }

  const lastPart = pathParts[pathParts.length - 1];
  if (current[lastPart]) {
    // Update the value
    current[lastPart].value = value;
    // Output updated paramsDict only if update mode is on
    if (updateMode) {
      outletTo(0, paramsDict);
    }
  } else {
    maxAPI.post(`Parameter not found: ${path}`);
  }
}

/**
 * Output parameter list as nested objects grouped by path hierarchy
 * Uses outlet 0
 * Parameters are organized into nested objects based on their path
 * Example: /Transform/position -> { Transform: { position: {...} } }
 */
function outputParameterList(parameters) {
  // Build nested object structure based on paths
  const paramsTree = {};

  parameters.forEach((param) => {
    // Build parameter object with all its data
    const paramObj = {
      type: param.type,
      value:
        param.value !== undefined && param.value !== null ? param.value : null,
    };

    // Add range information if available
    if (param.range && param.range !== null) {
      if (Array.isArray(param.range)) {
        paramObj.range = param.range.map((rangeItem) => {
          if (
            rangeItem &&
            rangeItem !== null &&
            rangeItem.MIN !== undefined &&
            rangeItem.MAX !== undefined
          ) {
            return { MIN: rangeItem.MIN, MAX: rangeItem.MAX };
          } else if (
            rangeItem &&
            rangeItem.VALS &&
            Array.isArray(rangeItem.VALS)
          ) {
            return { VALS: rangeItem.VALS };
          }
          return rangeItem;
        });
      } else if (param.range !== null && typeof param.range === "object") {
        paramObj.range = {};
        if (param.range.MIN !== undefined) paramObj.range.MIN = param.range.MIN;
        if (param.range.MAX !== undefined) paramObj.range.MAX = param.range.MAX;
        if (param.range.VALS && Array.isArray(param.range.VALS)) {
          paramObj.range.VALS = param.range.VALS;
        }
      }
    }

    // Add other metadata if available
    if (param.description) paramObj.description = param.description;
    if (param.access !== undefined) paramObj.access = param.access;

    // Parse path and create nested structure
    // Remove leading slash and split by '/'
    const pathParts = param.path.replace(/^\//, "").split("/").filter(Boolean);

    if (pathParts.length > 0) {
      setNestedValue(paramsTree, pathParts, paramObj);
    }
  });

  paramsDict = paramsTree;
  // Output as JSON string - Max can parse this with [dict] or [json] object
  // Format: param <json_string>
  outletTo(0, paramsDict);
}

/**
 * Connect to OSCQuery server
 */
async function connect(url) {
  if (connected) {
    disconnect();
  }

  try {
    const normalizedUrl = url.replace(/\/$/, "");
    baseUrl = normalizedUrl;

    maxAPI.post(`Connecting to ${normalizedUrl}...`);

    // Fetch namespace
    namespace = await httpGet(normalizedUrl, timeout);

    try {
      hostInfo = await httpGet(`${normalizedUrl}?HOST_INFO`, timeout);
    } catch (e) {
      maxAPI.post("HOST_INFO not available, WebSocket may not be supported");
    }

    // Parse and output parameter list
    const parameters = parseNamespace(namespace);
    outputParameterList(parameters);

    // Connect WebSocket if available
    if (hostInfo && hostInfo.EXTENSIONS && hostInfo.EXTENSIONS.LISTEN) {
      const wsUrl = hostInfo.WS_URL || normalizedUrl.replace(/^http/, "ws");
      await connectWebSocket(wsUrl);
      // Connection state is set inside connectWebSocket after WebSocket opens
    } else {
      maxAPI.post("WebSocket not supported by server");
      connected = true; // Still connected via HTTP
      outletTo(2, "connected");
      maxAPI.post("Connected successfully (HTTP only)");
    }
  } catch (error) {
    maxAPI.post("Connection error:", error.message);
    connected = false;
    outletTo(2, "disconnected");
    throw error;
  }
}

/**
 * Connect WebSocket
 */
function connectWebSocket(wsUrl) {
  // Create WebSocket client with callbacks
  wsClient = new WebSocketClient({
    timeout: timeout,
    logger: (message, ...args) => {
      maxAPI.post(message, ...args);
    },
    onOpen: () => {
      // Set connection state only after WebSocket is confirmed open
      connected = true;
      outletTo(2, "connected");
      maxAPI.post("Connected successfully");

      // Set up LISTEN for all parameters AFTER connection is open
      if (namespace) {
        const parameters = parseNamespace(namespace);
        maxAPI.post(`Setting up LISTEN for ${parameters.length} parameters`);
        for (const param of parameters) {
          try {
            wsClient.send(
              JSON.stringify({
                COMMAND: "LISTEN",
                DATA: param.path,
              })
            );
          } catch (sendError) {
            maxAPI.post(
              `Error sending LISTEN for ${param.path}:`,
              sendError.message
            );
          }
        }
      }
    },
    onMessage: (data) => {
      try {
        // Try to parse as binary OSC first
        let message;
        if (Buffer.isBuffer(data)) {
          // Try binary OSC
          const parsed = parseOSCBinary(data);
          if (parsed) {
            // Update paramsDict with new value
            updateParameterValue(parsed.PATH, parsed.VALUE);
            // Send to outlet 1 (parameter changes)
            outletTo(1, parsed.PATH, parsed.VALUE);
            return;
          }
          // Try as text
          try {
            message = JSON.parse(data.toString("utf8"));
          } catch (e) {
            // Not JSON, ignore
            return;
          }
        } else if (typeof data === "string") {
          message = JSON.parse(data);
        } else {
          return;
        }

        // Handle JSON message
        if (message.PATH && message.VALUE !== undefined) {
          // Update paramsDict with new value
          updateParameterValue(message.PATH, message.VALUE);
          // Send to outlet 1 (parameter changes)
          outletTo(1, message.PATH, message.VALUE);
        } else if (message.COMMAND === "LISTEN" && message.DATA) {
          // Server acknowledging LISTEN command
          maxAPI.post(`Listening to ${message.DATA}`);
        }
      } catch (error) {
        maxAPI.post("Error processing WebSocket message:", error.message);
      }
    },
    onError: (error) => {
      connected = false;
      outletTo(2, "disconnected");
    },
    onClose: (code, reason) => {
      if (connected) {
        // Only output disconnect if we were previously connected
        connected = false;
        outletTo(2, "disconnected");
        outletTo(3);
      }
    },
  });

  return wsClient.connect(wsUrl);
}

/**
 * Disconnect from server
 */
function disconnect() {
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }

  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }

  baseUrl = null;
  hostInfo = null;
  namespace = null;
  pathTypeInfo.clear();
  paramsDict = null; // Clear paramsDict on disconnect

  const wasConnected = connected;
  connected = false;
  outletTo(2, "disconnected");

  if (wasConnected) {
    outletTo(3);
  }

  maxAPI.post("Disconnected");
}

function setParameter(path, ...args) {
  // Check connection state
  if (!baseUrl) {
    const error = new Error("Not connected");
    // maxAPI.post(`Cannot set value for ${path}: Not connected`);
    throw error;
  }

  // Convert canonical domain value to raw OSCQuery format
  // For OSCQuery, values are already in canonical format, so pass-through
  const rawValue = args; // fromDomain equivalent (pass-through for OSCQuery)
  // Convert args to value array
  let valueArray;
  if (rawValue === null || rawValue === undefined) {
    valueArray = [null];
  } else if (Array.isArray(rawValue)) {
    valueArray = rawValue;
  } else {
    valueArray = [rawValue];
  }

  // Only use WebSocket for setting values - HTTP PUT/POST is not part of OSCQueryProposal spec
  if (!wsClient || !wsClient.isConnected()) {
    const warning = `Cannot set value for ${path}: WebSocket is not connected. Please ensure the WebSocket connection is established before setting values.`;
    maxAPI.post(warning);
    throw new Error(warning);
  }

  try {
    // Validate and normalize path
    let normalizedPath = String(path);
    if (!normalizedPath.startsWith("/")) {
      normalizedPath = "/" + normalizedPath;
    }

    // Get type info from parameter or stored type info
    const oscTypeInfo =
      pathTypeInfo.get(normalizedPath) || pathTypeInfo.get(path);

    // Validate value format against typeInfo - exact type required
    if (!oscTypeInfo) {
      const error = `Type information not available for ${normalizedPath}. Cannot send without exact type validation.`;
      maxAPI.post(error);
      throw new Error(error);
    }

    const validation = validateValueFormat(valueArray, oscTypeInfo);
    if (!validation.valid) {
      const error = `Type validation failed for ${normalizedPath}: ${validation.error}`;
      maxAPI.post(error);
      throw new Error(error);
    }

    // Encode as OSC binary
    const oscPacket = encodeOSCBinary(normalizedPath, valueArray, oscTypeInfo);

    // Ensure we have a valid Buffer
    if (!Buffer.isBuffer(oscPacket)) {
      throw new Error("OSC encoding failed: result is not a Buffer");
    }

    // Validate packet size
    if (oscPacket.length === 0) {
      throw new Error("OSC encoding failed: empty packet");
    }

    // Send via WebSocket as binary
    // In Node.js 'ws' library, sending a Buffer automatically sends as binary
    wsClient.send(oscPacket);
    // make path and valuearray into single object
    const sentObject = { path: path, value: valueArray };
    outletTo(4, sentObject);
  } catch (wsError) {
    const error =
      wsError instanceof Error ? wsError : new Error(String(wsError));
    maxAPI.post(
      `Failed to send value via WebSocket for ${path}:`,
      error.message
    );
    throw new Error(`Failed to send value via WebSocket: ${error.message}`);
  }
}

/**
 * Request parameter list refresh
 */
async function refreshList() {
  if (!connected || !baseUrl) {
    maxAPI.post("Not connected");
    return;
  }

  try {
    namespace = await httpGet(baseUrl, timeout);
    const parameters = parseNamespace(namespace);
    outputParameterList(parameters);
    maxAPI.post("Parameter list refreshed");
  } catch (error) {
    maxAPI.post("Error refreshing list:", error.message);
  }
}

// Handle messages from Max
maxAPI.addHandler("connect", (url) => {
  connect(url).catch((error) => {
    maxAPI.post("Connect failed:", error.message);
  });
});

maxAPI.addHandler("disconnect", () => {
  disconnect();
});

maxAPI.addHandler("autoconnect", (value) => {
  autoconnect = value ? true : false;
  maxAPI.post("autoconnect: ", autoconnect);
});

maxAPI.addHandler("timeout", (ms) => {
  timeout = parseInt(ms) || 5000;
});

maxAPI.addHandler("refresh_params", () => {
  maxAPI.post("Refreshing parameter list");
  refreshList();
});

// Handler for update mode (batch updates)
// update_mode 1 = enable (batch updates, no output)
// update_mode 0 = disable (output current state)
maxAPI.addHandler("update_mode", (value) => {
  if (!paramsDict) {
    maxAPI.post("paramsDict not initialized");
    return;
  }
  updateMode = value == "true" ? true : false;

  if (updateMode && paramsDict) {
    // Update mode was turned on, output the current state
    outletTo(0, paramsDict);
    maxAPI.post("Update mode enabled, outputting current state");
  } else {
    maxAPI.post("Update mode disabled");
  }
});

// Test handler: ping -> pong
maxAPI.addHandler("ping", () => {
  maxAPI.post("Received ping, sending pong");
  outletTo(5, "pong"); // Sends: param pong
});

maxAPI.addHandler("url", (url) => {
  baseUrl = url;
  // If autoconnect is enabled, connect immediately
  if (autoconnect && baseUrl) {
    connect(baseUrl).catch((error) => {
      maxAPI.post("AutoConnect failed:", error.message);
    });
  }
});

maxAPI.addHandler("send", (path, ...args) => {
  if (path === undefined || args.length === 0) {
    maxAPI.post("Path and value are required");
    return;
  }

  try {
    setParameter(path, ...args);
  } catch (error) {
    // maxAPI.post(`Error in send handler: ${error.message}`);
  }
});

// Handle URL strings directly (connect when receiving URL)
maxAPI.addHandler("anything", (...args) => {
  if (args.length === 0) return;

  const firstArg = args[0];

  // Check if it's a URL string (starts with http:// or https://)
  if (
    typeof firstArg === "string" &&
    (firstArg.startsWith("http://") || firstArg.startsWith("https://"))
  ) {
    connect(firstArg).catch((error) => {
      maxAPI.post("Connect failed:", error.message);
    });
    return;
  } else if (args.length === 1 && typeof firstArg === "string") {
    // Single string might be a path, but we need a value - ignore
    maxAPI.post(
      `Received single argument "${firstArg}", need path and value to set parameter`
    );
  }
});

// Handle autoconnect on initialization
maxAPI.addHandler("bang", () => {
  if (autoconnect && baseUrl) {
    connect(baseUrl).catch((error) => {
      maxAPI.post("AutoConnect failed:", error.message);
    });
  }
});

// Initialize
maxAPI.post("OSCQuery Client initialized");
if (autoconnect && baseUrl) {
  connect(baseUrl).catch((error) => {
    maxAPI.post("AutoConnect failed:", error.message);
  });
}
outletTo(2, "disconnected"); // Initial connection state: disconnected

// Note: Attributes are handled via messages. To use autoconnect:
// 1. Set @autoconnect 1 and @url <url> in Max object attributes
// 2. Or send "autoconnect 1" and "url <url>" messages
// 3. Then send "bang" to trigger autoconnect
