// Generates labelled test photos so screenshots prove WHOSE photo is on screen.
// Each image = a real-looking picture (picsum.photos, seeded) + a banner "<LABEL> · #n".
// Falls back to a coloured gradient when offline.
// Files are named <prefix><label>-NN.jpg (lab.sh passes "exposeme-lab-" so it can find and replace its own photos).
//   swift qa/lab/make-photos.swift <outDir> <label> <count> [filePrefix]
import AppKit
import Foundation

let argv = CommandLine.arguments
guard argv.count >= 4, let count = Int(argv[3]) else {
    FileHandle.standardError.write("usage: make-photos.swift <outDir> <label> <count> [filePrefix]\n".data(using: .utf8)!)
    exit(2)
}
let outDir = URL(fileURLWithPath: argv[1], isDirectory: true)
let label = argv[2].uppercased()
let filePrefix = argv.count >= 5 ? argv[4] : ""
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let W = 1080, H = 1440

func fetchBackground(seed: String) -> NSImage? {
    guard let url = URL(string: "https://picsum.photos/seed/\(seed)/\(W)/\(H)") else { return nil }
    var result: NSImage?
    let sem = DispatchSemaphore(value: 0)
    var req = URLRequest(url: url); req.timeoutInterval = 8
    URLSession.shared.dataTask(with: req) { data, _, _ in
        if let data = data { result = NSImage(data: data) }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 10)
    return result
}

for i in 1...count {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let rect = NSRect(x: 0, y: 0, width: W, height: H)

    if let bg = fetchBackground(seed: "\(label.lowercased())-\(i)") {
        bg.draw(in: rect)
    } else {
        let hue = CGFloat((abs(label.hashValue) % 360)) / 360.0
        NSGradient(starting: NSColor(hue: hue, saturation: 0.7, brightness: 0.9, alpha: 1),
                   ending: NSColor(hue: hue, saturation: 0.9, brightness: 0.3, alpha: 1))?.draw(in: rect, angle: -60 + Double(i * 17))
    }

    NSColor.black.withAlphaComponent(0.55).setFill()
    NSRect(x: 0, y: H / 2 - 140, width: W, height: 280).fill()
    let para = NSMutableParagraphStyle(); para.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.boldSystemFont(ofSize: 120),
        .foregroundColor: NSColor.white,
        .paragraphStyle: para,
    ]
    NSAttributedString(string: "\(label) · #\(i)", attributes: attrs)
        .draw(in: NSRect(x: 0, y: H / 2 - 80, width: W, height: 160))
    NSGraphicsContext.restoreGraphicsState()

    let file = outDir.appendingPathComponent(String(format: "%@%@-%02d.jpg", filePrefix, label.lowercased(), i))
    guard let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else { exit(1) }
    try jpg.write(to: file)
}
print("generated \(count) photos for \(label) in \(outDir.path)")
