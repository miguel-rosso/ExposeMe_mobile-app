// Generates labelled test photos so screenshots prove WHOSE photo is on screen.
// Each image = a real-looking picture (picsum.photos, seeded) + a banner "<LABEL> · #n".
// Falls back to a coloured gradient when offline.
// Files are named <prefix><label>-NN.jpg (lab.sh passes "exposeme-lab-" so it can find and replace its own photos).
//   swift qa/lab/make-photos.swift <outDir> <label> <count> [filePrefix]
//
// --edge: the edge-case set instead (EXP-083), fully synthetic and offline, named <prefix><label>-edge-<kind>.jpg:
// large portrait and landscape photos (above the app's 1600 px upload size) and one stored sideways with
// EXIF Orientation=6 that a viewer must rotate. Each one says which it is, marks TOP/BOTTOM and its arrow points up
// when it is shown upright; the circle and the square grid cells stay round/square unless the image is stretched.
//   swift qa/lab/make-photos.swift --edge <outDir> <label> [filePrefix]
import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

// ── Shared ──
let JPEG_QUALITY = 0.85

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("make-photos.swift: \(message)\n".data(using: .utf8)!)
    exit(1)
}

/// Draws into a fresh RGBA bitmap of the given pixel size.
func render(width: Int, height: Int, _ draw: (NSRect) -> Void) -> NSBitmapImageRep {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fail("no bitmap \(width)x\(height)") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(NSRect(x: 0, y: 0, width: width, height: height))
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

func gradient(hueOf label: String, angle: Double, in rect: NSRect) {
    let hue = CGFloat((abs(label.hashValue) % 360)) / 360.0
    NSGradient(starting: NSColor(hue: hue, saturation: 0.7, brightness: 0.9, alpha: 1),
               ending: NSColor(hue: hue, saturation: 0.9, brightness: 0.3, alpha: 1))?.draw(in: rect, angle: angle)
}

func drawCentered(_ text: String, fontSize: CGFloat, in rect: NSRect) {
    let para = NSMutableParagraphStyle(); para.alignment = .center
    NSAttributedString(string: text, attributes: [
        .font: NSFont.boldSystemFont(ofSize: fontSize),
        .foregroundColor: NSColor.white,
        .paragraphStyle: para,
    ]).draw(in: rect)
}

// ── Numbered photos ──
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

func makeNumberedPhotos(outDir: URL, label: String, count: Int, filePrefix: String) throws {
    for i in 1...count {
        let rep = render(width: W, height: H) { rect in
            if let bg = fetchBackground(seed: "\(label.lowercased())-\(i)") {
                bg.draw(in: rect)
            } else {
                gradient(hueOf: label, angle: -60 + Double(i * 17), in: rect)
            }
            NSColor.black.withAlphaComponent(0.55).setFill()
            NSRect(x: 0, y: H / 2 - 140, width: W, height: 280).fill()
            drawCentered("\(label) · #\(i)", fontSize: 120, in: NSRect(x: 0, y: H / 2 - 80, width: W, height: 160))
        }
        let file = outDir.appendingPathComponent(String(format: "%@%@-%02d.jpg", filePrefix, label.lowercased(), i))
        guard let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: JPEG_QUALITY]) else { fail("jpeg encoding") }
        try jpg.write(to: file)
    }
    print("generated \(count) photos for \(label) in \(outDir.path)")
}

// ── Edge-case photos (--edge) ──
/// 12 MP, the size of a typical phone camera shot.
let BIG_SHORT_SIDE = 3024, BIG_LONG_SIDE = 4032
/// EXIF Orientation 6: the stored pixels are the upright picture turned 90° counter-clockwise; viewers rotate them 90° clockwise.
let EXIF_ROTATE_90_CW: Int = 6
let EXIF_UPRIGHT: Int = 1
let GRID_CELLS_ON_SHORT_SIDE = 6

struct EdgePhoto {
    let kind: String          // file name suffix
    let title: String         // what the photo tests, printed on it
    let width: Int, height: Int  // upright (displayed) size
    let exifOrientation: Int
}

let EDGE_PHOTOS = [
    EdgePhoto(kind: "big-portrait", title: "BIG PORTRAIT", width: BIG_SHORT_SIDE, height: BIG_LONG_SIDE, exifOrientation: EXIF_UPRIGHT),
    EdgePhoto(kind: "big-landscape", title: "BIG LANDSCAPE", width: BIG_LONG_SIDE, height: BIG_SHORT_SIDE, exifOrientation: EXIF_UPRIGHT),
    EdgePhoto(kind: "exif-rotated", title: "EXIF ORIENTATION 6", width: BIG_SHORT_SIDE, height: BIG_LONG_SIDE, exifOrientation: EXIF_ROTATE_90_CW),
]

/// The picture as it must look on screen: grid of square cells, a centred circle, TOP/BOTTOM marks, an up arrow and the labels.
func drawUprightEdgePhoto(_ photo: EdgePhoto, label: String, in rect: NSRect) {
    // Every size below is a fraction of the short side, so portrait and landscape share one layout
    let w = rect.width, h = rect.height, unit = min(w, h)
    gradient(hueOf: label, angle: 90, in: rect)

    NSColor.white.withAlphaComponent(0.35).setStroke()
    let cell = unit / CGFloat(GRID_CELLS_ON_SHORT_SIDE)
    let grid = NSBezierPath(); grid.lineWidth = unit / 400
    for x in stride(from: cell, to: w, by: cell) { grid.move(to: NSPoint(x: x, y: 0)); grid.line(to: NSPoint(x: x, y: h)) }
    for y in stride(from: cell, to: h, by: cell) { grid.move(to: NSPoint(x: 0, y: y)); grid.line(to: NSPoint(x: w, y: y)) }
    grid.stroke()

    NSColor.white.setStroke()
    let radius = unit * 0.25
    let circle = NSBezierPath(ovalIn: NSRect(x: w / 2 - radius, y: h / 2 - radius, width: 2 * radius, height: 2 * radius))
    circle.lineWidth = unit / 100
    circle.stroke()

    // Up arrow in the top half (AppKit's y axis points up)
    NSColor.white.setFill()
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: w / 2, y: h - unit * 0.1))
    arrow.line(to: NSPoint(x: w / 2 - unit * 0.07, y: h - unit * 0.2))
    arrow.line(to: NSPoint(x: w / 2 + unit * 0.07, y: h - unit * 0.2))
    arrow.close(); arrow.fill()

    let markSize = unit / 22
    drawCentered("▲ TOP ▲", fontSize: markSize, in: NSRect(x: 0, y: h - markSize * 1.6, width: w, height: markSize * 1.4))
    drawCentered("▼ BOTTOM ▼", fontSize: markSize, in: NSRect(x: 0, y: markSize * 0.2, width: w, height: markSize * 1.4))

    let titleSize = unit / 14, lineHeight = titleSize * 1.3
    NSColor.black.withAlphaComponent(0.55).setFill()
    NSRect(x: 0, y: h / 2 - 2 * lineHeight, width: w, height: 4 * lineHeight).fill()
    let lines = ["\(label) · EDGE", photo.title, "\(photo.width)×\(photo.height) · UPRIGHT"]
    for (i, line) in lines.enumerated() {
        // Middle line centred on the picture's centre
        drawCentered(line, fontSize: titleSize, in: NSRect(x: 0, y: h / 2 - lineHeight / 2 + lineHeight * CGFloat(1 - i), width: w, height: lineHeight))
    }
}

/// The pixels to store: the upright picture itself, or turned 90° counter-clockwise for EXIF Orientation 6.
func storedPixels(of photo: EdgePhoto, label: String) -> CGImage {
    let upright = render(width: photo.width, height: photo.height) { drawUprightEdgePhoto(photo, label: label, in: $0) }
    guard let uprightImage = upright.cgImage else { fail("no image for \(photo.kind)") }
    guard photo.exifOrientation == EXIF_ROTATE_90_CW else { return uprightImage }
    let rotated = render(width: photo.height, height: photo.width) { _ in
        guard let ctx = NSGraphicsContext.current?.cgContext else { fail("no context for \(photo.kind)") }
        // Turning counter-clockwise moves the picture's top to the stored image's left edge
        ctx.translateBy(x: CGFloat(photo.height), y: 0)
        ctx.rotate(by: .pi / 2)
        ctx.draw(uprightImage, in: CGRect(x: 0, y: 0, width: photo.width, height: photo.height))
    }
    guard let rotatedImage = rotated.cgImage else { fail("no rotated image for \(photo.kind)") }
    return rotatedImage
}

func writeJpeg(_ image: CGImage, exifOrientation: Int, to file: URL) {
    guard let dest = CGImageDestinationCreateWithURL(file as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { fail("cannot write \(file.path)") }
    let props: [CFString: Any] = [
        kCGImageDestinationLossyCompressionQuality: JPEG_QUALITY,
        kCGImagePropertyOrientation: exifOrientation,
    ]
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { fail("jpeg encoding of \(file.path)") }
}

func makeEdgePhotos(outDir: URL, label: String, filePrefix: String) {
    for photo in EDGE_PHOTOS {
        let file = outDir.appendingPathComponent("\(filePrefix)\(label.lowercased())-edge-\(photo.kind).jpg")
        writeJpeg(storedPixels(of: photo, label: label), exifOrientation: photo.exifOrientation, to: file)
    }
    print("generated \(EDGE_PHOTOS.count) edge-case photos for \(label) in \(outDir.path)")
}

// ── Command line ──
let argv = Array(CommandLine.arguments.dropFirst())
let usage = "usage: make-photos.swift <outDir> <label> <count> [filePrefix]\n       make-photos.swift --edge <outDir> <label> [filePrefix]\n"
if argv.first == "--edge" {
    guard argv.count >= 3 else { FileHandle.standardError.write(usage.data(using: .utf8)!); exit(2) }
    let outDir = URL(fileURLWithPath: argv[1], isDirectory: true)
    try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    makeEdgePhotos(outDir: outDir, label: argv[2].uppercased(), filePrefix: argv.count >= 4 ? argv[3] : "")
} else {
    guard argv.count >= 3, let count = Int(argv[2]), count >= 1 else { FileHandle.standardError.write(usage.data(using: .utf8)!); exit(2) }
    let outDir = URL(fileURLWithPath: argv[0], isDirectory: true)
    try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    try makeNumberedPhotos(outDir: outDir, label: argv[1].uppercased(), count: count, filePrefix: argv.count >= 4 ? argv[3] : "")
}
