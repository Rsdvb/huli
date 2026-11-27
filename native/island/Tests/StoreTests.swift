import Foundation
import XCTest

@testable import IslandLayout

/// One line from main, decoded as the helper decodes it.
private func message(_ json: String) throws -> MainMessage {
  try JSONDecoder().decode(MainMessage.self, from: Data(json.utf8))
}

/// The plan limit notice main sends for a 5-hour window at `percent` used.
private func limitNotice(_ percent: Int) -> String {
  let meter = #"{"percent":\#(percent),"reached":false,"text":"\#(percent)%"}"#
  return #"{"key":"limit","kind":"limit","marks":[],"title":"Claude Max","detail":"5-hour","#
    + #""meter":\#(meter),"trailing":"Resets 3:00 PM","button":null,"link":null}"#
}

private func view(_ seq: Int, notices: [String]) -> String {
  let list = notices.joined(separator: ",")
  return #"{"type":"view","seq":\#(seq),"rows":[],"requests":[],"notices":[\#(list)],"#
    + #""summary":{"running":0,"waiting":0,"failed":0,"today":0}}"#
}

/// A change, with every notice when `notices` is set and none of them when it is nil.
private func change(_ seq: Int, notices: [String]?) -> String {
  var carried = ""
  if let notices {
    let list = notices.joined(separator: ",")
    carried = #","notices":[\#(list)]"#
  }
  return #"{"type":"change","seq":\#(seq),"rows":[],"removedRows":[],"requests":[],"#
    + #""removedRequests":[]\#(carried)}"#
}

final class StoreTests: XCTestCase {
  func testAChangeCarriesAWindowsNewUseAndOneWithoutNoticesKeepsIt() throws {
    let store = Store()
    store.view(try message(view(1, notices: [limitNotice(91)])))
    XCTAssertEqual(store.notices.map(\.meter?.percent), [91])

    XCTAssertEqual(store.change(try message(change(2, notices: [limitNotice(97)]))), .applied)
    XCTAssertEqual(store.notices.map(\.meter?.percent), [97])
    XCTAssertEqual(store.notices.first?.meter?.text, "97%")

    // A change about something else leaves the notices as they were.
    XCTAssertEqual(store.change(try message(change(3, notices: nil))), .applied)
    XCTAssertEqual(store.notices.map(\.meter?.percent), [97])

    // The window reset: main sends the notices without it.
    XCTAssertEqual(store.change(try message(change(4, notices: []))), .applied)
    XCTAssertEqual(store.notices, [])
  }

  func testALostChangeKeepsTheOldUseUntilTheWholeViewComes() throws {
    let store = Store()
    store.view(try message(view(1, notices: [limitNotice(91)])))
    XCTAssertEqual(store.change(try message(change(3, notices: [limitNotice(97)]))), .gap)
    XCTAssertEqual(store.notices.map(\.meter?.percent), [91])
    store.view(try message(view(4, notices: [limitNotice(97)])))
    XCTAssertEqual(store.notices.map(\.meter?.percent), [97])
  }
}
