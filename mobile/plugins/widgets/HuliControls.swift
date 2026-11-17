// Huli's controls for Control Center, the Lock Screen and the Action button (iOS 18): 新建会话, and
// 等你处理 with how many sessions wait as the app last saw them. Each opens the app, where
// HuliOpenPlaceIntent runs (HuliOpenIntents.swift); the app reloads the controls whenever it writes
// the sessions snapshot.

import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 18.0, *)
struct HuliNewSessionControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "io.github.rsdvb.huli.control.new") {
      ControlWidgetButton(action: HuliOpenPlaceIntent(target: .newSession)) {
        Label("新建会话", systemImage: "plus.bubble")
      }
    }
    .displayName("新建 Huli 会话")
    .description("打开 Huli，新建一个会话。")
  }
}

@available(iOS 18.0, *)
struct HuliWaitingControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "io.github.rsdvb.huli.control.waiting") {
      ControlWidgetButton(action: HuliOpenPlaceIntent(target: .waiting)) {
        Label(HuliWaitingControl.label(), systemImage: "hand.raised.fill")
      }
    }
    .displayName("Huli 等你处理")
    .description("打开 Huli 里等你处理的会话。")
  }

  static func label() -> String {
    guard let snapshot = HuliSessionsSnapshot.load(), snapshot.paired, snapshot.waiting > 0 else {
      return "等你处理"
    }
    return "\(snapshot.waiting) 个等你处理"
  }
}
