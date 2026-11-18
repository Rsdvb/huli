// The sessions widget: how many sessions run on the paired computer and how many wait for the
// user, and the latest of them, each opening its session. It shows the snapshot the app last wrote
// to the App Group (src/live/widget.ts) and never reaches the computer itself.

import SwiftUI
import WidgetKit

struct WidgetSnapshot: Decodable {
  struct Row: Decodable, Identifiable {
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
  let running: Int
  let waiting: Int
  let sessions: [Row]

  var date: Date { Date(timeIntervalSince1970: at / 1000) }

  static let key = "huli.widget.snapshot"

  static func load() -> WidgetSnapshot? {
    guard let defaults = UserDefaults(suiteName: Huli.appGroup),
      let text = defaults.string(forKey: key),
      let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: Data(text.utf8)),
      snapshot.v == 1
    else { return nil }
    return snapshot
  }

  static var preview: WidgetSnapshot {
    let now = Date().timeIntervalSince1970 * 1000
    return WidgetSnapshot(
      v: 1, at: now, paired: true, host: "MacBook Pro", running: 2, waiting: 1,
      sessions: [
        Row(id: "a", title: "修复登录页的样式", state: "waiting", agent: "Claude Code", at: now),
        Row(id: "b", title: "给设置页加实时活动开关", state: "running", agent: "Codex", at: now),
        Row(id: "c", title: "整理发布说明", state: "running", agent: "Claude Code", at: now),
      ])
  }

  /// Where tapping the widget as a whole goes: the session that waits, or the app.
  var url: URL {
    if let first = sessions.first(where: { $0.state == "waiting" }) {
      return Huli.sessionURL(first.id)
    }
    return Huli.home
  }
}

extension WidgetSnapshot.Row {
  var name: String { title ?? agent ?? "会话" }

  var label: String {
    switch state {
    case "waiting": return "等你处理"
    case "running": return "运行中"
    case "error": return "出错"
    case "done": return "完成"
    default: return "空闲"
    }
  }

  var symbol: String {
    switch state {
    case "waiting": return "hand.raised.fill"
    case "running": return "bolt.fill"
    case "error": return "exclamationmark.triangle.fill"
    case "done": return "checkmark.circle.fill"
    default: return "circle"
    }
  }

  var tint: Color {
    switch state {
    case "waiting", "running": return Huli.accent
    case "error": return .red
    case "done": return .green
    default: return .secondary
    }
  }
}

struct SessionsEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot?
}

struct SessionsProvider: TimelineProvider {
  func placeholder(in context: Context) -> SessionsEntry {
    SessionsEntry(date: Date(), snapshot: WidgetSnapshot.preview)
  }

  func getSnapshot(in context: Context, completion: @escaping (SessionsEntry) -> Void) {
    let snapshot = WidgetSnapshot.load() ?? (context.isPreview ? WidgetSnapshot.preview : nil)
    completion(SessionsEntry(date: Date(), snapshot: snapshot))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<SessionsEntry>) -> Void) {
    // Only the app knows when the sessions change; it reloads the timeline when they do.
    let entry = SessionsEntry(date: Date(), snapshot: WidgetSnapshot.load())
    completion(Timeline(entries: [entry], policy: .never))
  }
}

struct HuliSessionsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HuliSessions", provider: SessionsProvider()) { entry in
      SessionsWidgetView(entry: entry)
    }
    .configurationDisplayName("纸鸢会话")
    .description("电脑上有几个会话在运行、几个在等你，点一下直接打开。")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
  }
}

struct SessionsWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: SessionsEntry

  var body: some View {
    switch family {
    case .accessoryCircular:
      CircularSessions(snapshot: entry.snapshot)
        .widgetBackground(Color.clear, padded: false)
    case .accessoryRectangular:
      RectangularSessions(snapshot: entry.snapshot)
        .widgetBackground(Color.clear, padded: false)
    case .systemMedium:
      MediumSessions(snapshot: entry.snapshot)
        .widgetBackground(.background)
    default:
      SmallSessions(snapshot: entry.snapshot)
        .widgetBackground(.background)
    }
  }
}

private struct Header: View {
  let date: Date?

  var body: some View {
    HStack(spacing: 5) {
      KiteMark()
        .frame(width: 14, height: 14)
        .foregroundStyle(Huli.accent)
      Text("纸鸢")
        .font(.caption.weight(.semibold))
      Spacer(minLength: 4)
      if let date {
        Text(date, style: .time)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
  }
}

private struct Stat: View {
  let value: Int
  let label: String
  let tint: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("\(value)")
        .font(.system(size: 30, weight: .semibold, design: .rounded))
        .foregroundStyle(tint)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      Text(label)
        .font(.caption2.weight(.medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
  }
}

private struct Unpaired: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Header(date: nil)
      Spacer(minLength: 0)
      Text("打开纸鸢配对电脑")
        .font(.subheadline.weight(.semibold))
      Text("配对后，这里会显示电脑上的会话。")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(Huli.home)
  }
}

private struct SessionLine: View {
  let row: WidgetSnapshot.Row

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: row.symbol)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(row.tint)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 1) {
        Text(row.name)
          .font(.subheadline.weight(.medium))
          .lineLimit(1)
        Text(row.title != nil && row.agent != nil ? "\(row.label) · \(row.agent!)" : row.label)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
  }
}

private struct SmallSessions: View {
  let snapshot: WidgetSnapshot?

  var body: some View {
    if let snapshot, snapshot.paired {
      VStack(alignment: .leading, spacing: 0) {
        Header(date: snapshot.date)
        Spacer(minLength: 6)
        HStack(alignment: .top, spacing: 16) {
          Stat(value: snapshot.running, label: "运行中", tint: .primary)
          Stat(
            value: snapshot.waiting, label: "等你处理",
            tint: snapshot.waiting > 0 ? Huli.accent : .secondary)
        }
        Spacer(minLength: 6)
        if let first = snapshot.sessions.first {
          Text(first.name)
            .font(.caption.weight(.medium))
            .lineLimit(1)
          Text(first.label)
            .font(.caption2)
            .foregroundStyle(first.tint)
            .lineLimit(1)
        } else {
          Text("没有进行中的会话")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .widgetURL(snapshot.url)
    } else {
      Unpaired()
    }
  }
}

private struct MediumSessions: View {
  let snapshot: WidgetSnapshot?

  var body: some View {
    if let snapshot, snapshot.paired {
      HStack(alignment: .top, spacing: 16) {
        VStack(alignment: .leading, spacing: 8) {
          Header(date: nil)
          Spacer(minLength: 0)
          Stat(value: snapshot.running, label: "运行中", tint: .primary)
          Stat(
            value: snapshot.waiting, label: "等你处理",
            tint: snapshot.waiting > 0 ? Huli.accent : .secondary)
        }
        .frame(width: 84, alignment: .leading)
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(snapshot.host ?? "电脑")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
              .lineLimit(1)
            Spacer(minLength: 4)
            Text(snapshot.date, style: .time)
              .font(.caption2)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
          if snapshot.sessions.isEmpty {
            Spacer(minLength: 0)
            Text("没有进行中的会话")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          } else {
            ForEach(Array(snapshot.sessions.prefix(3))) { row in
              Link(destination: Huli.sessionURL(row.id)) {
                SessionLine(row: row)
              }
            }
          }
          Spacer(minLength: 0)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .widgetURL(snapshot.url)
    } else {
      Unpaired()
    }
  }
}

private struct CircularSessions: View {
  let snapshot: WidgetSnapshot?

  var body: some View {
    let waiting = snapshot?.waiting ?? 0
    let running = snapshot?.running ?? 0
    ZStack {
      AccessoryWidgetBackground()
      VStack(spacing: 0) {
        Image(systemName: waiting > 0 ? "hand.raised.fill" : "bolt.fill")
          .font(.system(size: 12, weight: .semibold))
        Text("\(waiting > 0 ? waiting : running)")
          .font(.system(size: 20, weight: .semibold, design: .rounded))
          .lineLimit(1)
          .minimumScaleFactor(0.6)
      }
    }
    .widgetAccentable()
    .widgetURL(snapshot?.url ?? Huli.home)
  }
}

private struct RectangularSessions: View {
  let snapshot: WidgetSnapshot?

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 4) {
        KiteMark()
          .frame(width: 16, height: 16)
        Text("纸鸢")
      }
      .font(.headline)
      .widgetAccentable()
      if let snapshot, snapshot.paired {
        Text("\(snapshot.running) 个运行中 · \(snapshot.waiting) 个等你")
          .font(.caption)
          .lineLimit(1)
        if let first = snapshot.sessions.first {
          Text("\(first.label)：\(first.name)")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      } else {
        Text("打开纸鸢配对电脑")
          .font(.caption)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .widgetURL(snapshot?.url ?? Huli.home)
  }
}
