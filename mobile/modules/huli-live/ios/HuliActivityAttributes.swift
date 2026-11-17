// Huli's Live Activity, as ActivityKit knows it. The app (this module) and the widget extension
// (plugins/withWidgets.js copies this very file into it) must agree on the type's name and shape:
// the computer starts and updates the activity by push, naming the type HuliActivityAttributes and
// sending `{ "sealed": ... }` for both the attributes and the state (cloud/src/push.ts). What it
// sealed is opened only where it is shown. An activity the app starts itself carries `local`.

import ActivityKit
import Foundation

struct HuliActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// The computer's state, sealed to this phone: `{ kind: "waiting", count, sessionId?, title? }`.
    var sealed: String?
    /// The state of an activity the app started itself.
    var local: HuliLocalState?

    init(sealed: String? = nil, local: HuliLocalState? = nil) {
      self.sealed = sealed
      self.local = local
    }
  }

  /// The computer's attributes, sealed to this phone: `{ kind: "activity", host, hostName, at }`.
  var sealed: String?
  /// The computer's name, on an activity the app started itself.
  var hostName: String?

  init(sealed: String? = nil, hostName: String? = nil) {
    self.sealed = sealed
    self.hostName = hostName
  }
}

/// One session's turn, as the app last saw it.
struct HuliLocalState: Codable, Hashable {
  var sessionId: String
  /// Absent while the user hides what notifications say.
  var title: String?
  var agent: String?
  /// thinking, command, approval, question, waiting, running, done or error.
  var phase: String
  /// What the session does now, such as its plan's current step or the question it asks.
  var doing: String?
  /// When the turn started and ended, in ms since the epoch.
  var startedAt: Double?
  var endedAt: Double?
  /// Sessions running, and sessions waiting for the user, on the computer.
  var running: Int
  var waiting: Int
}
