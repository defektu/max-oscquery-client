/**
 * Max/MSP mDNS Resolver
 * A node.script-based external object for resolving mDNS names to IPv4 addresses
 * and discovering OSCQuery services via mDNS
 *
 * Usage in Max:
 *   [node.script mdns.resolve.js]
 *   |
 *   [route ipv4 error service_up service_down]
 *   |
 *   [ipv4( [outlet 0]  // IPv4 address (from manual resolve)
 *   [error( [outlet 1]  // Error message
 *   [service_up( [outlet 2]  // Discovered service (address port name)
 *   [service_down( [outlet 3]  // Removed service (address port)
 *
 * Inlets: 1 (mDNS name to resolve, or discovery commands)
 * Outlets: 1 (with routing tags - use [route] to split)
 *
 * Commands:
 *   - resolve <hostname> - Manually resolve mDNS name to IPv4
 *   - discovery_start - Start discovering OSCQuery services
 *   - discovery_stop - Stop discovery
 *   - discovery_list - List all currently discovered services
 */

const maxAPI = require("max-api");
const { OSCQueryDiscovery, DiscoveredService } = require("oscquery");

/**
 * Send data to Max outlet with routing tag
 * node.script has only 1 output edge
 * We send data with routing tags so Max can route to different destinations
 * Format: [tag, ...data] where tag identifies the outlet type
 */
function outletTo(index, ...args) {
  let tag;
  switch (index) {
    case 0:
      tag = "ipv4"; // IPv4 address (from manual resolve)
      break;
    case 1:
      tag = "error"; // Error message
      break;
    case 2:
      tag = "service_up"; // Discovered service
      break;
    case 3:
      tag = "service_down"; // Removed service
      break;
    case 4:
      tag = "service_list"; // List of services
      break;
    default:
      tag = "unknown";
  }
  // Send with routing tag as first argument
  maxAPI.outlet(tag, ...args);
}

/**
 * Resolve mDNS name to IPv4 address
 * @param {string} hostname - The mDNS hostname (e.g., "hostname.local")
 */
function resolve(hostname) {
  if (!hostname || typeof hostname !== "string") {
    const errorMsg = "Invalid hostname provided";
    maxAPI.post("Error:", errorMsg);
    outletTo(1, errorMsg);
    return;
  }

  // if it ends with .local. remove last dot
  if (hostname.endsWith("local.")) {
    hostname = hostname.slice(0, -1);
    maxAPI.post("Removed last dot from hostname:", hostname);
  }

  // Ensure hostname ends with .local (optional, but helpful)
  const hostnameToResolve = hostname.endsWith(".local")
    ? hostname
    : `${hostname}.local`;

  // mDNS resolution functionality has been removed
  const errorMsg =
    "mDNS resolution not available (mdns-resolver package removed)";
  maxAPI.post("Error:", errorMsg);
  outletTo(1, errorMsg);
}

// Initialize discovery
let discovery = null;

/**
 * Initialize and start OSCQuery discovery
 */
function startDiscovery() {
  if (discovery) {
    maxAPI.post("Discovery already running");
    return;
  }

  discovery = new OSCQueryDiscovery();

  discovery.on("up", (service) => {
    // service is a DiscoveredService instance
    maxAPI.post("=== OSCQuery Service Discovered ===");
    maxAPI.post("--- Basic Service Info ---");
    maxAPI.post("  Address:", service.address);
    maxAPI.post("  Port:", service.port);
    maxAPI.post("  Type:", typeof service);
    maxAPI.post("  Constructor:", service.constructor.name);

    listServices();
    outletTo(2, service.address, service.port, service.hostInfo.name);
  });

  discovery.on("down", (service) => {
    maxAPI.post("Service removed:", service.address, "port:", service.port);
    // Output: service_down address port
    listServices();
    outletTo(3, service.address, service.port);
  });

  discovery.on("error", (error) => {
    const errorMsg = error && error.message ? error.message : String(error);
    maxAPI.post("Discovery error:", errorMsg);
    outletTo(1, errorMsg);
  });

  discovery.start();
  maxAPI.post("OSCQuery discovery started");
}

/**
 * Stop OSCQuery discovery
 */
function stopDiscovery() {
  if (!discovery) {
    maxAPI.post("Discovery not running");
    return;
  }

  discovery.stop();
  discovery = null;
  maxAPI.post("OSCQuery discovery stopped");
}

/**
 * List all currently discovered services
 */
function listServices() {
  if (!discovery) {
    maxAPI.post("Discovery not running");
    outletTo(1, "Discovery not running");
    return;
  }

  const services = discovery.getServices();
  maxAPI.post("Found", services.length, "service(s)");

  if (services.length === 0) {
    maxAPI.post("No services discovered yet");
    return;
  }

  // Output all services as dict aka json (do not make them arrays)
  const serviceList = {};
  services.forEach((service) => {
    serviceList[service.hostInfo.name] = {
      address: service.address,
      port: service.port,
      name: service.hostInfo.name,
    };
  });

  outletTo(4, serviceList);
}

// Initialize Max API handlers
maxAPI.addHandler("resolve", (hostname) => {
  resolve(hostname);
});

maxAPI.addHandler("discovery_start", () => {
  startDiscovery();
});

maxAPI.addHandler("discovery_stop", () => {
  stopDiscovery();
});

maxAPI.addHandler("discovery_list", () => {
  listServices();
});

// Also handle direct messages (when hostname is sent directly, if not a command)
maxAPI.addHandler("anything", (msg) => {
  // Check if it's a command first
  if (
    msg === "discovery_start" ||
    msg === "discovery_stop" ||
    msg === "discovery_list"
  ) {
    // Commands are handled by specific handlers above
    return;
  }
  // Otherwise treat as hostname to resolve
  resolve(msg);
});

// Initialize
maxAPI.post("mDNS Resolver initialized");
maxAPI.post(
  "Commands: resolve <hostname>, discovery_start, discovery_stop, discovery_list"
);
maxAPI.post("Send mDNS hostname to resolve (e.g., 'hostname.local')");
