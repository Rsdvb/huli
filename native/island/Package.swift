// swift-tools-version:5.7
// Huli: only for `swift test`, which checks the island's layout arithmetic (Sources/Layout.swift)
// on its own. The helper itself is built by build.mjs, which compiles every file in Sources/.

import PackageDescription

let package = Package(
  name: "IslandLayout",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "IslandLayout", path: "Sources", sources: ["Layout.swift"]),
    .testTarget(name: "IslandLayoutTests", dependencies: ["IslandLayout"], path: "Tests"),
  ]
)
