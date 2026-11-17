// What the app and the widget extension both compile (withWidgets.js copies it into the extension,
// withSystem.js into the app): the huli:// links Siri, Shortcuts and the Control Center controls
// open, how they hand one to the app, the sessions snapshot they read, and the intent the controls
// run. An intent that opens the app runs in the app, which is why the system wants it in both
// targets; it leaves its link in the App Group, which the app's HuliSystem module takes at once
// when it runs, or when the app next comes to the front (modules/huli-system).

import AppIntents
import Foundation

/// The links the system integrations open (src/links.ts), and how they reach the app.
enum HuliOpen {
  /// The App Group both targets hold (withWidgets.js puts its name in both Info.plists).
  static let appGroup: String =
    (Bundle.main.object(forInfoDictionaryKey: "HuliAppGroup") as? String)
    ?? "group.io.github.rsdvb.huli"

  /// Where a link waits for the app; modules/huli-system reads the same key and notification.
  static let pendingKey = "huli.system.open"
  static let notification = Notification.Name("HuliSystemOpenURL")

  /// The 会话 tab of the active computer.
  static let appURL = URL(string: "huli://")!

  /// Leaves a link for the app and tells its module, if it runs in this process.
  static func request(_ url: URL) {
    UserDefaults(suiteName: appGroup)?.set(
      ["url": url.absoluteString, "at": Date().timeIntervalSince1970], forKey: pendingKey)
    NotificationCenter.default.post(name: notification, object: nil)
  }

  /// Only ASCII letters and digits stay as they are: links.ts reads `+` as a space.
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  static func encode(_ text: String) -> String {
    text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
  }

  private static func link(_ path: String, _ query: [(String, String?)]) -> URL {
    var parts: [String] = []
    for pair in query {
      if let value = pair.1, !value.isEmpty {
        parts.append("\(pair.0)=\(encode(value))")
      }
    }
    let text = "huli://\(path)" + (parts.isEmpty ? "" : "?" + parts.joined(separator: "&"))
    return URL(string: text) ?? appURL
  }

  /// A new session, its composer filled with `text`.
  static func newSession(text: String?) -> URL {
    let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
    return link("new", [("text", trimmed.map { String($0.prefix(8000)) })])
  }

  static func session(_ id: String, host: String?) -> URL {
    link("session/\(encode(id))", [("host", host)])
  }

  static func search(_ query: String) -> URL {
    link("search", [("q", query.trimmingCharacters(in: .whitespacesAndNewlines))])
  }

  static func sessions(host: String?) -> URL {
    link("", [("host", host)])
  }
}

/// The sessions snapshot the app writes for the widget (src/live/widget.ts).
struct HuliSessionsSnapshot: Decodable {
  struct Row: Decodable {
    let id: String
    /// Absent while the user hides what notifications say.
    let title: String?
    /// waiting, running, error, done or idle.
    let state: String
    let agent: String?
    /// When the session last changed, in ms since the epoch.
    let at: Double
  }

  let v: Int
  /// When the app wrote it, in ms since the epoch.
  let at: Double
  let paired: Bool
  let host: String?
  /// The computer's id in the app, which links name it by.
  let hostId: String?
  let running: Int
  let waiting: Int
  let sessions: [Row]

  var date: Date { Date(timeIntervalSince1970: at / 1000) }

  static func load() -> HuliSessionsSnapshot? {
    guard let defaults = UserDefaults(suiteName: HuliOpen.appGroup),
      let text = defaults.string(forKey: "huli.widget.snapshot"),
      let snapshot = try? JSONDecoder().decode(HuliSessionsSnapshot.self, from: Data(text.utf8)),
      snapshot.v == 1
    else { return nil }
    return snapshot
  }

  /// The session that waits for the user, or the sessions when none does.
  var waitingURL: URL {
    if let row = sessions.first(where: { $0.state == "waiting" }) {
      return HuliOpen.session(row.id, host: hostId)
    }
    return HuliOpen.sessions(host: hostId)
  }
}

extension HuliSessionsSnapshot.Row {
  var stateLabel: String {
    switch state {
    case "waiting": return "等你处理"
    case "running": return "运行中"
    case "error": return "出错"
    case "done": return "完成"
    default: return "空闲"
    }
  }

  /// Its title, or what it is without one while titles are hidden.
  var name: String { title ?? "\(agent ?? "Huli") 会话" }
}

/// The places of the app the Control Center controls open.
enum HuliPlace: String, AppEnum {
  case newSession
  case waiting

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Huli 页面")
  static let caseDisplayRepresentations: [HuliPlace: DisplayRepresentation] = [
    .newSession: DisplayRepresentation(title: "新建会话"),
    .waiting: DisplayRepresentation(title: "等你处理"),
  ]
}

/// Opens the app on a new session, or on the session that waits for the user.
struct HuliOpenPlaceIntent: OpenIntent {
  static let title: LocalizedStringResource = "打开 Huli"
  static let description: IntentDescription? = IntentDescription(
    "打开 Huli 新建会话，或者打开等你处理的会话。")

  @Parameter(title: "页面")
  var target: HuliPlace

  init() {}

  init(target: HuliPlace) {
    self.target = target
  }

  func perform() async throws -> some IntentResult {
    switch target {
    case .newSession:
      HuliOpen.request(HuliOpen.newSession(text: nil))
    case .waiting:
      HuliOpen.request(HuliSessionsSnapshot.load()?.waitingURL ?? HuliOpen.appURL)
    }
    return .result()
  }
}
