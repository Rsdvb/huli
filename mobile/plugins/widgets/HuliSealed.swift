// Opens what the computer seals to this phone for its Live Activity, the same way the Notification
// Service Extension opens a notification (src/shared/remote/push.ts has the format): the phone's
// X25519 key and each host's Ed25519 key come from the Keychain access group the app shares with
// its extensions. Whatever fails, the activity still shows, with a generic text.

import CryptoKit
import Foundation
import Security

/// The keys the app keeps for its extensions (src/push/platform.ios.ts writes them).
struct SharedKeys: Decodable {
  let v: Int
  /// This phone's X25519 private key, in base64.
  let device: String
  /// Each host's Ed25519 public key in base64url, by its id.
  let hosts: [String: String]
  /// Show only what kind of thing happened, never a session's title.
  let quiet: Bool?

  static func load() -> SharedKeys? {
    // expo-secure-store names its service with ":no-auth" after the one it is given and stores the
    // key's UTF-8 bytes as the account.
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

enum Sealed {
  /// The content of an envelope sealed to this phone, once its host's signature checks out.
  static func open(_ sealed: String?, keys: SharedKeys?) -> [String: Any]? {
    guard
      let sealed,
      let keys,
      let envelope = Base64URL.decode(sealed),
      let deviceKey = Data(base64Encoded: keys.device),
      let opened = try? Envelope.open(envelope, deviceKey: deviceKey),
      let content = (try? JSONSerialization.jsonObject(with: opened.body)) as? [String: Any],
      (content["v"] as? Int) == 1,
      let host = content["host"] as? String,
      let hostKeyText = keys.hosts[host],
      let hostKey = Base64URL.decode(hostKeyText),
      let signer = try? Curve25519.Signing.PublicKey(rawRepresentation: hostKey),
      signer.isValidSignature(opened.signature, for: opened.signed)
    else { return nil }
    return content
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
