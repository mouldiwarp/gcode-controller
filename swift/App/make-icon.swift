// Draws the app icon (obsidian tile, gold crosshair and spindle bit) and writes
// an .iconset folder. Make AppIcon.icns from it with:
//   swift swift/App/make-icon.swift AppIcon.iconset && iconutil -c icns AppIcon.iconset -o swift/App/AppIcon.icns
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

let gold = NSColor(srgbRed: 0.773, green: 0.627, blue: 0.349, alpha: 1)
let obsidian = NSColor(srgbRed: 0.071, green: 0.071, blue: 0.071, alpha: 1)
let slate = NSColor(srgbRed: 0.16, green: 0.16, blue: 0.16, alpha: 1)

func draw(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px) / 1024

    // Tile with the standard macOS margin.
    let tile = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let path = NSBezierPath(roundedRect: tile, xRadius: 185 * s, yRadius: 185 * s)
    NSGradient(starting: slate, ending: obsidian)!.draw(in: path, angle: -90)
    gold.withAlphaComponent(0.35).setStroke()
    path.lineWidth = 6 * s
    path.stroke()

    // Toolpath: a gold zig-zag pocket.
    let tp = NSBezierPath()
    tp.lineWidth = 26 * s
    tp.lineCapStyle = .round
    tp.lineJoinStyle = .round
    let left = 250 * s, right = 774 * s
    var y = 280 * s
    tp.move(to: NSPoint(x: left, y: y))
    var toRight = true
    while y < 560 * s {
        tp.line(to: NSPoint(x: toRight ? right : left, y: y))
        y += 70 * s
        tp.line(to: NSPoint(x: toRight ? right : left, y: y))
        toRight.toggle()
    }
    gold.setStroke()
    tp.stroke()

    // End mill coming down onto the path.
    let shank = NSBezierPath(roundedRect: NSRect(x: 452 * s, y: 640 * s, width: 120 * s, height: 190 * s), xRadius: 14 * s, yRadius: 14 * s)
    NSColor(srgbRed: 0.88, green: 0.88, blue: 0.88, alpha: 1).setFill()
    shank.fill()
    let flute = NSBezierPath()
    flute.move(to: NSPoint(x: 452 * s, y: 650 * s))
    flute.line(to: NSPoint(x: 572 * s, y: 650 * s))
    flute.line(to: NSPoint(x: 512 * s, y: 575 * s))
    flute.close()
    NSColor(srgbRed: 0.56, green: 0.56, blue: 0.56, alpha: 1).setFill()
    flute.fill()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        try! draw(base * scale).write(to: URL(fileURLWithPath: "\(out)/\(name)"))
    }
}
