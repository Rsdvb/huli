// Huli's widget extension: the home-screen and Lock Screen widget of the sessions on the paired
// computer, and the Live Activity of a session's turn or of the requests that wait for the user.

import SwiftUI
import WidgetKit

@main
struct HuliWidgets: WidgetBundle {
  var body: some Widget {
    HuliSessionsWidget()
    HuliLiveActivity()
  }
}

enum Huli {
  static let accent = Color(red: 238 / 255, green: 122 / 255, blue: 62 / 255)

  /// The App Group the app writes the widget's snapshot to (withWidgets.js puts it in Info.plist).
  static let appGroup: String =
    (Bundle.main.object(forInfoDictionaryKey: "HuliAppGroup") as? String)
    ?? "group.io.github.rsdvb.huli"

  static let home = URL(string: "huli://")!

  /// A session's screen in the app: huli://session/<id>, which Expo Router opens.
  static func sessionURL(_ id: String?) -> URL {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
    guard let id, !id.isEmpty,
      let path = id.addingPercentEncoding(withAllowedCharacters: allowed),
      let url = URL(string: "huli://session/\(path)")
    else { return home }
    return url
  }

  /// A duration as a stopped timer shows it: 4:05, or 1:04:05.
  static func clock(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded()))
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let rest = total % 60
    return hours > 0
      ? String(format: "%d:%02d:%02d", hours, minutes, rest)
      : String(format: "%d:%02d", minutes, rest)
  }
}

extension View {
  /// The widget's background: the container's from iOS 17, which also sets the margins.
  @ViewBuilder
  func widgetBackground<S: ShapeStyle>(_ style: S, padded: Bool = true) -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(style, for: .widget)
    } else if padded {
      padding().background(style)
    } else {
      background(style)
    }
  }
}
