// Huli's bridge to the iOS system integrations that need the app: the links Siri, Shortcuts, the
// Control Center controls, Spotlight and Handoff leave for it, the active computer's sessions in
// Spotlight, the open session as the current activity (Handoff and Siri suggestions), and whether
// Low Power Mode is on, under which the app draws its glass solid.
// JavaScript takes a waiting link at start, on "onOpenURL" and when the app comes to the front,
// and opens it as any huli:// link (src/system/bridge.tsx).

import CoreSpotlight
import ExpoModulesCore
import Foundation
import UniformTypeIdentifiers

public final class HuliSystemModule: Module {
  private var observer: NSObjectProtocol?
  private var powerObserver: NSObjectProtocol?
  private var activity: NSUserActivity?

  public func definition() -> ModuleDefinition {
    Name("HuliSystem")

    Events("onOpenURL", "onLowPowerMode")

    OnCreate {
      self.observer = NotificationCenter.default.addObserver(
        forName: PendingLink.notification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onOpenURL")
      }
      self.powerObserver = NotificationCenter.default.addObserver(
        forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent(
          "onLowPowerMode", ["on": ProcessInfo.processInfo.isLowPowerModeEnabled])
      }
    }

    OnDestroy {
      for observer in [self.observer, self.powerObserver].compactMap({ $0 }) {
        NotificationCenter.default.removeObserver(observer)
      }
      self.observer = nil
      self.powerObserver = nil
    }

    Function("isLowPowerMode") { () -> Bool in
      ProcessInfo.processInfo.isLowPowerModeEnabled
    }

    Function("takeOpenURL") { () -> String? in
      PendingLink.take()
    }

    AsyncFunction("indexSessions") { (domain: String, json: String, promise: Promise) in
      SessionIndex.replace(domain: domain, json: json) {
        promise.resolve()
      }
    }

    AsyncFunction("keepSessions") { (domains: [String], promise: Promise) in
      SessionIndex.keep(domains) {
        promise.resolve()
      }
    }

    AsyncFunction("removeAllSessions") { (promise: Promise) in
      SessionIndex.removeAll {
        promise.resolve()
      }
    }

    AsyncFunction("setCurrentSession") { (json: String) in
      self.advertise(json)
    }.runOnQueue(.main)
  }

  /// Makes the session `{ id, host, title? }` the current activity, or none for an empty string.
  /// Without a title, as while the user hides what notifications say, it only offers Handoff.
  private func advertise(_ json: String) {
    activity?.invalidate()
    activity = nil
    guard !json.isEmpty,
      let current = try? JSONDecoder().decode(CurrentSession.self, from: Data(json.utf8))
    else { return }
    let identifier = SessionIndex.identifier(domain: current.host, session: current.id)
    let url = HuliLinks.session(current.id, host: current.host)
    let next = NSUserActivity(activityType: SessionActivity.type)
    next.title = current.title ?? "纸鸢会话"
    next.userInfo = ["url": url.absoluteString]
    next.requiredUserInfoKeys = ["url"]
    next.isEligibleForHandoff = true
    next.isEligibleForSearch = current.title != nil
    next.isEligibleForPrediction = current.title != nil
    if current.title != nil {
      next.persistentIdentifier = identifier
      let attributes = CSSearchableItemAttributeSet(contentType: UTType.text)
      attributes.relatedUniqueIdentifier = identifier
      if let project = current.project { attributes.contentDescription = project }
      next.contentAttributeSet = attributes
    }
    next.becomeCurrent()
    activity = next
  }
}

struct CurrentSession: Decodable {
  let id: String
  let host: String
  let title: String?
  let project: String?
}

enum SessionActivity {
  /// withSystem.js lists it in NSUserActivityTypes.
  static let type = "\(Bundle.main.bundleIdentifier ?? "io.github.rsdvb.huli").session"
}

/// A huli:// link left for the app by an intent, Spotlight or Handoff, in the App Group, since an
/// intent may run before JavaScript does. plugins/widgets/HuliOpenIntents.swift writes the same
/// key and posts the same notification.
enum PendingLink {
  static let key = "huli.system.open"
  static let notification = Notification.Name("HuliSystemOpenURL")
  /// A link older than this was never taken, and opening it now would surprise.
  static let maxAge: TimeInterval = 600

  /// The App Group the intents write to, with the same fallback as theirs.
  private static var store: UserDefaults? {
    let group =
      (Bundle.main.object(forInfoDictionaryKey: "HuliAppGroup") as? String)
      ?? "group.io.github.rsdvb.huli"
    return UserDefaults(suiteName: group)
  }

  static func put(_ url: URL) {
    store?.set(["url": url.absoluteString, "at": Date().timeIntervalSince1970], forKey: key)
    NotificationCenter.default.post(name: notification, object: nil)
  }

  static func take() -> String? {
    guard let defaults = store, let entry = defaults.dictionary(forKey: key) else { return nil }
    defaults.removeObject(forKey: key)
    guard let url = entry["url"] as? String,
      let at = entry["at"] as? Double,
      Date().timeIntervalSince1970 - at < maxAge
    else { return nil }
    return url
  }
}

/// The links src/links.ts reads.
enum HuliLinks {
  /// Only ASCII letters and digits stay as they are: links.ts reads `+` as a space.
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  static func session(_ id: String, host: String?) -> URL {
    let path = id.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    var text = "huli://session/\(path)"
    if let host, !host.isEmpty,
      let encoded = host.addingPercentEncoding(withAllowedCharacters: unreserved)
    {
      text += "?host=\(encoded)"
    }
    return URL(string: text) ?? URL(string: "huli://")!
  }
}

/// The sessions in Spotlight, one domain per computer (SavedHost.id), each item
/// `<computer id>:<session id>`. Which domains it holds is kept, so a computer unpaired meanwhile
/// leaves nothing behind.
enum SessionIndex {
  struct Item: Decodable {
    let id: String
    let title: String
    let project: String?
    let agent: String?
    /// When the session last changed, in ms since the epoch.
    let at: Double
  }

  private static let domainsKey = "huli.system.spotlightDomains"

  static func identifier(domain: String, session: String) -> String {
    "\(domain):\(session)"
  }

  /// The session an item opens.
  static func link(_ identifier: String) -> URL? {
    guard let colon = identifier.firstIndex(of: ":") else { return nil }
    let domain = String(identifier[..<colon])
    let session = String(identifier[identifier.index(after: colon)...])
    guard !session.isEmpty else { return nil }
    return HuliLinks.session(session, host: domain.isEmpty ? nil : domain)
  }

  private static var domains: Set<String> {
    get { Set(UserDefaults.standard.stringArray(forKey: domainsKey) ?? []) }
    set { UserDefaults.standard.set(Array(newValue).sorted(), forKey: domainsKey) }
  }

  /// Puts the computer's sessions in place of what Spotlight held for it.
  static func replace(domain: String, json: String, done: @escaping () -> Void) {
    guard CSSearchableIndex.isIndexingAvailable(),
      let items = try? JSONDecoder().decode([Item].self, from: Data(json.utf8))
    else {
      done()
      return
    }
    let searchable = items.map { item -> CSSearchableItem in
      let attributes = CSSearchableItemAttributeSet(contentType: UTType.text)
      attributes.title = item.title
      attributes.displayName = item.title
      let about = [item.project, item.agent].compactMap { $0 }
      if !about.isEmpty { attributes.contentDescription = about.joined(separator: " · ") }
      attributes.keywords = ["纸鸢", "Kite", "Huli"] + about
      attributes.contentModificationDate = Date(timeIntervalSince1970: item.at / 1000)
      return CSSearchableItem(
        uniqueIdentifier: identifier(domain: domain, session: item.id),
        domainIdentifier: domain,
        attributeSet: attributes)
    }
    domains = domains.union([domain])
    let index = CSSearchableIndex.default()
    index.deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in
      if searchable.isEmpty {
        done()
        return
      }
      index.indexSearchableItems(searchable) { _ in done() }
    }
  }

  /// Removes the computers not in `keep`.
  static func keep(_ keep: [String], done: @escaping () -> Void) {
    let known = domains
    let gone = known.subtracting(keep)
    guard !gone.isEmpty else {
      done()
      return
    }
    domains = known.intersection(keep)
    CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: Array(gone)) { _ in
      done()
    }
  }

  static func removeAll(done: @escaping () -> Void) {
    domains = []
    CSSearchableIndex.default().deleteAllSearchableItems { _ in done() }
  }
}
