import AppKit
import ApplicationServices

/// Where the island meets the menu bar, in the window list's coordinates (origin at the top left
/// of the main screen): the notch, zero wide on a screen without one, and the menu bar's band.
struct BarArea: Equatable {
  var notch: CGRect
  var band: CGRect
}

/// Huli: measures the room the menu bar leaves beside the notch. Status items are windows of their
/// own at the status level, which the window list shows without any permission; where the front
/// app's menus end is read through Accessibility only when Kettu already has that permission (as
/// computer use asks for it), and never asked for, so without it the left side counts as taken.
///
/// Nothing runs on a timer: it measures when asked, on the events the controller hears (the active
/// app, the screens, launched and quit apps, the pointer coming into the menu bar, the island about
/// to collapse or grow), off the main thread, one measurement at a time.
final class MenuBarWatcher {
  /// The area to measure, read on the main thread; nil while there is none.
  var area: () -> BarArea? = { nil }
  /// The room, on the main thread, whenever a measurement ends.
  var onRoom: (BarRoom) -> Void = { _ in }

  private let queue = DispatchQueue(label: "kettu-island.menu-bar", qos: .userInitiated)
  private let ownPid = getpid()
  private let statusLayer = Int(CGWindowLevelForKey(.statusWindow))
  private var running = false
  private var again = false
  private var followUp: DispatchWorkItem?
  private var lastPointerCheck: TimeInterval = 0
  private var traced = false

  init() {
    // One app that does not answer Accessibility may hold a measurement this long at most.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
  }

  /// Measures now, or once more right after the measurement under way.
  func check() {
    guard let area = area() else { return }
    if running {
      again = true
      return
    }
    running = true
    // The app whose menus the menu bar shows, which need not be the front one.
    let workspace = NSWorkspace.shared
    let front =
      (workspace.menuBarOwningApplication ?? workspace.frontmostApplication)?.processIdentifier
    let ownPid = ownPid
    let statusLayer = statusLayer
    let trace = !traced
    traced = true
    queue.async { [weak self] in
      let room = Self.measure(
        area: area, front: front, ownPid: ownPid, statusLayer: statusLayer, trace: trace)
      DispatchQueue.main.async {
        guard let self else { return }
        self.running = false
        self.onRoom(room)
        if self.again {
          self.again = false
          self.check()
        }
      }
    }
  }

  /// Measures again after a while, as after an app switch or launch, whose menus and status items
  /// settle a moment later; a newer call takes the place of one still waiting.
  func check(after seconds: TimeInterval) {
    followUp?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.check() }
    followUp = work
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  /// The pointer came into the menu bar or left it: measured at most once a second, so an item
  /// that appeared under a wing comes out before the user reaches for it.
  func pointerCrossed() {
    let now = ProcessInfo.processInfo.systemUptime
    guard now - lastPointerCheck > 1 else {
      check(after: 1)
      return
    }
    lastPointerCheck = now
    check()
  }

  private static func measure(
    area: BarArea, front: pid_t?, ownPid: pid_t, statusLayer: Int, trace: Bool
  ) -> BarRoom {
    // A menu bar that hides itself leaves the windows under it there most of the time.
    if UserDefaults.standard.bool(forKey: "_HIHideMenuBar") { return .none }
    let items = MenuBarRoom.statusItems(
      in: listedWindows(statusLayer: statusLayer), band: area.band, statusLayer: statusLayer,
      ownPid: ownPid)
    let trusted = AXIsProcessTrusted()
    var menus: CGFloat?
    if trusted, let front { menus = Self.menuEnd(of: front, band: area.band) }
    if trace {
      log(
        "Menu bar: \(items.count) status items, Accessibility \(trusted ? "allowed" : "not allowed")"
          + (menus.map { ", menus end at \(Int($0))" } ?? ""))
    }
    return MenuBarRoom.room(notch: area.notch, band: area.band, statusItems: items, menuEnd: menus)
  }

  /// The windows on screen at the status level, as the window list has them.
  private static func listedWindows(statusLayer: Int) -> [ListedWindow] {
    guard
      let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return [] }
    return list.compactMap { info in
      guard let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue,
        layer == statusLayer,
        let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
        let bounds = info[kCGWindowBounds as String] as? NSDictionary,
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
      else { return nil }
      return ListedWindow(bounds: rect, layer: layer, pid: pid)
    }
  }

  /// Where the last of an app's menus in the menu bar ends, through Accessibility; nil when the
  /// app names none there, which leaves the left side taken.
  private static func menuEnd(of pid: pid_t, band: CGRect) -> CGFloat? {
    let app = AXUIElementCreateApplication(pid)
    guard let bar = copy(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID(),
      let menus = copy(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement]
    else { return nil }
    var end: CGFloat?
    for menu in menus {
      guard let frame = frame(of: menu), frame.width > 0,
        frame.midY >= band.minY, frame.midY <= band.maxY
      else { continue }
      end = max(end ?? frame.maxX, frame.maxX)
    }
    return end
  }

  private static func copy(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
      return nil
    }
    return value
  }

  private static func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value = copy(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
      return nil
    }
    var point = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
  }

  private static func size(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value = copy(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
      return nil
    }
    var size = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
  }

  private static func frame(of element: AXUIElement) -> CGRect? {
    guard let origin = point(element, kAXPositionAttribute),
      let extent = size(element, kAXSizeAttribute)
    else { return nil }
    return CGRect(origin: origin, size: extent)
  }
}
