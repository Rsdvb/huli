// Huli's bridge to ActivityKit and WidgetKit. It watches every HuliActivityAttributes activity from
// launch, the ones the computer starts by push included, with their push tokens and the token that
// lets the computer start one; JavaScript reads them all as one JSON snapshot after each "onChange"
// and gives the computer the tokens over the link. It also starts, updates and ends the activities
// the app runs itself, and hands the home-screen widget its snapshot through the App Group.

import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

public final class HuliLiveModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HuliLive")

    Events("onChange")

    OnCreate {
      LiveActivities.shared.begin { [weak self] in
        self?.sendEvent("onChange")
      }
    }

    Function("isEnabled") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    Function("snapshot") { () -> String in
      LiveActivities.shared.snapshot()
    }

    AsyncFunction("start") { (attributes: String, state: String, staleSeconds: Double) -> String in
      try LiveActivities.shared.start(
        attributesJSON: attributes, stateJSON: state, staleSeconds: staleSeconds)
    }

    AsyncFunction("update") { (id: String, state: String, staleSeconds: Double, promise: Promise) in
      LiveActivities.shared.update(id: id, stateJSON: state, staleSeconds: staleSeconds) {
        promise.resolve()
      }
    }

    AsyncFunction("end") { (id: String, state: String, dismissSeconds: Double, promise: Promise) in
      LiveActivities.shared.end(id: id, stateJSON: state, dismissSeconds: dismissSeconds) {
        promise.resolve()
      }
    }

    Function("setWidgetSnapshot") { (json: String) in
      WidgetData.save(json)
    }
  }
}

struct LiveActivityError: Error {
  let reason: String
}

/// Every Huli activity on the phone and its tokens. ActivityKit hands tokens over async sequences,
/// which run on their own tasks, so the state sits behind a lock.
final class LiveActivities {
  static let shared = LiveActivities()

  private let lock = NSLock()
  private var started = false
  private var onChange: (() -> Void)?
  private var startToken: String?
  private var tokens: [String: String] = [:]
  private var watched = Set<String>()

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  /// Starts watching, once per launch; a reloaded JavaScript only takes over the notifications.
  func begin(onChange: @escaping () -> Void) {
    let first: Bool = locked {
      self.onChange = onChange
      if self.started { return false }
      self.started = true
      return true
    }
    guard first else { return }
    for activity in Activity<HuliActivityAttributes>.activities {
      watch(activity)
    }
    Task {
      for await activity in Activity<HuliActivityAttributes>.activityUpdates {
        self.watch(activity)
        self.changed()
      }
    }
    if #available(iOS 17.2, *) {
      Task {
        for await data in Activity<HuliActivityAttributes>.pushToStartTokenUpdates {
          let token = LiveActivities.hex(data)
          self.locked { self.startToken = token }
          self.changed()
        }
      }
    }
  }

  private func watch(_ activity: Activity<HuliActivityAttributes>) {
    let id = activity.id
    let fresh: Bool = locked { self.watched.insert(id).inserted }
    guard fresh else { return }
    Task {
      for await data in activity.pushTokenUpdates {
        let token = LiveActivities.hex(data)
        self.locked { self.tokens[id] = token }
        self.changed()
      }
    }
    Task {
      for await state in activity.activityStateUpdates {
        if state == .ended || state == .dismissed {
          self.locked { _ = self.tokens.removeValue(forKey: id) }
        }
        self.changed()
      }
    }
  }

  private func changed() {
    let notify = locked { self.onChange }
    notify?()
  }

  private func find(_ id: String) -> Activity<HuliActivityAttributes>? {
    Activity<HuliActivityAttributes>.activities.first { $0.id == id }
  }

  /// `{ enabled, startToken?, activities: [{ id, state, local, sealed?, token?, sessionId? }] }`
  func snapshot() -> String {
    let (start, known) = locked { (self.startToken, self.tokens) }
    let list: [[String: Any]] = Activity<HuliActivityAttributes>.activities.map { activity in
      var entry: [String: Any] = [
        "id": activity.id,
        "state": LiveActivities.name(activity.activityState),
        "local": activity.attributes.sealed == nil,
      ]
      if let sealed = activity.attributes.sealed { entry["sealed"] = sealed }
      if let token = known[activity.id] { entry["token"] = token }
      if let local = activity.content.state.local { entry["sessionId"] = local.sessionId }
      return entry
    }
    var result: [String: Any] = [
      "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
      "activities": list,
    ]
    if let start { result["startToken"] = start }
    guard let data = try? JSONSerialization.data(withJSONObject: result),
      let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }

  func start(attributesJSON: String, stateJSON: String, staleSeconds: Double) throws -> String {
    let decoder = JSONDecoder()
    let attributes = try decoder.decode(HuliActivityAttributes.self, from: Data(attributesJSON.utf8))
    let state = try decoder.decode(
      HuliActivityAttributes.ContentState.self, from: Data(stateJSON.utf8))
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      throw LiveActivityError(reason: "Live Activities are off")
    }
    let activity = try Activity<HuliActivityAttributes>.request(
      attributes: attributes,
      content: ActivityContent(state: state, staleDate: LiveActivities.staleDate(staleSeconds)),
      pushType: nil
    )
    watch(activity)
    changed()
    return activity.id
  }

  func update(id: String, stateJSON: String, staleSeconds: Double, done: @escaping () -> Void) {
    guard let activity = find(id),
      let state = try? JSONDecoder().decode(
        HuliActivityAttributes.ContentState.self, from: Data(stateJSON.utf8))
    else {
      done()
      return
    }
    let content = ActivityContent(state: state, staleDate: LiveActivities.staleDate(staleSeconds))
    Task {
      await activity.update(content)
      done()
    }
  }

  /// Ends an activity, with a last state when `stateJSON` is not empty; it stays on the Lock
  /// Screen for `dismissSeconds`, or goes at once for 0.
  func end(id: String, stateJSON: String, dismissSeconds: Double, done: @escaping () -> Void) {
    guard let activity = find(id) else {
      done()
      return
    }
    var content: ActivityContent<HuliActivityAttributes.ContentState>? = nil
    if !stateJSON.isEmpty,
      let state = try? JSONDecoder().decode(
        HuliActivityAttributes.ContentState.self, from: Data(stateJSON.utf8))
    {
      content = ActivityContent(state: state, staleDate: nil)
    }
    let policy: ActivityUIDismissalPolicy =
      dismissSeconds > 0 ? .after(Date().addingTimeInterval(dismissSeconds)) : .immediate
    Task {
      await activity.end(content, dismissalPolicy: policy)
      done()
    }
  }

  private static func staleDate(_ seconds: Double) -> Date? {
    seconds > 0 ? Date().addingTimeInterval(seconds) : nil
  }

  private static func name(_ state: ActivityState) -> String {
    switch state {
    case .active: return "active"
    case .ended: return "ended"
    case .dismissed: return "dismissed"
    case .stale: return "stale"
    @unknown default: return "unknown"
    }
  }

  static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}

/// The home-screen widget's snapshot, in the App Group both targets hold; the widget, the controls
/// and the app's Siri intents read it back and never reach the computer themselves.
enum WidgetData {
  static let key = "huli.widget.snapshot"

  static func save(_ json: String) {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "HuliAppGroup") as? String,
      let defaults = UserDefaults(suiteName: group)
    else { return }
    if defaults.string(forKey: key) == json { return }
    defaults.set(json, forKey: key)
    WidgetCenter.shared.reloadAllTimelines()
    // The 等你处理 control in Control Center shows the count too.
    if #available(iOS 18.0, *) {
      ControlCenter.shared.reloadAllControls()
    }
  }
}
