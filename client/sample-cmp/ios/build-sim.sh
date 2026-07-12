#!/bin/bash
# Builds the CMP sample as a simulator .app without an Xcode project.
# Usage: ./build-sim.sh   (run from client/sample-cmp/ios)
set -euo pipefail

cd "$(dirname "$0")"
FRAMEWORK_DIR=../build/bin/iosSimulatorArm64/debugFramework
APP=build/SnifferCmpSample.app

(cd ../.. && ./gradlew :sample-cmp:linkDebugFrameworkIosSimulatorArm64 -q)

rm -rf build && mkdir -p "$APP"
xcrun swiftc \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target arm64-apple-ios15.0-simulator \
  -F "$FRAMEWORK_DIR" -framework SampleShared \
  main.swift -o "$APP/SnifferCmpSample"
cp Info.plist "$APP/Info.plist"
codesign --force --sign - "$APP"
echo "Built $APP"
echo "Install: xcrun simctl install booted $APP && xcrun simctl launch booted dev.weiqi.sniffer.samplecmp.ios"
