// Builds the release APK on Windows, macOS or Linux (the old script called gradlew.bat, Windows only).
// `npm run build:apk`: Expo prebuild, then Gradle. The APK lands in android/app/build/outputs/apk/release/
// and is signed with the template's debug keystore, so it installs over the app already on the phone.
// Needs the Android SDK (ANDROID_HOME, else the SDK's usual folder) and Java 17. `--all-abis` builds for every CPU (slower).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";

// Where Android Studio puts the SDK when ANDROID_HOME is not set.
const usualSdk = win ? join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk") : process.platform === "darwin" ? join(homedir(), "Library", "Android", "sdk") : join(homedir(), "Android", "Sdk");
const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, usualSdk].find((d) => d && existsSync(d));
if (!sdk) {
  console.error(`no Android SDK: set ANDROID_HOME (looked in ${usualSdk} too)`);
  process.exit(1);
}
// The newest CMake in the SDK. The default 3.22.1's ninja breaks on long Windows paths; 3.31's does not.
const version = (v) => v.split(".").map(Number);
const newer = (a, b) => { const [x, y] = [version(a), version(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
const cmakes = existsSync(join(sdk, "cmake")) ? readdirSync(join(sdk, "cmake")).filter((v) => /^\d+\.\d+/.test(v)) : [];
const cmake = cmakes.reduce((best, v) => (!best || newer(v, best) ? v : best), undefined);
const run = (cmd, args, cwd) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  // npx and gradlew.bat are batch files on Windows: start them through the shell there.
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: win });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(win ? "npx.cmd" : "npx", ["expo", "prebuild", "--platform", "android", "--clean"], root);
const android = join(root, "android");
const gradlew = join(android, win ? "gradlew.bat" : "gradlew");
if (!existsSync(gradlew)) {
  console.error(`no Gradle wrapper at ${gradlew}`);
  process.exit(1);
}
// prebuild --clean wiped local.properties: say where the SDK and CMake are (properties files escape ':').
const prop = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
const props = [`sdk.dir=${prop(sdk)}`, ...(cmake ? [`cmake.dir=${prop(join(sdk, "cmake", cmake))}`] : [])];
writeFileSync(join(android, "local.properties"), props.join("\n") + "\n");
console.log(`\nAndroid SDK ${sdk}${cmake ? `, CMake ${cmake}` : ""}`);
const abis = process.argv.includes("--all-abis") ? [] : ["-PreactNativeArchitectures=arm64-v8a"];
// By full path: with NoDefaultCurrentDirectoryInExePath set (agents, services) cmd will not run gradlew.bat from the folder.
run(win ? `"${gradlew}"` : gradlew, ["assembleRelease", ...abis], android);
console.log(`\nAPK: ${join(android, "app", "build", "outputs", "apk", "release", "app-release.apk")}`);
