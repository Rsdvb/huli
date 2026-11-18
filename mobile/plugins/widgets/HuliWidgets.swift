// Huli's widget extension: the home-screen and Lock Screen widget of the sessions on the paired
// computer, the Live Activity of a session's turn or of the requests that wait for the user, and
// from iOS 18 the controls that open the app (HuliControls.swift).

import SwiftUI
import WidgetKit

@main
struct HuliWidgets: WidgetBundle {
  var body: some Widget {
    HuliSessionsWidget()
    HuliLiveActivity()
    if #available(iOS 18.0, *) {
      HuliNewSessionControl()
      HuliWaitingControl()
    }
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

/// The app's mark beside its name: Kite's tray glyph (tools/huli/brand/kite-tray.svg), the kite
/// with its shaded half lighter and its string, drawn in the foreground style.
struct KiteMark: View {
  var body: some View {
    ZStack {
      KiteMarkShape(part: .lit)
      KiteMarkShape(part: .shade).opacity(0.55)
    }
    .aspectRatio(1, contentMode: .fit)
  }
}

/// A part of the mark, on the glyph's 18-unit canvas scaled to fit.
struct KiteMarkShape: Shape {
  enum Part { case lit, shade }
  let part: Part

  // The kite's corners: top, right, bottom (where the string is tied) and left.
  private static let top = CGPoint(x: 12.09, y: 1.03)
  private static let right = CGPoint(x: 15.46, y: 6.51)
  private static let bottom = CGPoint(x: 8.94, y: 13.65)
  private static let left = CGPoint(x: 6.54, y: 4.29)

  func path(in rect: CGRect) -> Path {
    let side = min(rect.width, rect.height)
    let scale = side / 18
    let transform = CGAffineTransform(
      translationX: rect.midX - side / 2, y: rect.midY - side / 2
    ).scaledBy(x: scale, y: scale)
    var path = Path()
    switch part {
    case .shade:
      path.addLines([Self.top, Self.right, Self.bottom])
      path.closeSubpath()
    case .lit:
      path.addLines([Self.top, Self.left, Self.bottom])
      path.closeSubpath()
      var string = Path()
      string.move(to: CGPoint(x: 8.95, y: 13.4))
      string.addCurve(
        to: CGPoint(x: 5.4, y: 15.5), control1: CGPoint(x: 8.7, y: 15.1),
        control2: CGPoint(x: 6.7, y: 14.9))
      string.addCurve(
        to: CGPoint(x: 3.1, y: 16.5), control1: CGPoint(x: 4.1, y: 16.1),
        control2: CGPoint(x: 3.4, y: 16.4))
      path.addPath(string.strokedPath(StrokeStyle(lineWidth: 1.25, lineCap: .round)))
      path.addEllipse(in: CGRect(x: 1.5, y: 14.9, width: 2.8, height: 2.8))
    }
    return path.applying(transform)
  }
}

extension View {
  /// The widget's background: the container's from iOS 17, which also sets the margins.
  @ViewBuilder
  func widgetBackground<S: ShapeStyle>(_ style: S, padded: Bool = true) -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(style, for: .widget)
    } else {
      padding(padded ? 16 : 0).background(style)
    }
  }
}
