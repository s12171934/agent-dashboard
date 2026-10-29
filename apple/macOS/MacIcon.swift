import AppKit

// A full-bleed square picture (the page's PWA icons) drawn the way macOS app icons are: a rounded square of 824 on a
// 1024 canvas, with the Dock's soft shadow under it. Without this the Dock shows a bare square, larger than its
// neighbours.
func macIcon(_ src: NSImage) -> NSImage {
    let size = NSSize(width: 1024, height: 1024)
    let shape = NSRect(x: 100, y: 100, width: 824, height: 824)
    return NSImage(size: size, flipped: false) { _ in
        let path = NSBezierPath(roundedRect: shape, xRadius: 185, yRadius: 185)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
        shadow.shadowOffset = NSSize(width: 0, height: -10)
        shadow.shadowBlurRadius = 24
        shadow.set()
        NSColor.black.setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        NSGraphicsContext.saveGraphicsState()
        path.addClip()
        src.draw(in: shape)
        NSGraphicsContext.restoreGraphicsState()
        return true
    }
}
