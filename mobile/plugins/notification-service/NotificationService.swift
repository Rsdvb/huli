// Huli's Notification Service Extension. The push gateway sends a placeholder alert and the
// envelope the computer sealed to this phone (src/shared/remote/push.ts); this opens it with the
// phone's key, checks the computer's signature, and shows what it says. Whatever fails, the
// notification still shows, with a generic text.

import CryptoKit
import Foundation
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    deliver = contentHandler
    let generic = Notice.generic(request.content)
    fallback = generic
    let content = Notice.opened(request.content) ?? generic
    deliver = nil
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let deliver, let fallback { deliver(fallback) }
    deliver = nil
  }
}

private enum Notice {
  static func generic(_ original: UNNotificationContent) -> UNNotificationContent {
    let content = mutable(original)
    content.title = "Huli"
    content.body = "Huli 有新动态"
    return content
  }

  static func opened(_ original: UNNotificationContent) -> UNNotificationContent? {
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
    if let sessionId = content["sessionId"] as? String {
      data["sessionId"] = sessionId
      result.threadIdentifier = "\(host):\(sessionId)"
      // A session the user muted on this phone arrives in the list without a sound or a banner.
      if MutedSessions.load().contains(sessionId) {
        result.sound = nil
        if #available(iOS 15.0, *) { result.interruptionLevel = .passive }
      }
    }
    var userInfo = original.userInfo
    userInfo["body"] = data
    result.userInfo = userInfo
    return result
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
    default:
      return ("Huli", "Huli 有新动态")
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
