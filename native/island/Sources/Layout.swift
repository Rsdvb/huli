import CoreGraphics

// Huli: the island keeps off the menu bar's items. This file is pure layout arithmetic, with no
// AppKit, so `swift test` checks it on its own (Package.swift builds it without the views).

/// The room the menu bar leaves free beside the notch, in points: on the left up to the end of the
/// front app's menus, on the right up to the first status item. Zero where the island may not go.
struct BarRoom: Equatable {
  var left: CGFloat = 0
  var right: CGFloat = 0

  static let none = BarRoom()

  func capped(at most: CGFloat) -> BarRoom {
    BarRoom(left: min(left, most), right: min(right, most))
  }
}

/// A window as the window list reports it, in global coordinates whose origin is the top left of
/// the main screen.
struct ListedWindow: Equatable {
  var bounds: CGRect
  var layer: Int
  var pid: Int32
}

enum MenuBarRoom {
  /// Kept clear between the island and an item, since the clock and the battery's percentage
  /// change width without anything the helper hears of.
  static let margin: CGFloat = 10

  /// The status items of one menu bar: windows at the status layer inside its band, other than the
  /// helper's own. The band and the windows are in the window list's coordinates.
  static func statusItems(
    in windows: [ListedWindow], band: CGRect, statusLayer: Int, ownPid: Int32
  ) -> [CGRect] {
    windows.compactMap { window in
      let b = window.bounds
      guard window.layer == statusLayer, window.pid != ownPid, b.width > 0, b.height > 0,
        b.width < band.width / 2, b.minY >= band.minY - 2, b.maxY <= band.maxY + 2,
        b.maxX > band.minX, b.minX < band.maxX
      else { return nil }
      return b
    }
  }

  /// The free room on each side of `notch` (only its horizontal extent counts; zero wide on a
  /// screen without one) within `band`, the menu bar. `menuEnd` is where the front app's last menu
  /// ends, nil when it cannot be read, which leaves no room on the left. A menu bar with no status
  /// item at all is hidden, as in a full-screen app, or could not be read: nothing is free then.
  static func room(
    notch: CGRect, band: CGRect, statusItems: [CGRect], menuEnd: CGFloat?, margin: CGFloat = margin
  ) -> BarRoom {
    guard !statusItems.isEmpty else { return .none }
    var left = notch.minX - band.minX
    var right = band.maxX - notch.maxX
    var obstacles = statusItems
    if let menuEnd {
      if menuEnd > band.minX {
        obstacles.append(CGRect(x: band.minX, y: band.minY, width: menuEnd - band.minX, height: 1))
      }
    } else {
      left = 0
    }
    for item in obstacles {
      if item.maxX > notch.maxX { right = min(right, item.minX - notch.maxX) }
      if item.minX < notch.minX { left = min(left, notch.minX - item.maxX) }
    }
    return BarRoom(
      left: max(0, (left - margin).rounded(.down)), right: max(0, (right - margin).rounded(.down)))
  }
}

enum WingSide: Equatable {
  case left
  case right
}

/// Where the collapsed island's parts go beside the notch, and how wide each wing is. Without a
/// wing on either side the island stays in the notch.
struct WingPlan: Equatable {
  var left: CGFloat = 0
  var right: CGFloat = 0
  var marks: WingSide?
  var signal: WingSide?
  var fact: WingSide?

  var inNotch: Bool { left <= 0 && right <= 0 }

  static let notchOnly = WingPlan()

  /// The padding at a wing's outer end and at the notch, and the gaps between its parts.
  static let outer: CGFloat = 12
  static let inner: CGFloat = 8
  static let gap: CGFloat = 8
  static let factGap: CGFloat = 7

  /// The plan for parts of these widths (zero for a part that is not there): the marks on the left
  /// and the signal with its fact on the right while both sides have room, wings as wide as the
  /// wider when both fit; else all on the side with room, dropping the marks, then the fact; else
  /// nothing beside the notch.
  static func collapsed(
    room: BarRoom, marks: CGFloat, signal: CGFloat, fact: CGFloat, minimum: CGFloat
  ) -> WingPlan {
    let status = join(signal, fact, factGap)
    if marks > 0, status > 0 {
      let left = max(10 + marks + inner, minimum)
      let right = max(inner + status + outer, minimum)
      let both = max(left, right)
      let split = WingPlan(
        left: left, right: right, marks: .left, signal: signal > 0 ? .right : nil,
        fact: fact > 0 ? .right : nil)
      if room.left >= both, room.right >= both {
        var even = split
        even.left = both
        even.right = both
        return even
      }
      if room.left >= left, room.right >= right { return split }
    }
    for (m, s, f) in [(marks, signal, fact), (0, signal, fact), (0, signal, 0)] {
      let content = join(join(m, s, gap), f, factGap)
      guard content > 0 else { continue }
      let width = max(inner + content + outer, minimum)
      for side in [WingSide.right, .left] where (side == .right ? room.right : room.left) >= width {
        var plan = WingPlan()
        if side == .right { plan.right = width } else { plan.left = width }
        plan.marks = m > 0 ? side : nil
        plan.signal = s > 0 ? side : nil
        plan.fact = f > 0 ? side : nil
        return plan
      }
    }
    return .notchOnly
  }

  private static func join(_ a: CGFloat, _ b: CGFloat, _ gap: CGFloat) -> CGFloat {
    a > 0 && b > 0 ? a + gap + b : a + b
  }
}

/// How the grown island meets the menu bar: how much narrower than its body its top band is on
/// each side, and whether the mark and the state sit in that band or under it, beside the title.
struct GrownPlan: Equatable {
  var insetLeft: CGFloat = 0
  var insetRight: CGFloat = 0
  var markInBand = true
  var stateInBand = true

  /// `width` is the grown island's, `notch` the notch's (zero without one), `mark` and `state` the
  /// band's content on each side with its padding. A side whose room takes the whole wing keeps
  /// it, as before; one with room for its content alone narrows to it; else the band stops at the
  /// notch and the content moves under it. Without a notch the band is all menu bar: the island
  /// meets it only where both whole wings are free, and otherwise hangs below it.
  static func grown(
    room: BarRoom, notch: CGFloat, width: CGFloat, mark: CGFloat, state: CGFloat, hasNotch: Bool
  ) -> GrownPlan {
    let wing = max(0, (width - notch) / 2)
    guard hasNotch else {
      if room.left >= wing, room.right >= wing { return GrownPlan() }
      return GrownPlan(
        insetLeft: width / 2, insetRight: width / 2, markInBand: false, stateInBand: false)
    }
    func side(_ room: CGFloat, _ content: CGFloat) -> (inset: CGFloat, inBand: Bool) {
      if room >= wing { return (0, true) }
      if content > 0, room >= content { return (wing - content, true) }
      return (wing, false)
    }
    let left = side(room.left, mark)
    let right = side(room.right, state)
    return GrownPlan(
      insetLeft: left.inset, insetRight: right.inset, markInBand: left.inBand,
      stateInBand: right.inBand)
  }
}
