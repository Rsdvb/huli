import CoreGraphics
import XCTest

@testable import IslandLayout

// A 13-inch MacBook Air's menu bar in the window list's coordinates: 1470 points wide, 37 tall,
// with a notch 185 points wide in its middle.
private let band = CGRect(x: 0, y: 0, width: 1470, height: 37)
private let notch = CGRect(x: 642.5, y: 0, width: 185, height: 37)
private let statusLayer = 25
private let ownPid: Int32 = 4242

private func item(_ x: CGFloat, _ width: CGFloat = 30) -> CGRect {
  CGRect(x: x, y: 0, width: width, height: 37)
}

final class StatusItemTests: XCTestCase {
  func testKeepsStatusWindowsInTheMenuBarOnly() {
    let windows = [
      ListedWindow(bounds: item(1300), layer: statusLayer, pid: 10),
      // The menu bar itself, a level below and the whole width.
      ListedWindow(bounds: band, layer: 24, pid: 1),
      // The helper's own window.
      ListedWindow(bounds: item(900), layer: statusLayer, pid: ownPid),
      // A menu dropped down from a status item, at the same level but below the band.
      ListedWindow(
        bounds: CGRect(x: 1200, y: 37, width: 300, height: 400), layer: statusLayer, pid: 10),
      // Another display's menu bar, beside this one.
      ListedWindow(bounds: item(1600), layer: statusLayer, pid: 11),
      // An ordinary window.
      ListedWindow(bounds: CGRect(x: 100, y: 0, width: 800, height: 600), layer: 0, pid: 12),
      ListedWindow(bounds: item(860, 40), layer: statusLayer, pid: 13),
    ]
    let items = MenuBarRoom.statusItems(
      in: windows, band: band, statusLayer: statusLayer, ownPid: ownPid)
    XCTAssertEqual(items, [item(1300), item(860, 40)])
  }

  func testTakesItemsAsTallAsTheMenuBarOrShorter() {
    let short = CGRect(x: 1000, y: 6, width: 24, height: 24)
    let tall = CGRect(x: 1100, y: 0, width: 24, height: 60)
    let items = MenuBarRoom.statusItems(
      in: [
        ListedWindow(bounds: short, layer: statusLayer, pid: 3),
        ListedWindow(bounds: tall, layer: statusLayer, pid: 3),
      ], band: band, statusLayer: statusLayer, ownPid: ownPid)
    XCTAssertEqual(items, [short])
  }
}

final class RoomTests: XCTestCase {
  func testRightRoomEndsAtTheFirstStatusItemWithAMargin() {
    let room = MenuBarRoom.room(
      notch: notch, band: band, statusItems: [item(1400), item(900), item(1100)], menuEnd: nil)
    // 900 - 827.5 - 10, rounded down.
    XCTAssertEqual(room.right, 62)
  }

  func testNoRoomOnTheLeftWithoutTheMenus() {
    let room = MenuBarRoom.room(notch: notch, band: band, statusItems: [item(1400)], menuEnd: nil)
    XCTAssertEqual(room.left, 0)
    XCTAssertEqual(room.right, 562)
  }

  func testLeftRoomEndsAtTheLastMenu() {
    let room = MenuBarRoom.room(notch: notch, band: band, statusItems: [item(1400)], menuEnd: 400)
    XCTAssertEqual(room.left, 232)
  }

  func testMenusReachingTheNotchLeaveNoRoom() {
    let room = MenuBarRoom.room(notch: notch, band: band, statusItems: [item(1400)], menuEnd: 700)
    XCTAssertEqual(room.left, 0)
    XCTAssertEqual(room.right, 562)
  }

  func testItemsCrowdedUpToTheNotchLeaveNoRoom() {
    let room = MenuBarRoom.room(
      notch: notch, band: band, statusItems: [item(830), item(870)], menuEnd: 300)
    XCTAssertEqual(room.right, 0)
    XCTAssertEqual(room.left, 332)
    // An item hidden under the notch's right half says the same of the right alone.
    let hidden = MenuBarRoom.room(
      notch: notch, band: band, statusItems: [item(800), item(900)], menuEnd: 300)
    XCTAssertEqual(hidden, BarRoom(left: 332, right: 0))
  }

  func testAHiddenOrUnreadableMenuBarLeavesNothing() {
    XCTAssertEqual(
      MenuBarRoom.room(notch: notch, band: band, statusItems: [], menuEnd: 200), .none)
  }

  func testWithoutANotchStatusItemsPastTheMiddleTakeTheLeft() {
    let middle = CGRect(x: 735, y: 0, width: 0, height: 37)
    // An item across the middle leaves nothing on either side.
    let across = MenuBarRoom.room(
      notch: middle, band: band, statusItems: [item(720), item(1400)], menuEnd: 200)
    XCTAssertEqual(across, .none)
    // One wholly left of it ends the left room, as the menus do.
    let left = MenuBarRoom.room(
      notch: middle, band: band, statusItems: [item(600), item(1400)], menuEnd: 200)
    XCTAssertEqual(left, BarRoom(left: 95, right: 655))
    let clear = MenuBarRoom.room(
      notch: middle, band: band, statusItems: [item(1000)], menuEnd: 200)
    XCTAssertEqual(clear, BarRoom(left: 525, right: 255))
  }

  func testCapsTheRoom() {
    XCTAssertEqual(BarRoom(left: 400, right: 20).capped(at: 180), BarRoom(left: 180, right: 20))
  }
}

final class WingPlanTests: XCTestCase {
  // One mark (22 wide with its ring), the signal (14) and a plan's "2/5" (40).
  private func plan(_ left: CGFloat, _ right: CGFloat, fact: CGFloat = 40) -> WingPlan {
    WingPlan.collapsed(
      room: BarRoom(left: left, right: right), marks: 22, signal: 14, fact: fact, minimum: 30)
  }

  func testRoomOnBothSidesKeepsTheEvenWings() {
    // Left 10 + 22 + 8 = 40, right 8 + 14 + 7 + 40 + 12 = 81: both take 81.
    XCTAssertEqual(
      plan(200, 200),
      WingPlan(left: 81, right: 81, marks: .left, signal: .right, fact: .right))
  }

  func testSplitsUnevenlyWhenOneSideHasLessRoom() {
    XCTAssertEqual(
      plan(50, 200), WingPlan(left: 40, right: 81, marks: .left, signal: .right, fact: .right))
  }

  func testPutsEverythingOnTheSideWithRoom() {
    // 8 + 22 + 8 + 14 + 7 + 40 + 12 = 111.
    XCTAssertEqual(
      plan(0, 120), WingPlan(left: 0, right: 111, marks: .right, signal: .right, fact: .right))
    XCTAssertEqual(
      plan(120, 0), WingPlan(left: 111, right: 0, marks: .left, signal: .left, fact: .left))
  }

  func testDropsTheMarksThenTheFact() {
    // Without the marks: 8 + 14 + 7 + 40 + 12 = 81.
    XCTAssertEqual(
      plan(0, 90), WingPlan(left: 0, right: 81, marks: nil, signal: .right, fact: .right))
    // The signal alone: 8 + 14 + 12 = 34.
    XCTAssertEqual(
      plan(0, 40), WingPlan(left: 0, right: 34, marks: nil, signal: .right, fact: nil))
  }

  func testStaysInTheNotchWithoutRoom() {
    XCTAssertEqual(plan(0, 0), .notchOnly)
    XCTAssertTrue(plan(20, 33).inNotch)
  }

  func testAMissingFactTakesNoRoom() {
    XCTAssertEqual(
      plan(0, 60, fact: 0),
      WingPlan(left: 0, right: 34, marks: nil, signal: .right, fact: nil))
    // 8 + 22 + 8 + 14 + 12 = 64.
    XCTAssertEqual(
      plan(0, 64, fact: 0),
      WingPlan(left: 0, right: 64, marks: .right, signal: .right, fact: nil))
  }
}

final class GrownPlanTests: XCTestCase {
  // A 380 wide pop over a 185 wide notch: wings of 97.5.
  private func plan(_ left: CGFloat, _ right: CGFloat, hasNotch: Bool = true) -> GrownPlan {
    GrownPlan.grown(
      room: BarRoom(left: left, right: right), notch: hasNotch ? 185 : 0, width: 380, mark: 42,
      state: 90, hasNotch: hasNotch)
  }

  func testWholeWingsWhereTheRoomTakesThem() {
    XCTAssertEqual(plan(100, 100), GrownPlan())
  }

  func testNarrowsTheBandToItsContent() {
    XCTAssertEqual(
      plan(50, 95),
      GrownPlan(insetLeft: 55.5, insetRight: 7.5, markInBand: true, stateInBand: true))
  }

  func testMovesTheContentUnderTheBandWithoutRoom() {
    XCTAssertEqual(
      plan(0, 0),
      GrownPlan(insetLeft: 97.5, insetRight: 97.5, markInBand: false, stateInBand: false))
  }

  func testWithoutANotchHangsBelowTheMenuBarUnlessBothSidesAreFree() {
    XCTAssertEqual(plan(300, 300, hasNotch: false), GrownPlan())
    XCTAssertEqual(
      plan(0, 300, hasNotch: false),
      GrownPlan(insetLeft: 190, insetRight: 190, markInBand: false, stateInBand: false))
  }
}
