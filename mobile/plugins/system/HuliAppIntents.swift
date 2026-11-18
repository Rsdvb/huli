// Huli's App Intents, which withSystem.js compiles into the app: Siri, the Shortcuts app, Spotlight
// and the Action button. None of them reaches the computer, which only the running app talks to:
// they read the sessions snapshot the app last wrote to the App Group, or open the app on a
// huli:// link (HuliOpenIntents.swift). Titles are absent from the snapshot while the user hides
// what notifications say, and then nothing here says them either. Siri knows the phrases in
// Chinese from zh-Hans.lproj/AppShortcuts.strings, which withSystem.js writes from these.

import AppIntents
import Foundation

/// A session on the paired computer, as the snapshot lists it.
struct HuliSessionEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "纸鸢会话")
  static let defaultQuery = HuliSessionQuery()

  /// `<computer id>:<session id>`, so a saved shortcut still opens it on its own computer.
  let id: String
  let name: String
  let detail: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: "\(detail)")
  }

  var url: URL {
    guard let colon = id.firstIndex(of: ":") else { return HuliOpen.session(id, host: nil) }
    let host = String(id[..<colon])
    let session = String(id[id.index(after: colon)...])
    return HuliOpen.session(session, host: host.isEmpty ? nil : host)
  }
}

extension HuliSessionEntity {
  init(row: HuliSessionsSnapshot.Row, host: String?) {
    let agent = row.title == nil ? nil : row.agent
    self.init(
      id: "\(host ?? ""):\(row.id)",
      name: row.name,
      detail: [row.stateLabel, agent].compactMap { $0 }.joined(separator: " · "))
  }

  /// The sessions of the snapshot, those that wait first, then the latest.
  static func all() -> [HuliSessionEntity] {
    guard let snapshot = HuliSessionsSnapshot.load(), snapshot.paired else { return [] }
    return snapshot.sessions.map { HuliSessionEntity(row: $0, host: snapshot.hostId) }
  }
}

struct HuliSessionQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [HuliSessionEntity] {
    let known = HuliSessionEntity.all()
    // A session the snapshot no longer lists still opens: the app says if it is gone.
    return identifiers.map { id in
      known.first { $0.id == id } ?? HuliSessionEntity(id: id, name: "纸鸢会话", detail: "")
    }
  }

  func entities(matching string: String) async throws -> [HuliSessionEntity] {
    let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
    let all = HuliSessionEntity.all()
    if query.isEmpty { return all }
    return all.filter {
      $0.name.localizedCaseInsensitiveContains(query)
        || $0.detail.localizedCaseInsensitiveContains(query)
    }
  }

  func suggestedEntities() async throws -> [HuliSessionEntity] {
    HuliSessionEntity.all()
  }
}

/// 新建 Huli 会话: the app opens on a new session with the text in its composer, to send from there.
struct HuliNewSessionIntent: AppIntent {
  static let title: LocalizedStringResource = "新建纸鸢会话"
  static let description: IntentDescription? = IntentDescription(
    "打开纸鸢新建会话，把这段话先填进输入框，你确认后再发给电脑上的 Agent。")
  static let openAppWhenRun: Bool = true

  @Parameter(title: "内容", requestValueDialog: IntentDialog("想让 Agent 做什么？"))
  var text: String

  func perform() async throws -> some IntentResult {
    HuliOpen.request(HuliOpen.newSession(text: text))
    return .result()
  }
}

/// 打开 Huli 会话: one of the sessions the app last saw.
struct HuliOpenSessionIntent: OpenIntent {
  static let title: LocalizedStringResource = "打开纸鸢会话"
  static let description: IntentDescription? = IntentDescription("在纸鸢里打开电脑上的一个会话。")

  @Parameter(title: "会话", requestValueDialog: IntentDialog("打开哪个会话？"))
  var target: HuliSessionEntity

  func perform() async throws -> some IntentResult {
    HuliOpen.request(target.url)
    return .result()
  }
}

/// Huli 有几个在等我: answered from the snapshot, without opening the app.
struct HuliWaitingIntent: AppIntent {
  static let title: LocalizedStringResource = "纸鸢有几个在等我"
  static let description: IntentDescription? = IntentDescription(
    "说出电脑上有几个会话在等你处理、几个正在运行。数字是纸鸢上次打开时看到的。")

  func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
    guard let snapshot = HuliSessionsSnapshot.load(), snapshot.paired else {
      return .result(value: 0, dialog: IntentDialog("纸鸢还没有配对电脑。打开纸鸢配对以后再问我。"))
    }
    let answer = HuliWaitingIntent.answer(snapshot)
    return .result(value: snapshot.waiting, dialog: IntentDialog("\(answer)"))
  }

  static func answer(_ snapshot: HuliSessionsSnapshot) -> String {
    let waiting = snapshot.waiting
    let running = snapshot.running
    var text: String
    if waiting == 0 {
      text = running == 0 ? "现在没有会话在等你，也没有在运行的。" : "没有会话在等你，有 \(running) 个正在运行。"
    } else {
      let names = snapshot.sessions
        .filter { $0.state == "waiting" }
        .compactMap { $0.title }
        .prefix(3)
      text = "有 \(waiting) 个会话在等你"
      if !names.isEmpty { text += "：" + names.joined(separator: "、") }
      text += running > 0 ? "。另有 \(running) 个正在运行。" : "。"
    }
    // The app writes the snapshot only while it runs, so an old one says so.
    if Date().timeIntervalSince(snapshot.date) > 120 {
      let formatter = RelativeDateTimeFormatter()
      formatter.locale = Locale(identifier: "zh-Hans")
      text += "这是纸鸢\(formatter.localizedString(for: snapshot.date, relativeTo: Date()))看到的。"
    }
    return text
  }
}

/// 搜索 Huli: the app's search, the text filled in and searched.
struct HuliSearchIntent: AppIntent {
  static let title: LocalizedStringResource = "搜索纸鸢"
  static let description: IntentDescription? = IntentDescription("在纸鸢里搜索会话。")
  static let openAppWhenRun: Bool = true

  @Parameter(title: "搜索内容", requestValueDialog: IntentDialog("要搜什么？"))
  var query: String

  func perform() async throws -> some IntentResult {
    HuliOpen.request(HuliOpen.search(query))
    return .result()
  }
}

// The initializer with a short title and a symbol is iOS 17's; on iOS 16 the intents are still in
// the Shortcuts app, only without Siri phrases.
@available(iOS 17.0, *)
struct HuliShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: HuliNewSessionIntent(),
      phrases: [
        "用\(.applicationName)新建会话",
        "在\(.applicationName)里新建会话",
        "\(.applicationName)新建会话",
      ],
      shortTitle: "新建会话",
      systemImageName: "plus.bubble"
    )
    AppShortcut(
      intent: HuliOpenSessionIntent(),
      phrases: [
        "打开\(.applicationName)会话",
        "用\(.applicationName)打开会话",
      ],
      shortTitle: "打开会话",
      systemImageName: "text.bubble"
    )
    AppShortcut(
      intent: HuliWaitingIntent(),
      phrases: [
        "\(.applicationName)有几个在等我",
        "\(.applicationName)有几个会话在等我",
        "\(.applicationName)有什么在等我",
      ],
      shortTitle: "有几个在等我",
      systemImageName: "hand.raised"
    )
    AppShortcut(
      intent: HuliSearchIntent(),
      phrases: [
        "搜索\(.applicationName)",
        "在\(.applicationName)里搜索",
      ],
      shortTitle: "搜索",
      systemImageName: "magnifyingglass"
    )
  }
}
