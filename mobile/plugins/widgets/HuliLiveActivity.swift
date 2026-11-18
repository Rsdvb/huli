// The Live Activity on the Lock Screen and in the Dynamic Island. Two kinds share it: the one the
// computer starts by push while requests wait for the user (its attributes and state sealed to this
// phone, opened here), and the one that follows a session's turn: the app starts it while it is
// open, or the computer by push, and the computer keeps it up to date while the app is away, with
// sealed states of its own. Tapping either opens the session in the app. Answering a request takes
// the app's encrypted link to the computer, which an extension does not have, so the activity
// offers no buttons of its own.

import ActivityKit
import SwiftUI
import WidgetKit

enum LivePhase: String {
  case starting, thinking, writing, command, read, search, edit
  case approval, question, waiting, running, done, error

  var label: String {
    switch self {
    case .starting: return "正在启动"
    case .thinking: return "思考中"
    case .writing: return "正在回复"
    case .command: return "正在运行命令"
    case .read: return "正在读取文件"
    case .search: return "正在搜索"
    case .edit: return "正在编辑文件"
    case .approval: return "等你批准"
    case .question: return "等你回答"
    case .waiting: return "等你处理"
    case .running: return "运行中"
    case .done: return "完成"
    case .error: return "出错"
    }
  }

  /// A word or two, for the compact Dynamic Island.
  var short: String {
    switch self {
    case .starting: return "启动"
    case .thinking: return "思考"
    case .writing: return "回复"
    case .command: return "命令"
    case .read: return "读取"
    case .search: return "搜索"
    case .edit: return "编辑"
    case .approval: return "批准"
    case .question: return "回答"
    case .waiting: return "等你"
    case .running: return "运行"
    case .done: return "完成"
    case .error: return "出错"
    }
  }

  var symbol: String {
    switch self {
    case .starting: return "hourglass"
    case .thinking: return "sparkles"
    case .writing: return "text.bubble.fill"
    case .command: return "terminal.fill"
    case .read: return "doc.text.fill"
    case .search: return "magnifyingglass"
    case .edit: return "pencil"
    case .approval: return "hand.raised.fill"
    case .question: return "questionmark.bubble.fill"
    case .waiting: return "bell.badge.fill"
    case .running: return "bolt.fill"
    case .done: return "checkmark.circle.fill"
    case .error: return "exclamationmark.triangle.fill"
    }
  }

  var tint: Color {
    switch self {
    case .done: return .green
    case .error: return .red
    default: return Huli.accent
    }
  }

  var needsYou: Bool { self == .approval || self == .question || self == .waiting }
  var finished: Bool { self == .done || self == .error }
}

/// What an activity shows, from either kind.
struct LiveModel {
  var phase: LivePhase
  var title: String
  var detail: String?
  /// The agent and the computer.
  var source: String?
  var since: Date?
  var until: Date?
  var running: Int?
  var waiting: Int?
  /// The plan's steps done and in all, and the subagents at work, for a turn.
  var plan: (done: Int, total: Int)?
  var subagents: Int?
  var url: URL

  init(attributes: HuliActivityAttributes, state: HuliActivityAttributes.ContentState) {
    if let local = state.local {
      self.init(local: local, attributes: attributes)
      return
    }
    let keys = SharedKeys.load()
    let info = Sealed.open(attributes.sealed, keys: keys)
    let content = Sealed.open(state.sealed, keys: keys)
    if let content, (content["kind"] as? String) == "progress" {
      self.init(
        progress: content,
        hostName: LiveModel.text(info?["hostName"]) ?? LiveModel.text(attributes.hostName),
        quiet: keys?.quiet == true)
    } else {
      self.init(waiting: content, info: info, quiet: keys?.quiet == true)
    }
  }

  private init(local: HuliLocalState, attributes: HuliActivityAttributes) {
    phase = LivePhase(rawValue: local.phase) ?? .running
    title = LiveModel.text(local.title) ?? LiveModel.text(local.agent) ?? "纸鸢会话"
    detail = LiveModel.text(local.doing)
    // One the computer started by push names the computer only in its sealed attributes.
    let hostName =
      LiveModel.text(attributes.hostName)
      ?? (attributes.sealed == nil
        ? nil : LiveModel.text(Sealed.open(attributes.sealed, keys: SharedKeys.load())?["hostName"]))
    let parts = [local.title == nil ? nil : LiveModel.text(local.agent), hostName]
      .compactMap { $0 }
    source = parts.isEmpty ? nil : parts.joined(separator: " · ")
    since = local.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    until = local.endedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    running = local.running
    waiting = local.waiting
    if let done = local.planDone, let total = local.planTotal, total > 0 {
      plan = (done, total)
    } else {
      plan = nil
    }
    subagents = local.subagents
    url = Huli.sessionURL(local.sessionId)
  }

  /// What waits for the user, as the computer counts it, from the activity it started for that.
  private init(waiting content: [String: Any]?, info: [String: Any]?, quiet: Bool) {
    plan = nil
    subagents = nil
    let count = content?["count"] as? Int
    let sessionTitle = quiet ? nil : LiveModel.text(content?["title"])
    let hostName = LiveModel.text(content?["hostName"]) ?? LiveModel.text(info?["hostName"])

    phase = count == 0 ? .done : .waiting
    if count == 0 {
      title = "都处理好了"
      detail = nil
    } else if let sessionTitle {
      title = sessionTitle
      if let count, count > 1 {
        detail = "共 \(count) 个请求等你处理"
      } else {
        detail = "有请求等你处理"
      }
    } else if let count, count > 1 {
      title = "\(count) 个请求等你处理"
      detail = nil
    } else {
      title = "有请求等你处理"
      detail = content == nil ? "打开纸鸢查看" : nil
    }
    source = hostName ?? "纸鸢"
    since = (info?["at"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
    until = nil
    running = nil
    waiting = count
    url = Huli.sessionURL(content?["sessionId"] as? String)
  }

  /// A session's turn, as the computer follows it (ProgressState in src/shared/remote/push.ts).
  /// A newer `format` may add fields; what this build knows of it still shows.
  private init(progress content: [String: Any], hostName: String?, quiet: Bool) {
    phase = LivePhase(rawValue: content["phase"] as? String ?? "") ?? .running
    let sessionTitle = quiet ? nil : LiveModel.text(content["title"])
    let agent = LiveModel.text(content["agent"])
    title = sessionTitle ?? agent ?? "纸鸢会话"
    let planInfo = content["plan"] as? [String: Any]
    let current = quiet ? nil : LiveModel.text(planInfo?["current"])
    if phase == .done {
      detail = "这一轮已完成"
    } else if phase == .error {
      detail = "这一轮出错了"
    } else if !quiet, let step = LiveModel.text(content["step"]) {
      detail = step
    } else if let current {
      detail = "正在：\(current)"
    } else {
      detail = nil
    }
    let parts = [sessionTitle == nil ? nil : agent, LiveModel.text(content["hostName"]) ?? hostName]
      .compactMap { $0 }
    source = parts.isEmpty ? nil : parts.joined(separator: " · ")
    since = (content["startedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
    until = (content["endedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
    running = content["running"] as? Int
    waiting = content["waiting"] as? Int
    if let done = planInfo?["done"] as? Int, let total = planInfo?["total"] as? Int, total > 0 {
      plan = (done, total)
    } else {
      plan = nil
    }
    subagents = content["subagents"] as? Int
    url = Huli.sessionURL(content["sessionId"] as? String)
  }

  /// The line under the title; a state that may have gone stale says so.
  func detailLine(stale: Bool) -> String? {
    if stale && !phase.finished { return "可能不是最新，打开纸鸢查看" }
    return detail
  }

  var hasCounts: Bool {
    (running ?? 0) > 0 || (waiting ?? 0) > 0 || plan != nil || (subagents ?? 0) > 0
  }

  private static func text(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty else { return nil }
    return text
  }
}

/// How long the turn has run: a live timer, or the final time once it ended.
struct Elapsed: View {
  let since: Date?
  let until: Date?

  var body: some View {
    if let since {
      if let until {
        Text(Huli.clock(until.timeIntervalSince(since)))
      } else {
        // The range's end only stops the timer; a day is longer than any activity lives.
        Text(timerInterval: since...max(since, Date()).addingTimeInterval(86_400), countsDown: false)
      }
    }
  }
}

struct PhaseBadge: View {
  let phase: LivePhase
  var size: CGFloat = 40

  var body: some View {
    ZStack {
      Circle().fill(phase.tint.opacity(0.18))
      Image(systemName: phase.symbol)
        .font(.system(size: size * 0.42, weight: .semibold))
        .foregroundStyle(phase.tint)
    }
    .frame(width: size, height: size)
  }
}

struct LiveCounts: View {
  let model: LiveModel

  var body: some View {
    HStack(spacing: 10) {
      if let plan = model.plan {
        Label("\(plan.done)/\(plan.total)", systemImage: "checklist")
      }
      if let subagents = model.subagents, subagents > 0 {
        Label("\(subagents)", systemImage: "person.2.fill")
      }
      if let running = model.running, running > 0 {
        Label("\(running) 运行中", systemImage: "bolt.fill")
      }
      if let waiting = model.waiting, waiting > 0 {
        Label("\(waiting) 等你", systemImage: "hand.raised.fill")
          .foregroundStyle(Huli.accent)
      }
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(.secondary)
    .lineLimit(1)
  }
}

/// How far the turn's plan got, as a thin bar under the Lock Screen's text.
struct PlanBar: View {
  let model: LiveModel

  var body: some View {
    if let plan = model.plan, !model.phase.finished {
      ProgressView(value: Double(min(plan.done, plan.total)), total: Double(plan.total))
        .progressViewStyle(.linear)
        .tint(model.phase.tint)
    }
  }
}

struct LiveLockScreen: View {
  let model: LiveModel
  let stale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 12) {
        PhaseBadge(phase: model.phase)
        VStack(alignment: .leading, spacing: 2) {
          Text(model.title)
            .font(.headline)
            .lineLimit(1)
          if let source = model.source {
            Text(source)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 2) {
          Elapsed(since: model.since, until: model.until)
            .font(.title3.weight(.semibold).monospacedDigit())
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 96, alignment: .trailing)
          Text(model.phase.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(model.phase.tint)
            .lineLimit(1)
        }
      }
      let line = model.detailLine(stale: stale)
      if line != nil || model.hasCounts {
        HStack(spacing: 8) {
          Text(line ?? "")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Spacer(minLength: 4)
          LiveCounts(model: model)
        }
      }
      PlanBar(model: model)
    }
    .padding(16)
  }
}

struct LiveExpandedBottom: View {
  let model: LiveModel
  let stale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(model.title)
        .font(.headline)
        .lineLimit(1)
      if let line = model.detailLine(stale: stale) {
        Text(line)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
      HStack(spacing: 8) {
        if let source = model.source {
          Text(source)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        LiveCounts(model: model)
        Link(destination: model.url) {
          Text(model.phase.needsYou ? "去处理" : "查看")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(Huli.accent.opacity(0.22)))
            .foregroundStyle(Huli.accent)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 4)
  }
}

struct LiveCompactTrailing: View {
  let model: LiveModel

  var body: some View {
    if model.phase.needsYou, let waiting = model.waiting, waiting > 0 {
      Text("\(waiting)")
        .font(.system(size: 15, weight: .semibold).monospacedDigit())
        .foregroundStyle(Huli.accent)
    } else if model.since != nil && !model.phase.finished {
      Elapsed(since: model.since, until: nil)
        .font(.system(size: 14, weight: .semibold).monospacedDigit())
        .multilineTextAlignment(.trailing)
        .frame(width: 46, alignment: .trailing)
        .foregroundStyle(model.phase.tint)
    } else {
      Text(model.phase.short)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(model.phase.tint)
    }
  }
}

struct HuliLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: HuliActivityAttributes.self) { context in
      let model = LiveModel(attributes: context.attributes, state: context.state)
      LiveLockScreen(model: model, stale: context.isStale)
        .activitySystemActionForegroundColor(Huli.accent)
        .widgetURL(model.url)
    } dynamicIsland: { context in
      let model = LiveModel(attributes: context.attributes, state: context.state)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 6) {
            Image(systemName: model.phase.symbol)
            Text(model.phase.label)
              .lineLimit(1)
          }
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(model.phase.tint)
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Elapsed(since: model.since, until: model.until)
            .font(.subheadline.weight(.semibold).monospacedDigit())
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 80, alignment: .trailing)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          LiveExpandedBottom(model: model, stale: context.isStale)
        }
      } compactLeading: {
        Image(systemName: model.phase.symbol)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(model.phase.tint)
      } compactTrailing: {
        LiveCompactTrailing(model: model)
      } minimal: {
        Image(systemName: model.phase.symbol)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(model.phase.tint)
      }
      .widgetURL(model.url)
      .keylineTint(Huli.accent)
    }
  }
}
