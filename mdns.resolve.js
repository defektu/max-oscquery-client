/**
 * Max/MSP mDNS Resolver
 * A node.script-based external object for resolving mDNS names to IPv4 addresses
 * and discovering OSCQuery services and custom service types via mDNS
 *
 * Usage in Max:
 *   [node.script mdns.resolve.js]
 *   |
 *   [route ipv4 error service_up service_down]
 *   |
 *   [ipv4( [outlet 0]  // IPv4 address (from manual resolve)
 *   [error( [outlet 1]  // Error message
 *   [service_up( [outlet 2]  // Discovered service (address port name type)
 *   [service_down( [outlet 3]  // Removed service (address port)
 *
 * Inlets: 1 (mDNS name to resolve, or discovery commands)
 * Outlets: 1 (with routing tags - use [route] to split)
 *
 * Commands:
 *   - resolve <hostname> - Manually resolve mDNS name to IPv4
 *   - discovery_start [service_types...] - Start discovering services (default: oscjson, _http._tcp)
 *   - discovery_stop - Stop discovery
 *   - discovery_list - List all currently discovered services
 */

const maxAPI = require("max-api");
const dns = require("dns");
const {
  OSCQueryDiscovery,
  DiscoveredService,
  MDNSDiscovery,
} = require("oscquery");

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
 * @param {string} hostname - The mDNS hostname (e.g., "hostname.local" or "hostname")
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

  // If hostname doesn't end with .local and doesn't contain a dot (no domain),
  // assume it's a local mDNS hostname and append .local
  if (!hostname.endsWith(".local") && hostname.indexOf(".") === -1) {
    hostname = hostname + ".local";
    maxAPI.post("Appended .local for mDNS resolution:", hostname);
  }

  maxAPI.post("Resolving hostname:", hostname);

  // Use Node.js built-in dns.lookup() for hostname resolution
  // This works for both regular DNS and mDNS (.local) if mDNS is configured on the system
  dns.lookup(
    hostname,
    {
      family: 4, // IPv4 only
      all: false, // Return first address only
    },
    (err, address, family) => {
      if (err) {
        const errorMsg = `Failed to resolve ${hostname}: ${err.message}`;
        maxAPI.post("Error:", errorMsg);
        outletTo(1, errorMsg);
        return;
      }

      if (address) {
        maxAPI.post("Resolved", hostname, "to", address);
        outletTo(0, address);
      } else {
        const errorMsg = `No address found for ${hostname}`;
        maxAPI.post("Error:", errorMsg);
        outletTo(1, errorMsg);
      }
    }
  );
}

// Initialize discovery
let oscQueryDiscovery = null;
let genericDiscovery = null;
let discoveredServices = new Map(); // Map of "address:port" -> service info

/**
 * Start generic mDNS discovery for custom service types
 * Uses MDNSDiscovery which automatically detects the correct network interface
 */
function startGenericDiscovery(serviceTypes = ["_http._tcp"]) {
  if (genericDiscovery) {
    maxAPI.post("Generic discovery already running");
    return;
  }

  // Use MDNSDiscovery which automatically detects network interface
  genericDiscovery = new MDNSDiscovery({
    serviceTypes: serviceTypes,
    protocol: "tcp",
    errorCallback: (err) => {
      maxAPI.post("Generic discovery error:", err.message);
      outletTo(1, err.message);
    },
  });

  genericDiscovery.on("up", (serviceInfo) => {
    const key = `${serviceInfo.address}:${serviceInfo.port}`;
    discoveredServices.set(key, serviceInfo);

    maxAPI.post("=== Generic Service Discovered ===");
    maxAPI.post("  Address:", serviceInfo.address);
    maxAPI.post("  Port:", serviceInfo.port);
    maxAPI.post("  Name:", serviceInfo.name);
    maxAPI.post("  Type:", serviceInfo.fullType);

    listServices();
    outletTo(
      2,
      serviceInfo.address,
      serviceInfo.port,
      serviceInfo.name,
      serviceInfo.fullType
    );
  });

  genericDiscovery.on("down", (serviceInfo) => {
    const key = `${serviceInfo.address}:${serviceInfo.port}`;
    const existingService = discoveredServices.get(key);

    if (existingService) {
      maxAPI.post(
        "Generic service removed:",
        serviceInfo.address,
        "port:",
        serviceInfo.port
      );
      discoveredServices.delete(key);
      listServices();
      outletTo(3, serviceInfo.address, serviceInfo.port);
    }
  });

  genericDiscovery.start();
  maxAPI.post(
    "Generic mDNS discovery started for types:",
    serviceTypes.join(", ")
  );
}

/**
 * Stop generic mDNS discovery
 */
function stopGenericDiscovery() {
  if (!genericDiscovery) {
    return;
  }

  genericDiscovery.stop();
  genericDiscovery = null;
  discoveredServices.clear();
  maxAPI.post("Generic mDNS discovery stopped");
}

/**
 * Initialize and start OSCQuery discovery
 */
function startOSCQueryDiscovery() {
  if (oscQueryDiscovery) {
    maxAPI.post("OSCQuery discovery already running");
    return;
  }

  oscQueryDiscovery = new OSCQueryDiscovery();

  oscQueryDiscovery.on("up", (service) => {
    maxAPI.post("=== OSCQuery Service Discovered ===");
    maxAPI.post("--- Basic Service Info ---");
    maxAPI.post("  Address:", service.address);
    maxAPI.post("  Port:", service.port);

    try {
      const serviceName = service.hostInfo ? service.hostInfo.name : "Unknown";
      maxAPI.post("  Name:", serviceName);
      listServices();
      outletTo(
        2,
        service.address,
        service.port,
        serviceName,
        "oscjson._tcp.local"
      );
    } catch (error) {
      const errorMsg = `Failed to get service info: ${error.message}`;
      maxAPI.post("Error:", errorMsg);
      outletTo(1, errorMsg);
    }
  });

  oscQueryDiscovery.on("down", (service) => {
    maxAPI.post(
      "OSCQuery service removed:",
      service.address,
      "port:",
      service.port
    );
    listServices();
    outletTo(3, service.address, service.port);
  });

  oscQueryDiscovery.on("error", (error) => {
    const errorMsg = error && error.message ? error.message : String(error);
    maxAPI.post("OSCQuery discovery error:", errorMsg);
    outletTo(1, errorMsg);
  });

  oscQueryDiscovery.start();
  maxAPI.post("OSCQuery discovery started");
}

/**
 * Stop OSCQuery discovery
 */
function stopOSCQueryDiscovery() {
  if (!oscQueryDiscovery) {
    return;
  }

  oscQueryDiscovery.stop();
  oscQueryDiscovery = null;
  maxAPI.post("OSCQuery discovery stopped");
}

/**
 * Start discovery with optional service types
 * @param {string|string[]} serviceTypes - Service types to discover (e.g., "_http._tcp", "_https._tcp")
 */
function startDiscovery(serviceTypes) {
  // Always start OSCQuery discovery
  startOSCQueryDiscovery();

  // Start generic discovery if service types provided
  if (serviceTypes) {
    const types = Array.isArray(serviceTypes) ? serviceTypes : [serviceTypes];
    // Default to _http._tcp if no types specified
    const typesToDiscover = types.length > 0 ? types : ["_http._tcp"];
    startGenericDiscovery(typesToDiscover);
  } else {
    // Default: discover HTTP services
    startGenericDiscovery(["_http._tcp"]);
  }
}

/**
 * Stop all discovery
 */
function stopDiscovery() {
  stopOSCQueryDiscovery();
  stopGenericDiscovery();
  maxAPI.post("All discovery stopped");
}

/**
 * List all currently discovered services
 */
function listServices() {
  const serviceList = {};

  // Add OSCQuery services
  if (oscQueryDiscovery) {
    const oscServices = oscQueryDiscovery.getServices();
    oscServices.forEach((service) => {
      try {
        const name = service.hostInfo
          ? service.hostInfo.name
          : `OSCQuery-${service.address}`;
        serviceList[name] = {
          address: service.address,
          port: service.port,
          name: name,
          type: "oscjson._tcp.local",
        };
      } catch (e) {
        // Skip services without hostInfo
      }
    });
  }

  // Add generic discovered services
  discoveredServices.forEach((serviceInfo, key) => {
    serviceList[serviceInfo.name] = {
      address: serviceInfo.address,
      port: serviceInfo.port,
      name: serviceInfo.name,
      type: serviceInfo.fullType,
    };
  });

  const count = Object.keys(serviceList).length;
  maxAPI.post("Found", count, "service(s)");

  if (count === 0) {
    maxAPI.post("No services discovered yet");
    return;
  }

  outletTo(4, serviceList);
}

// Initialize Max API handlers
maxAPI.addHandler("resolve", (hostname) => {
  resolve(hostname);
});

maxAPI.addHandler("discovery_start", (...args) => {
  // If args provided, use them as service types, otherwise use defaults
  startDiscovery(args.length > 0 ? args : null);
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
  "Commands: resolve <hostname>, discovery_start [service_types...], discovery_stop, discovery_list"
);
maxAPI.post(
  "Examples: discovery_start, discovery_start _http._tcp, discovery_start _http._tcp _https._tcp"
);
maxAPI.post("Send mDNS hostname to resolve (e.g., 'hostname.local')");
