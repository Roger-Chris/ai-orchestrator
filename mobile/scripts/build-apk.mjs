// Builds the release APK on Windows, macOS or Linux (the old script called gradlew.bat, Windows only).
// `npm run build:apk`: Expo prebuild, then Gradle. The APK lands in android/app/build/outputs/apk/release/
// and is signed with the template's debug keystore, so it installs over the app already on the phone.
// Needs the Android SDK (ANDROID_HOME) and Java 17. `--all-abis` builds for every CPU (slower).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
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
const abis = process.argv.includes("--all-abis") ? [] : ["-PreactNativeArchitectures=arm64-v8a"];
run(win ? "gradlew.bat" : "./gradlew", ["assembleRelease", ...abis], android);
console.log(`\nAPK: ${join(android, "app", "build", "outputs", "apk", "release", "app-release.apk")}`);
