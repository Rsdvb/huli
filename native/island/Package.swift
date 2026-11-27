// swift-tools-version:5.7
// Huli: only for `swift test`, which checks the island's layout arithmetic (Sources/Layout.swift)
// and how it keeps the view main sends (Sources/Store.swift, Sources/Protocol.swift) on their own.
// The helper itself is built by build.mjs, which compiles every file in Sources/.

import PackageDescription

let package = Package(
  name: "IslandLayout",
  platforms: [.macOS(.v13)],
  targets: [
    .target(
      name: "IslandLayout", path: "Sources",
      sources: ["Layout.swift", "Protocol.swift", "Store.swift"]),
    .testTarget(name: "IslandLayoutTests", dependencies: ["IslandLayout"], path: "Tests"),
  ]
)
