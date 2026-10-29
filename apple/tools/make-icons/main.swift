import AppKit

// Writes the apps' icons from the page's PWA icons (frontend/icons):
// - macOS: the default icon in macOS's shape (MacIcon.swift), at every size the app icon set takes.
// - iOS: the default as AppIcon and every concept × colour (icons/app/<id>/) as an alternate icon named <id>, so the
//   page's 앱 아이콘 choice can switch the home screen icon. Full-bleed and opaque: iOS cuts the shape itself.
// Run from the repository root:
//   apple/build.sh icons   (build.sh also runs it when the icon sets are missing)
let fm = FileManager.default
func picture(_ dir: String) -> NSImage {
    NSImage(contentsOfFile: dir + "/icon.svg") ?? NSImage(contentsOfFile: dir + "/icon-512.png")!
}
func png(_ img: NSImage, _ px: Int, opaque: Bool, to path: String) {
    let cg = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                       bitmapInfo: (opaque ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast).rawValue)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: false)
    NSGraphicsContext.current!.imageInterpolation = .high
    if opaque { NSColor.black.setFill(); NSRect(x: 0, y: 0, width: px, height: px).fill() }
    img.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    try! NSBitmapImageRep(cgImage: cg.makeImage()!).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}
func json(_ obj: Any, to path: String) {
    try! JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: path))
}

let mac = "apple/macOS/Assets.xcassets/AppIcon.appiconset", macIconImage = macIcon(picture("frontend/icons"))
try! fm.createDirectory(atPath: mac, withIntermediateDirectories: true)
json(["info": ["version": 1, "author": "xcode"]], to: "apple/macOS/Assets.xcassets/Contents.json")
var images: [[String: String]] = []
for s in [16, 32, 128, 256, 512] {
    for x in [1, 2] {
        let f = "icon_\(s)x\(s)@\(x)x.png"
        png(macIconImage, s * x, opaque: false, to: "\(mac)/\(f)")
        images.append(["idiom": "mac", "size": "\(s)x\(s)", "scale": "\(x)x", "filename": f])
    }
}
json(["images": images, "info": ["version": 1, "author": "xcode"]], to: "\(mac)/Contents.json")

let ios = "apple/iOS/Assets.xcassets"
try? fm.removeItem(atPath: ios)
try! fm.createDirectory(atPath: ios, withIntermediateDirectories: true)
json(["info": ["version": 1, "author": "xcode"]], to: "\(ios)/Contents.json")
func iosSet(_ name: String, _ dir: String) {
    let set = "\(ios)/\(name).appiconset"
    try! fm.createDirectory(atPath: set, withIntermediateDirectories: true)
    png(picture(dir), 1024, opaque: true, to: "\(set)/icon.png")
    json(["images": [["idiom": "universal", "platform": "ios", "size": "1024x1024", "filename": "icon.png"]],
          "info": ["version": 1, "author": "xcode"]], to: "\(set)/Contents.json")
}
iosSet("AppIcon", "frontend/icons")
for id in try! fm.contentsOfDirectory(atPath: "frontend/icons/app").sorted() where !id.hasPrefix(".") {
    iosSet(id, "frontend/icons/app/\(id)")
}
