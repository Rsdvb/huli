// kite-computer-helper on macOS: text recognition with Apple's Vision framework, for the windows
// computer use reads whose accessibility tree misses what their screenshot shows.
//
//   kite-computer-helper serve
//
// Requests on stdin and answers on stdout, one JSON object per line, as on Windows (see
// ../README.md). Only `ocr` is served here; macOS runs no app above the user's rights to mark.

import CoreGraphics
import Foundation
import ImageIO
import Vision

struct Failure: Error {
    let message: String
}

let maxImageBytes = 48 * 1024 * 1024
let maxLines = 400

func rounded(_ value: CGFloat) -> Double {
    (Double(value) * 10).rounded() / 10
}

/// The languages to read: the user's own that Vision reads, then English.
func languages(for request: VNRecognizeTextRequest) -> [String] {
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    var chosen: [String] = []
    for preferred in Locale.preferredLanguages + ["en-US"] {
        let tag = preferred.lowercased()
        let match = supported.first { candidate in
            let lower = candidate.lowercased()
            if lower == tag { return true }
            // zh-Hans-CN reads as zh-Hans, zh-Hant-TW as zh-Hant, en-GB as en-US.
            if tag.hasPrefix("zh-hans") || tag == "zh-cn" { return lower == "zh-hans" }
            if tag.hasPrefix("zh-hant") || tag == "zh-tw" || tag == "zh-hk" { return lower == "zh-hant" }
            return lower.split(separator: "-").first == tag.split(separator: "-").first
        }
        if let match = match, !chosen.contains(match) { chosen.append(match) }
    }
    return chosen
}

func recognize(_ request: [String: Any]) throws -> [String: Any] {
    guard let encoded = request["image"] as? String, let data = Data(base64Encoded: encoded),
        !data.isEmpty, data.count <= maxImageBytes
    else { throw Failure(message: "The image is missing, empty or too large.") }
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw Failure(message: "The image could not be read.") }
    let width = CGFloat(image.width)
    let height = CGFloat(image.height)

    let text = VNRecognizeTextRequest()
    text.recognitionLevel = .accurate
    text.usesLanguageCorrection = true
    if let language = request["language"] as? String, !language.isEmpty {
        text.recognitionLanguages = [language]
    } else {
        let chosen = languages(for: text)
        if !chosen.isEmpty { text.recognitionLanguages = chosen }
        text.automaticallyDetectsLanguage = true
    }
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([text])

    var lines: [[String: Any]] = []
    for observation in text.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        // Vision's boxes are shares of the image from its bottom left; the screenshot's pixels
        // count from its top left.
        let box = observation.boundingBox
        lines.append([
            "text": candidate.string,
            "x": rounded(box.minX * width),
            "y": rounded((1 - box.maxY) * height),
            "width": rounded(box.width * width),
            "height": rounded(box.height * height),
        ])
    }
    lines.sort { a, b in
        let ay = a["y"] as? Double ?? 0
        let by = b["y"] as? Double ?? 0
        return ay != by ? ay < by : (a["x"] as? Double ?? 0) < (b["x"] as? Double ?? 0)
    }
    return [
        "languages": text.recognitionLanguages,
        "width": image.width,
        "height": image.height,
        "lines": Array(lines.prefix(maxLines)),
    ]
}

func answer(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

func serve() {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        var id: Any = NSNull()
        do {
            guard let data = line.data(using: .utf8),
                let request = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { throw Failure(message: "A request is a JSON object.") }
            id = request["id"] ?? NSNull()
            let op = request["op"] as? String ?? ""
            guard op == "ocr" else { throw Failure(message: "Unknown op \(op).") }
            let result = try recognize(request)
            answer(["id": id, "ok": true, "result": result])
        } catch let failure as Failure {
            answer(["id": id, "ok": false, "error": failure.message])
        } catch {
            answer(["id": id, "ok": false, "error": error.localizedDescription])
        }
    }
}

let arguments = CommandLine.arguments
if arguments.count >= 2 && arguments[1] == "serve" {
    serve()
    exit(0)
}
FileHandle.standardError.write("usage: kite-computer-helper serve\n".data(using: .utf8)!)
exit(2)
