import SwiftUI
import SanctinelCore

/// A small pill — list, program, type, measure. Colour is the only thing that
/// changes between kinds, so they stack legibly in a wrapped row.
struct Tag: View {
    enum Kind { case authority(String), list, program, type, measure, id, neutral }

    let text: String
    var kind: Kind = .neutral

    private var tint: Color {
        switch kind {
        case .authority(let name): return Palette.authority(name)
        case .list: return Palette.accent
        case .program: return Palette.primary
        case .type: return Palette.primary
        case .measure: return Palette.warn
        case .id: return Palette.mutedFg
        case .neutral: return Palette.mutedFg
        }
    }

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(tint)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(tint.opacity(0.28), lineWidth: 1)
            )
    }
}

/// Match score, 0–1, shown as the percentage analysts read in the web UI.
struct ScoreBadge: View {
    let score: Double
    var compact = false

    private var percent: String { "\(Int((score * 100).rounded()))%" }

    var body: some View {
        Text(percent)
            .font(compact ? .caption.weight(.semibold).monospacedDigit()
                          : .subheadline.weight(.bold).monospacedDigit())
            .padding(.horizontal, compact ? 7 : 9)
            .padding(.vertical, compact ? 3 : 5)
            .foregroundStyle(Palette.score(score))
            .background(Palette.scoreBackground(score), in: Capsule())
            .overlay(Capsule().stroke(Palette.score(score).opacity(0.35), lineWidth: 1))
            .accessibilityLabel("Match score \(percent)")
    }
}

/// Section container matching the web app's card surface.
struct Card<Content: View>: View {
    var title: String?
    var subtitle: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.foreground)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(Palette.mutedFg)
                    }
                }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Palette.border, lineWidth: 1)
        )
    }
}

/// Label/value row used all over the detail screen.
struct FieldRow: View {
    let label: String
    let value: String
    var mono = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(Palette.mutedFg)
            Text(value)
                .font(mono ? .monoBody() : .callout)
                .foregroundStyle(Palette.foreground)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The standing disclaimer. It is deliberately not dismissible: every hit this
/// app shows is a lead to verify with the issuing authority, never a
/// determination, and that has to travel with the results.
struct DisclaimerBanner: View {
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(Palette.primary)
                .font(.caption)
            Text(compact
                 ? "Screening intelligence, not legal advice. Verify hits with the issuing authority."
                 : "Screening intelligence, not legal advice. Hits are leads to verify, not determinations. Confirm against the issuing authority — OFAC, EU, UN, UK OFSI, BIS or DDTC — before any compliance decision. Export-control listings carry licence obligations, not asset freezes.")
                .font(.caption)
                .foregroundStyle(Palette.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

/// How old the list on this device is, shown in the toolbar of every tab. The
/// age is measured from the authority's publication date, not from the download.
struct ListPill: View {
    let service: SnapshotService

    private var dotColor: Color {
        if service.isRefreshing { return Palette.warn }
        return service.isStale ? Palette.destructive : Palette.ok
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(dotColor).frame(width: 7, height: 7)
            Text("\(service.recordCount.formatted()) · \(service.ageText)")
                .font(.caption2)
                .foregroundStyle(service.isStale ? Palette.destructive : Palette.mutedFg)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("List on this device: \(service.recordCount) records, \(service.ageText)")
    }
}

/// A sanctions list that silently ages is worse than one that is visibly
/// missing: the analyst gets the same confident-looking hits from a list that no
/// longer matches what the authority has published. So this is not tucked away
/// in a settings screen — it sits above the results.
struct StaleBanner: View {
    let service: SnapshotService

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Palette.destructive)
                .font(.caption)
            VStack(alignment: .leading, spacing: 6) {
                Text("This list is \(service.ageText). Designations published since are not in it — update before relying on a result.")
                    .font(.caption)
                    .foregroundStyle(Palette.body)
                    .fixedSize(horizontal: false, vertical: true)
                if service.isRefreshing {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Updating…").font(.caption2).foregroundStyle(Palette.mutedFg)
                    }
                } else {
                    Button("Update now") { service.refreshNow() }
                        .font(.caption.weight(.semibold))
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.destructiveBg, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(Palette.destructive.opacity(0.35), lineWidth: 1)
        )
    }
}

struct LoadingState: View {
    var message: String = "Searching…"

    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Palette.mutedFg)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

struct ErrorState: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title)
                .foregroundStyle(Palette.warn)
            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Palette.body)
                .padding(.horizontal, 28)
            if let retry {
                Button("Try again", action: retry)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}

/// Horizontal bar for the Insights distributions.
struct BarRow: View {
    let label: String
    let count: Int
    let total: Int
    var tint: Color = Palette.primary

    private var fraction: Double {
        total > 0 ? min(1, Double(count) / Double(total)) : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(Palette.body)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(count.formatted())
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Palette.mutedFg)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.surface2)
                    Capsule().fill(tint.opacity(0.75))
                        .frame(width: max(2, geo.size.width * fraction))
                }
            }
            .frame(height: 6)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(count)")
    }
}

/// Compact metric tile for the Insights totals grid.
struct StatTile: View {
    let value: String
    let label: String
    var tint: Color = Palette.primary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value)
                .font(.title3.weight(.bold).monospacedDigit())
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Palette.mutedFg)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

/// Tags that wrap onto as many lines as they need.
struct WrapTags: View {
    let tags: [(String, Tag.Kind)]

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(tags.enumerated()), id: \.offset) { _, item in
                Tag(text: item.0, kind: item.1)
            }
        }
    }
}

/// Minimal flow layout — tags wrap instead of truncating, which matters for
/// entities carrying a dozen programs.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
