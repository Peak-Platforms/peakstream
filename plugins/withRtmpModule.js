const {
  withDangerousMod,
  withAppBuildGradle,
  withProjectBuildGradle,
  withMainApplication,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Copies the persistent .kt source files (kept in /native-src/rtmp, OUTSIDE
// android/) into android/app/.../com/peakstream/rtmp/ on every prebuild —
// this survives `expo prebuild` and `expo prebuild --clean` alike, since
// prebuild fully regenerates android/ from scratch every time.
function withRtmpNativeFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const srcDir = path.join(config.modRequest.projectRoot, 'native-src', 'rtmp');
      const destDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', 'com', 'peakstream', 'rtmp'
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
      }
      return config;
    },
  ]);
}

// Adds the RootEncoder dependency to android/app/build.gradle
function withRtmpGradleDependency(config) {
  return withAppBuildGradle(config, (config) => {
    const marker = 'com.github.pedroSG94.RootEncoder:library';
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents = config.modResults.contents.replace(
        'dependencies {',
        `dependencies {\n    implementation "com.github.pedroSG94.RootEncoder:library:2.6.7"`
      );
    }
    return config;
  });
}

// Adds the jitpack maven repo to the root android/build.gradle
function withJitpackRepo(config) {
  return withProjectBuildGradle(config, (config) => {
    const marker = 'jitpack.io';
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents = config.modResults.contents.replace(
        /allprojects\s*{\s*repositories\s*{/,
        (match) => `${match}\n    maven { url 'https://www.jitpack.io' }`
      );
    }
    return config;
  });
}

// Registers RtmpPublisherPackage in MainApplication.kt
function withRtmpPackageRegistration(config) {
  return withMainApplication(config, (config) => {
    const marker = 'RtmpPublisherPackage';
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents = config.modResults.contents.replace(
        /PackageList\(this\)\.packages\.apply\s*{/,
        (match) => `${match}\n          add(com.peakstream.rtmp.RtmpPublisherPackage())`
      );
    }
    return config;
  });
}

module.exports = function withRtmpModule(config) {
  config = withRtmpNativeFiles(config);
  config = withRtmpGradleDependency(config);
  config = withJitpackRepo(config);
  config = withRtmpPackageRegistration(config);
  return config;
};
