const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { AndroidConfig, withAndroidManifest, withDangerousMod, withStringsXml } = require("expo/config-plugins");

/**
 * Long-press the app icon for "Record conversation" and drag it to the home screen for one tap.
 * Android's static shortcuts need a res/xml file and a line in the main activity, which Expo has no
 * setting for. The shortcut opens orchestrator://record?start=1, the Record screen, already recording.
 */
const xml = (pkg, scheme) => `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut android:shortcutId="record" android:enabled="true" android:icon="@mipmap/ic_launcher" android:shortcutShortLabel="@string/shortcut_record" android:shortcutLongLabel="@string/shortcut_record_long">
    <intent android:action="android.intent.action.VIEW" android:targetPackage="${pkg}" android:targetClass="${pkg}.MainActivity" android:data="${scheme}://record?start=1" />
  </shortcut>
</shortcuts>
`;

module.exports = function withShortcuts(config) {
  const pkg = config.android.package;
  const scheme = config.scheme;
  config = withDangerousMod(config, [
    "android",
    (c) => {
      const dir = join(c.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "shortcuts.xml"), xml(pkg, scheme));
      return c;
    },
  ]);
  config = withStringsXml(config, (c) => {
    c.modResults = AndroidConfig.Strings.setStringItem(
      [
        { $: { name: "shortcut_record", translatable: "false" }, _: "Record" },
        { $: { name: "shortcut_record_long", translatable: "false" }, _: "Record conversation" },
      ],
      c.modResults,
    );
    return c;
  });
  return withAndroidManifest(config, (c) => {
    const main = AndroidConfig.Manifest.getMainActivityOrThrow(c.modResults);
    main["meta-data"] = (main["meta-data"] ?? []).filter((m) => m.$["android:name"] !== "android.app.shortcuts");
    main["meta-data"].push({ $: { "android:name": "android.app.shortcuts", "android:resource": "@xml/shortcuts" } });
    return c;
  });
};
