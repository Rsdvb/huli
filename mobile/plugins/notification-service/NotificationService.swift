// Huli's Notification Service Extension. The push gateway sends a placeholder alert and the
// envelope the computer sealed to this phone (src/shared/remote/push.ts); this opens it with the
// phone's key, checks the computer's signature, and shows what it says, with the buttons that
// answer it (src/push/actions.ts in the app). Whatever fails, the notification still shows, with a
// generic text.

import CryptoKit
import Foundation
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var deliver: ((UNNotificationContent) -> Void)?
  /// What shows if time runs out first: the opened content once there is one.
  private var fallback: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    lock.lock()
    deliver = contentHandler
    fallback = Notice.generic(request.content)
    lock.unlock()
    guard let shown = Notice.opened(request.content) else { return finish(nil) }
    lock.lock()
    fallback = shown.content
    lock.unlock()
    guard let category = shown.category else { return finish(shown.content) }
    Categories.add(category) { self.finish(shown.content) }
  }

  override func serviceExtensionTimeWillExpire() {
    finish(nil)
  }

  /// Hands the system its content once: `content`, or the fallback when nil.
  private func finish(_ content: UNNotificationContent?) {
    lock.lock()
    let handler = deliver
    let shown = content ?? fallback
    deliver = nil
    lock.unlock()
    if let handler, let shown { handler(shown) }
  }
}

/// An opened notification, and the category of its own buttons when it has some.
private struct Shown {
  let content: UNNotificationContent
  let category: UNNotificationCategory?
}

/// The notifications' categories. The app registers the fixed ones under the same identifiers
/// (src/push/actions.ts); a question's buttons are its choices, so its category is made here.
private enum Categories {
  static let permission = "huli.permission"
  static let allowOnly = "huli.permission.allow"
  static let turnEnded = "huli.turn"
  static let questionPrefix = "huli.question."
  private static let maxChoices = 4

  /// A question's buttons: each choice, then a written answer when it takes one.
  static func question(_ question: [String: Any]) -> UNNotificationCategory? {
    guard let choices = question["choices"] as? [String],
      choices.count <= Categories.maxChoices
    else { return nil }
    let text = (question["text"] as? Bool) == true
    if choices.isEmpty && !text { return nil }
    var actions: [UNNotificationAction] = choices.enumerated().map { item in
      UNNotificationAction(
        identifier: "choice.\(item.offset)", title: item.element,
        options: [.authenticationRequired])
    }
    if text {
      actions.append(
        UNTextInputNotificationAction(
          identifier: "reply", title: "回复…", options: [.authenticationRequired],
          textInputButtonTitle: "发送", textInputPlaceholder: "写下你的回答"))
    }
    // The same choices make the same category, so repeated questions share one.
    let key = ([text ? "text" : "choices"] + choices).joined(separator: "\n")
    let digest = SHA256.hash(data: Data(key.utf8))
    let hex = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    let id = Categories.questionPrefix + hex
    return UNNotificationCategory(
      identifier: id, actions: actions, intentIdentifiers: [], options: [])
  }

  /// Adds a question's category beside the others, dropping the questions' categories no shown
  /// notification uses any more, then calls `done`.
  static func add(_ category: UNNotificationCategory, then done: @escaping () -> Void) {
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let inUse = Set(delivered.map { $0.request.content.categoryIdentifier })
      center.getNotificationCategories { existing in
        var next = existing.filter { other in
          let id = other.identifier
          if id == category.identifier { return false }
          return !id.hasPrefix(Categories.questionPrefix) || inUse.contains(id)
        }
        next.insert(category)
        center.setNotificationCategories(next)
        // The system takes a new category a moment later; shown sooner, the buttons are missing.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { done() }
      }
    }
  }
}

private enum Notice {
  static func generic(_ original: UNNotificationContent) -> UNNotificationContent {
    let content = mutable(original)
    content.title = "纸鸢"
    content.body = "纸鸢有新动态"
    return content
  }

  static func opened(_ original: UNNotificationContent) -> Shown? {
    guard
      let sealed = original.userInfo["sealed"] as? String,
      let envelope = Base64URL.decode(sealed),
      let keys = SharedKeys.load(),
      let deviceKey = Data(base64Encoded: keys.device),
      let opened = try? Envelope.open(envelope, deviceKey: deviceKey),
      let content = (try? JSONSerialization.jsonObject(with: opened.body)) as? [String: Any],
      (content["v"] as? Int) == 1,
      let host = content["host"] as? String,
      let hostKeyText = keys.hosts[host],
      let hostKey = Base64URL.decode(hostKeyText),
      let signer = try? Curve25519.Signing.PublicKey(rawRepresentation: hostKey),
      signer.isValidSignature(opened.signature, for: opened.signed),
      let kind = content["kind"] as? String
    else { return nil }

    let hostName = text(content["hostName"]) ?? "电脑"
    let fallback = defaultText(kind: kind, hostName: hostName)
    let result = mutable(original)
    let quiet = keys.quiet == true
    result.title = (quiet ? nil : text(content["title"])) ?? fallback.title
    result.body = (quiet ? nil : text(content["body"])) ?? fallback.body

    // expo-notifications hands the app userInfo["body"] as the notification's data.
    var data: [String: Any] = ["host": host, "kind": kind]
    if let tag = content["tag"] as? String { data["tag"] = tag }
    // A plan limit names the agent whose window it is, which the app opens Usage on.
    if kind == "plan-limit", let agentId = content["agentId"] as? String {
      data["agentId"] = agentId
    }
    let sessionId = content["sessionId"] as? String
    if let sessionId {
      data["sessionId"] = sessionId
      result.threadIdentifier = "\(host):\(sessionId)"
      // A session the user muted on this phone arrives in the list without a sound or a banner.
      if MutedSessions.load().contains(sessionId) {
        result.sound = nil
        if #available(iOS 15.0, *) { result.interruptionLevel = .passive }
      }
    }
    // Buttons that answer only where the notification says what they answer, as the computer
    // sends the answers only to a phone that wants details.
    var category: UNNotificationCategory?
    if !quiet, sessionId != nil {
      switch kind {
      case "permission":
        if let requestId = content["requestId"] as? String {
          data["requestId"] = requestId
          if let actions = content["actions"] as? [String: Any], actions["allow"] is [String: Any] {
            data["actions"] = actions
            result.categoryIdentifier =
              actions["deny"] is [String: Any] ? Categories.permission : Categories.allowOnly
          } else if let question = content["question"] as? [String: Any],
            let made = Categories.question(question)
          {
            data["question"] = question
            result.categoryIdentifier = made.identifier
            category = made
          }
        }
      case "turn-ended":
        result.categoryIdentifier = Categories.turnEnded
      default:
        break
      }
    }
    var userInfo = original.userInfo
    userInfo["body"] = data
    result.userInfo = userInfo
    return Shown(content: result, category: category)
  }

  private static func defaultText(kind: String, hostName: String) -> (title: String, body: String) {
    switch kind {
    case "permission":
      return ("需要你确认", "\(hostName) 上有请求在等你处理")
    case "turn-ended":
      return ("回复完成", "\(hostName) 上的会话已完成这一轮")
    case "error":
      return ("出错了", "\(hostName) 上的会话出错了")
    case "routine-ended":
      return ("例行任务已结束", "\(hostName) 上的例行任务运行结束了")
    case "routine-paused":
      return ("例行任务已暂停", "\(hostName) 上的例行任务接近套餐上限，已暂停")
    case "plan-limit":
      return ("套餐额度快用完了", "\(hostName) 上有 Agent 的套餐限额已用到 90% 以上")
    case "limit-resumed":
      return ("额度已恢复", "\(hostName) 上的会话正在自动继续")
    default:
      return ("纸鸢", "纸鸢有新动态")
    }
  }

  private static func text(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty else { return nil }
    return text
  }

  private static func mutable(_ content: UNNotificationContent) -> UNMutableNotificationContent {
    (content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
  }
}

/// The keys the app keeps for this extension, in the Keychain access group both targets hold.
private struct SharedKeys: Decodable {
  let v: Int
  /// This phone's X25519 private key, in base64.
  let device: String
  /// Each host's Ed25519 public key in base64url, by its id.
  let hosts: [String: String]
  /// Show only the kind of each notification, never a session's title or text.
  let quiet: Bool?

  static func load() -> SharedKeys? {
    // The app writes the item with expo-secure-store, which names its service with ":no-auth" after
    // the one it is given and stores the key's UTF-8 bytes as the account.
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "huli.push:no-auth",
      kSecAttrAccount as String: Data("huli.push.keys".utf8),
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data,
      let keys = try? JSONDecoder().decode(SharedKeys.self, from: data),
      keys.v == 1
    else { return nil }
    return keys
  }
}

/// The sessions the user muted on this phone, which the app keeps beside the keys.
private enum MutedSessions {
  static func load() -> Set<String> {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "huli.push:no-auth",
      kSecAttrAccount as String: Data("huli.push.muted".utf8),
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data,
      let ids = try? JSONDecoder().decode([String].self, from: data)
    else { return [] }
    return Set(ids)
  }
}

/// The sealed envelope: 0x01 || E || AES-256-GCM(S || B), its key and nonce from HKDF-SHA256 over
/// X25519(device, E).
private enum Envelope {
  struct Opened {
    let body: Data
    let signature: Data
    /// What the host signed: the context, the device's public key, E and the body.
    let signed: Data
  }

  static func open(_ envelope: Data, deviceKey: Data) throws -> Opened {
    let bytes = [UInt8](envelope)
    guard bytes.count >= 1 + 32 + 16 + 64, bytes[0] == 1 else {
      throw CryptoKitError.incorrectParameterSize
    }
    let header = Data(bytes[0..<33])
    let ephemeral = Data(bytes[1..<33])
    let device = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: deviceKey)
    let devicePublic = device.publicKey.rawRepresentation
    let shared = try device.sharedSecretFromKeyAgreement(
      with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephemeral))
    let material = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: ephemeral + devicePublic,
      sharedInfo: Data("kettu-push-seal/1".utf8),
      outputByteCount: 44
    ).withUnsafeBytes { Data($0) }
    let key = SymmetricKey(data: material.prefix(32))
    let nonce = try AES.GCM.Nonce(data: material.suffix(12))
    let cipher = Data(bytes[33...])
    let box = try AES.GCM.SealedBox(
      nonce: nonce, ciphertext: cipher.prefix(cipher.count - 16), tag: cipher.suffix(16))
    let plain = try AES.GCM.open(box, using: key, authenticating: header)
    let signature = Data(plain.prefix(64))
    let body = Data(plain.dropFirst(64))
    var signed = Data("kettu-push-content/1\n".utf8)
    signed.append(devicePublic)
    signed.append(ephemeral)
    signed.append(body)
    return Opened(body: body, signature: signature, signed: signed)
  }
}

private enum Base64URL {
  static func decode(_ text: String) -> Data? {
    var base64 = text.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    switch base64.count % 4 {
    case 1: return nil
    case 2: base64 += "=="
    case 3: base64 += "="
    default: break
    }
    return Data(base64Encoded: base64)
  }
}
