import SwiftUI
import SanctinelCore

/*
 * Snapshot composition and the most recent designations, computed once when the
 * list is imported and read back from disk — the same figures the web app's
 * Insights page shows, from the same snapshot the screening path uses, so the
 * two can never disagree in a review.
 *
 * The web page can afford one long column; a phone cannot. The whole page was
 * six distributions of fifteen rows, a sixteen-bar chart and 346 designations in
 * a single scroll, which is not something anyone reads on a phone. So this
 * screen answers the two questions worth answering at a glance — how big is the
 * list, and what has just been added — and everything else is one tap away.
 */
struct InsightsView: View {
    @Environment(SnapshotService.self) private var service

    private var stats: SnapshotStats? { service.stats }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if service.isStale { StaleBanner(service: service) }
                    if let stats {
                        headline(stats)
                        recentlyAdded(stats)
                        if !stats.years.isEmpty { timelineCard(stats) }
                        latestCard(stats)
                        drillDowns(stats)
                    } else {
                        LoadingState(message: "Reading the statistics…")
                    }
                    DisclaimerBanner(compact: true)
                }
                .padding(16)
            }
            .background(Palette.background)
            .navigationTitle("Insights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { ListPill(service: service) }
            }
            .navigationDestination(for: HitRoute.self) { route in
                EntityDetailView(recordIndex: route.recordIndex, match: route.match)
            }
            .navigationDestination(for: InsightsRoute.self) { route in
                switch route {
                case .composition: CompositionView()
                case .recent: RecentDesignationsView()
                }
            }
            .refreshable { await service.refresh(reason: .manual) }
        }
    }

    // MARK: - Overview

    private func headline(_ stats: SnapshotStats) -> some View {
        Card(title: "This device's list", subtitle: sourceLine) {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    StatTile(value: stats.totals.entities.formatted(), label: "Records")
                    StatTile(value: stats.totals.authorities.formatted(), label: "Authorities")
                    StatTile(value: stats.totals.lists.formatted(), label: "Lists")
                }
                if !stats.byAuthority.isEmpty {
                    // Six short rows, not a fifteen-row table: the split across
                    // authorities is the one distribution worth seeing without
                    // asking for it, because it says what the list covers.
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(stats.byAuthority) { bucket in
                            BarRow(label: bucket.name, count: bucket.count,
                                   total: stats.byAuthority.map(\.count).max() ?? 1)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    private func recentlyAdded(_ stats: SnapshotStats) -> some View {
        Card(title: "Recently designated",
             subtitle: "By the authority's publication date, up to the list on this device.") {
            HStack(spacing: 8) {
                StatTile(value: stats.totals.added30.formatted(), label: "Last 30 days", tint: Palette.warn)
                StatTile(value: stats.totals.added90.formatted(), label: "Last 90 days", tint: Palette.warn)
                StatTile(value: stats.totals.added365.formatted(), label: "Last year", tint: Palette.warn)
            }
        }
    }

    private var sourceLine: String {
        var parts: [String] = []
        let source = service.manifest?.source ?? service.meta.source
        if !source.isEmpty { parts.append(source) }
        let published = service.manifest?.publishedDate ?? service.meta.publishedDate
        if !published.isEmpty { parts.append("published \(DateText.medium(published))") }
        return parts.joined(separator: " · ")
    }

    private func timelineCard(_ stats: SnapshotStats) -> some View {
        let years = stats.years
        let peak = max(1, years.map(\.count).max() ?? 1)
        return Card(title: "Designations by year") {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .bottom, spacing: 3) {
                    ForEach(years) { year in
                        VStack(spacing: 3) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Palette.primary.opacity(year.count == 0 ? 0.18 : 0.75))
                                .frame(height: max(2, 72 * CGFloat(year.count) / CGFloat(peak)))
                            Text(String(year.label.suffix(2)))
                                .font(.system(size: 8))
                                .foregroundStyle(Palette.mutedFg)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(year.label): \(year.count)")
                    }
                }
                .frame(height: 88, alignment: .bottom)
                Text("Peak \(peak.formatted()) in one year · counts the records whose designation date falls in each year.")
                    .font(.caption2)
                    .foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// A handful of the newest listings, then a way to the rest. Tapping one
    /// opens the record — a designation you cannot read is not much use.
    private func latestCard(_ stats: SnapshotStats) -> some View {
        Card(title: "Latest designations") {
            VStack(spacing: 0) {
                let head = Array(stats.recent.prefix(5))
                ForEach(head) { item in
                    RecentRow(item: item)
                    if item.id != head.last?.id { Divider() }
                }
                if stats.recent.count > head.count {
                    NavigationLink(value: InsightsRoute.recent) {
                        HStack {
                            Text("All \(stats.recent.count) recent designations")
                                .font(.callout.weight(.medium))
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption)
                        }
                        .padding(.top, 12)
                    }
                }
            }
        }
    }

    private func drillDowns(_ stats: SnapshotStats) -> some View {
        NavigationLink(value: InsightsRoute.composition) {
            HStack(spacing: 10) {
                Image(systemName: "chart.bar.doc.horizontal")
                    .foregroundStyle(Palette.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Composition")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Palette.foreground)
                    Text("Lists, party types, measures, programs, countries and the structural counts")
                        .font(.caption)
                        .foregroundStyle(Palette.mutedFg)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(Palette.mutedFg)
            }
            .padding(14)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

enum InsightsRoute: Hashable { case composition, recent }

// MARK: - One designation

/// Tappable, because the point of seeing a new designation is being able to read
/// it. Rows for parties that are somehow not in the loaded list stay inert
/// rather than pushing an empty screen.
struct RecentRow: View {
    @Environment(SnapshotService.self) private var service
    let item: SnapshotStats.RecentDesignation

    private var recordIndex: Int? { service.engine?.recordIndex(forID: item.id) }

    var body: some View {
        if let recordIndex {
            NavigationLink(value: HitRoute(recordIndex: recordIndex, match: nil)) {
                content
            }
            .buttonStyle(.plain)
        } else {
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top, spacing: 8) {
                Text(item.name)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Palette.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Text(DateText.medium(item.date))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Palette.mutedFg)
                if recordIndex != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(Palette.mutedFg)
                }
            }
            if !item.title.isEmpty {
                Text(item.title)
                    .font(.caption)
                    .foregroundStyle(Palette.mutedFg)
                    .lineLimit(2)
            }
            WrapTags(tags: tags)
        }
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }

    private var tags: [(String, Tag.Kind)] {
        var out: [(String, Tag.Kind)] = []
        if !item.authority.isEmpty { out.append((item.authority, .authority(item.authority))) }
        if !item.type.isEmpty { out.append((item.type, .type)) }
        for measure in item.measures.prefix(1) { out.append((measure, .measure)) }
        for program in item.programs.prefix(2) { out.append((program, .program)) }
        if !item.country.isEmpty { out.append((item.country, .neutral)) }
        return out
    }
}

// MARK: - Recent designations

struct RecentDesignationsView: View {
    @Environment(SnapshotService.self) private var service
    @State private var authority = ""

    private var all: [SnapshotStats.RecentDesignation] { service.stats?.recent ?? [] }

    private var authorities: [String] {
        var seen: [String] = []
        for item in all where !item.authority.isEmpty && !seen.contains(item.authority) {
            seen.append(item.authority)
        }
        return seen.sorted()
    }

    private var filtered: [SnapshotStats.RecentDesignation] {
        authority.isEmpty ? all : all.filter { $0.authority == authority }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Text("Newest first, by the date the issuing authority published the listing. Each list keeps its own head of the feed, so filtering by authority is never empty for a list that has not published lately.")
                    .font(.caption)
                    .foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 12)

                if !authorities.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            FilterChip(label: "All", isOn: authority.isEmpty) { authority = "" }
                            ForEach(authorities, id: \.self) { name in
                                FilterChip(label: name, isOn: authority == name) {
                                    authority = authority == name ? "" : name
                                }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .padding(.bottom, 8)
                }

                ForEach(filtered) { item in
                    RecentRow(item: item)
                    Divider()
                }
            }
            .padding(16)
        }
        .background(Palette.background)
        .navigationTitle("\(filtered.count) designations")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct FilterChip: View {
    let label: String
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .foregroundStyle(isOn ? Palette.surface : Palette.body)
                .background(isOn ? Palette.primary : Palette.surface2, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Composition

struct CompositionView: View {
    @Environment(SnapshotService.self) private var service

    private var stats: SnapshotStats? { service.stats }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let stats {
                    structureCard(stats)
                    ExpandableDistribution(title: "By list", buckets: stats.byList, tint: Palette.accent)
                    ExpandableDistribution(title: "By party type", buckets: stats.byType, tint: Palette.primary)
                    ExpandableDistribution(title: "By measure", buckets: stats.byMeasure, tint: Palette.warn,
                                           subtitle: "A block freezes property; an export-control listing imposes a licence requirement instead.")
                    ExpandableDistribution(title: "Top programs", buckets: stats.byProgram, tint: Palette.primary)
                    ExpandableDistribution(title: "Top countries", buckets: stats.byCountry, tint: Palette.accent,
                                           subtitle: "From listed addresses and nationality attributes — not a jurisdiction determination.")
                }
            }
            .padding(16)
        }
        .background(Palette.background)
        .navigationTitle("Composition")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func structureCard(_ stats: SnapshotStats) -> some View {
        Card(title: "Structure") {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    StatTile(value: stats.totals.programs.formatted(), label: "Programs")
                    StatTile(value: stats.totals.countries.formatted(), label: "Countries")
                    StatTile(value: stats.totals.withAliases.formatted(), label: "With aliases")
                }
                HStack(spacing: 8) {
                    StatTile(value: stats.totals.withRelationships.formatted(), label: "With relationships")
                    StatTile(value: stats.totals.relationshipEdges.formatted(), label: "Relationship edges")
                    StatTile(value: stats.totals.ownershipEdges.formatted(), label: "Ownership edges", tint: Palette.warn)
                }
                if stats.totals.undated > 0 {
                    Text("\(stats.totals.undated.formatted()) records carry no designation date, so they cannot appear in the timeline or the recent list.")
                        .font(.caption2)
                        .foregroundStyle(Palette.mutedFg)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// Five rows, then the rest on request. A fifteen-row table read on a phone is
/// mostly scrolling past rows nobody asked for.
struct ExpandableDistribution: View {
    let title: String
    let buckets: [SnapshotStats.Bucket]
    var tint: Color = Palette.primary
    var subtitle: String? = nil
    var collapsedCount = 5

    @State private var expanded = false

    private var shown: [SnapshotStats.Bucket] {
        expanded ? buckets : Array(buckets.prefix(collapsedCount))
    }

    var body: some View {
        if buckets.isEmpty {
            EmptyView()
        } else {
            Card(title: title, subtitle: subtitle) {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(shown) { bucket in
                        BarRow(label: bucket.name, count: bucket.count,
                               total: buckets.map(\.count).max() ?? 1, tint: tint)
                    }
                    if buckets.count > collapsedCount {
                        Button {
                            withAnimation(.snappy(duration: 0.22)) { expanded.toggle() }
                        } label: {
                            HStack(spacing: 4) {
                                Text(expanded ? "Show less" : "Show all \(buckets.count)")
                                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                    .font(.caption2)
                            }
                            .font(.caption.weight(.medium))
                        }
                        .padding(.top, 2)
                    }
                }
            }
        }
    }
}
