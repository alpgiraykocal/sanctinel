import SwiftUI

/// The web app's design tokens, ported so the two clients look like one product.
/// Each colour resolves against the light or dark trait automatically.
enum Palette {
    static let primary = dynamic(light: 0x2563EB, dark: 0x60A5FA)
    static let accent = dynamic(light: 0x7C3AED, dark: 0xA78BFA)
    static let background = dynamic(light: 0xEEF2F8, dark: 0x0B1220)
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x131C31)
    static let surface2 = dynamic(light: 0xF1F5F9, dark: 0x1B2540)
    static let foreground = dynamic(light: 0x0F172A, dark: 0xF1F5F9)
    static let body = dynamic(light: 0x334155, dark: 0xCBD5E1)
    static let mutedFg = dynamic(light: 0x64748B, dark: 0x94A3B8)
    static let border = dynamic(light: 0xE2E8F0, dark: 0x2A3550)
    static let destructive = dynamic(light: 0xDC2626, dark: 0xFCA5A5)
    static let destructiveBg = dynamic(light: 0xFEF2F2, dark: 0x2A1518)
    static let warn = dynamic(light: 0xB45309, dark: 0xFCD34D)
    static let warnBg = dynamic(light: 0xFFFBEB, dark: 0x2A2410)
    static let ok = dynamic(light: 0x15803D, dark: 0x86EFAC)
    static let okBg = dynamic(light: 0xF0FDF4, dark: 0x12261A)

    /// Score bands, matching the web result cards: a strong hit reads red
    /// (stop and verify), a weak one amber (triage), never green — nothing here
    /// is a clearance.
    static func score(_ value: Double) -> Color {
        if value >= 0.95 { return destructive }
        if value >= 0.90 { return warn }
        return mutedFg
    }

    static func scoreBackground(_ value: Double) -> Color {
        if value >= 0.95 { return destructiveBg }
        if value >= 0.90 { return warnBg }
        return surface2
    }

    /// A stable hue per authority so OFAC/EU/UN/UK/BIS/State stay
    /// distinguishable across the search list, detail header and graph.
    static func authority(_ name: String) -> Color {
        switch name.uppercased() {
        case "OFAC": return dynamic(light: 0x1D4ED8, dark: 0x93C5FD)
        case "EU": return dynamic(light: 0x0E7490, dark: 0x67E8F9)
        case "UN": return dynamic(light: 0x0369A1, dark: 0x7DD3FC)
        case "UK": return dynamic(light: 0xB91C1C, dark: 0xFCA5A5)
        case "BIS": return dynamic(light: 0x5B21B6, dark: 0xC4B5FD)
        case "STATE": return dynamic(light: 0x115E59, dark: 0x5EEAD4)
        default: return mutedFg
        }
    }

    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension Font {
    /// The web UI sets identifiers, scores and ids in IBM Plex Mono; SF Mono is
    /// the system equivalent and needs no bundled font file.
    static func monoCaption() -> Font { .system(.caption, design: .monospaced) }
    static func monoBody() -> Font { .system(.callout, design: .monospaced) }
}

// MARK: - Date helpers

enum DateText {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let ymd: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    static func parse(_ raw: String) -> Date? {
        if raw.isEmpty { return nil }
        return iso.date(from: raw) ?? isoPlain.date(from: raw) ?? ymd.date(from: String(raw.prefix(10)))
    }

    /// "24 Jul 2026" — unambiguous across locales, which matters for a list a
    /// compliance analyst reads next to the issuing authority's own site.
    static func medium(_ raw: String) -> String {
        guard let date = parse(raw) else { return raw }
        return date.formatted(.dateTime.day().month(.abbreviated).year())
    }

    static func relative(_ raw: String) -> String {
        guard let date = parse(raw) else { return "" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: .now)
    }
}
