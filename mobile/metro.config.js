// The app lives inside the orchestrator repo, whose own node_modules has a different React
// (for the web app). Look in the app's node_modules first so there is one React; the normal
// nested lookup stays on because some packages keep their dependencies in their own node_modules.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
