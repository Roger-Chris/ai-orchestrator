// The app lives inside the orchestrator repo, whose own node_modules has a different React
// (for the web app). Resolve packages only from the app's node_modules so there is one React.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
