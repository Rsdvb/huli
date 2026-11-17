// Huli's Share Extension: 分享 → Huli from Photos, Safari, Files and other apps. It copies what is
// shared into the App Group container the app also holds, as share/<id>/ with a manifest.json
// listing the items, then opens the app at huli://share?id=<id>, where the user picks the session
// to send them to (src/app/share.tsx). Nothing leaves the phone here. When the app cannot be
// opened from here, the items wait and the extension says so.

import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
  private let card = UIView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let label = UILabel()
  private let button = UIButton(type: .system)
  private var started = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor.black.withAlphaComponent(0.2)
    card.backgroundColor = .systemBackground
    card.layer.cornerRadius = 18
    card.translatesAutoresizingMaskIntoConstraints = false
    label.text = "正在交给 Huli…"
    label.font = .preferredFont(forTextStyle: .body)
    label.textColor = .label
    label.textAlignment = .center
    label.numberOfLines = 0
    button.setTitle("好", for: .normal)
    button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    button.isHidden = true
    button.addTarget(self, action: #selector(close), for: .touchUpInside)
    spinner.startAnimating()

    let stack = UIStackView(arrangedSubviews: [spinner, label, button])
    stack.axis = .vertical
    stack.spacing = 12
    stack.alignment = .center
    stack.translatesAutoresizingMaskIntoConstraints = false
    card.addSubview(stack)
    view.addSubview(card)
    NSLayoutConstraint.activate([
      card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      card.widthAnchor.constraint(equalToConstant: 260),
      stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
      stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
    ])
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
    Inbox.save(items) { id in
      DispatchQueue.main.async { self.saved(id) }
    }
  }

  private func saved(_ id: String?) {
    let scheme = (Bundle.main.object(forInfoDictionaryKey: "HuliURLScheme") as? String) ?? "huli"
    guard let id, let url = URL(string: "\(scheme)://share?id=\(id)") else {
      return show("没有能交给 Huli 的内容。")
    }
    openApp(url) { opened in
      DispatchQueue.main.async {
        if opened {
          self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        } else {
          self.show("已存好，打开 Huli 继续。")
        }
      }
    }
  }

  private func show(_ message: String) {
    spinner.stopAnimating()
    spinner.isHidden = true
    label.text = message
    button.isHidden = false
  }

  @objc private func close() {
    extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
  }

  /// Opens the app through the application the responder chain reaches: a share extension's
  /// extensionContext.open(_:) opens nothing. UIApplication's open(_:options:) is unavailable
  /// to extensions at compile time, so it is looked up and called through the runtime.
  private func openApp(_ url: URL, done: @escaping (Bool) -> Void) {
    typealias Open = @convention(c) (
      AnyObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?
    ) -> Void
    let selector = NSSelectorFromString("openURL:options:completionHandler:")
    var responder: UIResponder? = self
    while let current = responder {
      if current is UIApplication,
        let method = class_getInstanceMethod(type(of: current), selector)
      {
        let open = unsafeBitCast(method_getImplementation(method), to: Open.self)
        let finished: @convention(block) (Bool) -> Void = { opened in done(opened) }
        open(current, selector, url as NSURL, NSDictionary(), finished)
        return
      }
      responder = current.next
    }
    done(false)
  }
}

/// The shared items, copied where the app reads them.
private enum Inbox {
  static func save(_ items: [NSExtensionItem], done: @escaping (String?) -> Void) {
    let manager = FileManager.default
    guard let groupId = Bundle.main.object(forInfoDictionaryKey: "HuliAppGroup") as? String,
      let container = manager.containerURL(forSecurityApplicationGroupIdentifier: groupId)
    else { return done(nil) }
    let root = container.appendingPathComponent("share", isDirectory: true)
    let now = Int(Date().timeIntervalSince1970 * 1000)
    dropOld(in: root, now: now)
    // Named by when it was made, so clearing old ones reads no file dates.
    let id = "\(now)-\(UUID().uuidString.lowercased())"
    let folder = root.appendingPathComponent(id, isDirectory: true)
    do {
      try manager.createDirectory(at: folder, withIntermediateDirectories: true)
    } catch {
      return done(nil)
    }

    let providers = items.flatMap { $0.attachments ?? [] }
    var entries = [[String: Any]?](repeating: nil, count: providers.count)
    let lock = NSLock()
    let waiting = DispatchGroup()
    for (index, provider) in providers.enumerated() {
      waiting.enter()
      Item.load(provider, index: index, into: folder) { entry in
        lock.lock()
        entries[index] = entry
        lock.unlock()
        waiting.leave()
      }
    }
    waiting.notify(queue: .global()) {
      let kept = entries.compactMap { $0 }
      let manifest: [String: Any] = ["v": 1, "at": now, "items": kept]
      guard !kept.isEmpty,
        let data = try? JSONSerialization.data(withJSONObject: manifest),
        (try? data.write(to: folder.appendingPathComponent("manifest.json"), options: .atomic))
          != nil
      else {
        try? manager.removeItem(at: folder)
        return done(nil)
      }
      done(id)
    }
  }

  /// Items the app never took within a day go, so the container does not fill up.
  private static func dropOld(in root: URL, now: Int) {
    let manager = FileManager.default
    guard
      let folders = try? manager.contentsOfDirectory(
        at: root, includingPropertiesForKeys: nil, options: [])
    else { return }
    let limit = now - 24 * 60 * 60 * 1000
    for folder in folders {
      let made = folder.lastPathComponent.split(separator: "-").first.flatMap { Int($0) }
      if let made, made < limit { try? manager.removeItem(at: folder) }
    }
  }
}

/// One shared item: a photo or a file copied into the folder, a web link, or text.
private enum Item {
  static func load(
    _ provider: NSItemProvider, index: Int, into folder: URL,
    done: @escaping ([String: Any]?) -> Void
  ) {
    let fileURL = provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      return loadFile(provider, type: UTType.image, index: index, into: folder, done: done)
    }
    if !fileURL && provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      _ = provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
        guard let url = item as? URL else { return done(nil) }
        if url.isFileURL {
          return done(Item.store(url, type: nil, provider: provider, index: index, into: folder))
        }
        done(["kind": "url", "url": url.absoluteString])
      }
      return
    }
    if !fileURL && provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      _ = provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) {
        item, _ in
        if let text = item as? String { return done(["kind": "text", "text": text]) }
        if let data = item as? Data, let text = String(data: data, encoding: .utf8) {
          return done(["kind": "text", "text": text])
        }
        if let url = item as? URL, url.isFileURL {
          return done(Item.store(url, type: nil, provider: provider, index: index, into: folder))
        }
        done(nil)
      }
      return
    }
    loadFile(provider, type: UTType.data, index: index, into: folder, done: done)
  }

  /// A file's own bytes: the most specific type the provider has of `type`.
  private static func loadFile(
    _ provider: NSItemProvider, type: UTType, index: Int, into folder: URL,
    done: @escaping ([String: Any]?) -> Void
  ) {
    let specific = provider.registeredTypeIdentifiers.first { identifier in
      guard identifier != UTType.fileURL.identifier, let candidate = UTType(identifier) else {
        return false
      }
      return candidate.conforms(to: type)
    }
    let identifier = specific ?? type.identifier
    let kind = UTType(identifier)
    _ = provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in
      if let url {
        return done(Item.store(url, type: kind, provider: provider, index: index, into: folder))
      }
      // Some apps share a picture only as an image object, or a file only by its URL.
      _ = provider.loadItem(forTypeIdentifier: identifier, options: nil) { item, _ in
        if let url = item as? URL, url.isFileURL {
          return done(Item.store(url, type: kind, provider: provider, index: index, into: folder))
        }
        if let image = item as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
          return done(Item.write(data, type: .jpeg, provider: provider, index: index, into: folder))
        }
        if let data = item as? Data {
          return done(Item.write(data, type: kind, provider: provider, index: index, into: folder))
        }
        done(nil)
      }
    }
  }

  /// The name the file goes by: the one the app suggests or the file's own, with its extension.
  private static func fileName(for source: URL?, type: UTType?, provider: NSItemProvider, index: Int)
    -> String
  {
    var name = provider.suggestedName ?? source?.lastPathComponent ?? "item-\(index + 1)"
    if name.isEmpty { name = "item-\(index + 1)" }
    if (name as NSString).pathExtension.isEmpty {
      let ext = type?.preferredFilenameExtension ?? source?.pathExtension ?? ""
      if !ext.isEmpty { name += ".\(ext)" }
    }
    return name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
  }

  private static func entry(at file: URL, stored: String, name: String, type: UTType?)
    -> [String: Any]
  {
    let own = UTType(filenameExtension: (name as NSString).pathExtension) ?? type
    let image = own?.conforms(to: .image) ?? false
    var entry: [String: Any] = [
      "kind": image ? "image" : "file",
      "file": stored,
      "name": name,
      "mimeType": own?.preferredMIMEType ?? "application/octet-stream",
    ]
    if let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize {
      entry["size"] = size
    }
    return entry
  }

  private static func store(
    _ source: URL, type: UTType?, provider: NSItemProvider, index: Int, into folder: URL
  ) -> [String: Any]? {
    let name = fileName(for: source, type: type, provider: provider, index: index)
    let stored = "\(index)-\(name)"
    let target = folder.appendingPathComponent(stored)
    do {
      try FileManager.default.copyItem(at: source, to: target)
    } catch {
      return nil
    }
    return entry(at: target, stored: stored, name: name, type: type)
  }

  private static func write(
    _ data: Data, type: UTType?, provider: NSItemProvider, index: Int, into folder: URL
  ) -> [String: Any]? {
    let name = fileName(for: nil, type: type, provider: provider, index: index)
    let stored = "\(index)-\(name)"
    let target = folder.appendingPathComponent(stored)
    guard (try? data.write(to: target, options: .atomic)) != nil else { return nil }
    return entry(at: target, stored: stored, name: name, type: type)
  }
}
