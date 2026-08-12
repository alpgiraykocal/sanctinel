import SwiftUI
import SanctinelCore

/*
 * Screening.
 *
 * The screen belongs to the results. Everything that used to sit above them —
 * the threshold slider, its explanation, a full disclaimer banner — pushed the
 * first hit to the bottom half of a phone, and the threshold is a control most
 * searches never touch. So the query controls all live together in the filter
 * sheet, and anything non-default is reported in the results header instead:
 * lowering the threshold changes what you are looking at, so it must never be
 * invisible, but it does not need permanent screen space to say so.
 *
 * The disclaimer stays with the results, as one line under the hit count that
 * expands on tap. It is the framing every hit has to carry — a lead to verify,
 * never a determination — and the full text is always present in the idle state
 * and on the record itself.
 */
struct SearchView: View {
    @Environment(SnapshotService.self) private var service
    @Environment(RecentStore.self) private var recents
    @State private var model = SearchModel()
    @State private var showFilters = false
    @State private var disclaimerExpanded = false

    var body: some View {
        NavigationStack {
            content
                .background(Palette.background)
                .navigationTitle("Screen")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) { ListPill(service: service) }
                    ToolbarItem(placement: .topBarTrailing) { filterButton }
                }
                .navigationDestination(for: HitRoute.self) { route in
                    EntityDetailView(recordIndex: route.recordIndex, match: route.match)
                }
                .navigationDestination(for: NetworkRoute.self) { route in
                    NetworkView(entityId: route.id, entityName: route.name)
                }
                .sheet(isPresented: $showFilters) {
                    QuerySheet(model: model, meta: service.meta)
                        .presentationDetents([.medium, .large])
                }
        }
        .task { model.attach(service) }
    }

    private var filterButton: some View {
        Button { showFilters = true } label: {
            Image(systemName: model.query.isAdjusted
                  ? "slider.horizontal.3"
                  : "slider.horizontal.3")
                .symbolVariant(model.query.isAdjusted ? .circle.fill : .none)
        }
        .accessibilityLabel(model.query.isAdjusted
                            ? "Query settings, \(model.query.adjustmentCount) changed from default"
                            : "Query settings")
    }

    private var content: some View {
        @Bindable var model = model
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let error = model.errorText {
                    ErrorState(message: error) { model.runNow() }
                } else if !model.hasQuery {
                    idleState
                } else if model.outcome == nil {
                    LoadingState(message: "Scoring the list…")
                } else if model.hits.isEmpty {
                    noHits
                } else {
                    resultsHeader.padding(.horizontal, 16).padding(.top, 8)
                    ForEach(model.hits, id: \.recordIndex) { hit in
                        if let record = model.record(for: hit) {
                            NavigationLink(value: HitRoute(recordIndex: hit.recordIndex, match: hit.match)) {
                                ResultRow(record: record, match: hit.match)
                            }
                            .buttonStyle(.plain)
                            .padding(.horizontal, 16)
                        }
                    }
                }
            }
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .searchable(text: $model.query.q, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Name, alias, passport, tax ID, crypto address")
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .onChange(of: model.query.q) { _, _ in model.runDebounced() }
        .onSubmit(of: .search) { model.runNow() }
        .refreshable { await service.refresh(reason: .manual) }
    }

    // MARK: - Results header

    private var resultsHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(model.outcome?.count ?? 0) hit\((model.outcome?.count ?? 0) == 1 ? "" : "s")")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Palette.foreground)
                if model.isSearching { ProgressView().controlSize(.mini) }
                Spacer()
                if model.query.isAdjusted {
                    Button { showFilters = true } label: {
                        Text(model.query.adjustmentSummary)
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .foregroundStyle(Palette.primary)
                            .background(Palette.primary.opacity(0.12), in: Capsule())
                    }
                }
            }

            if !strengthBreakdown.isEmpty {
                // The analyst's first triage question is not "how many" but "how
                // many are strong" — the scorer already classifies every hit, so
                // say it here instead of making them open each one.
                HStack(spacing: 6) {
                    ForEach(strengthBreakdown, id: \.label) { band in
                        Text("\(band.count) \(band.label)")
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .foregroundStyle(band.tint)
                            .background(band.tint.opacity(0.12), in: Capsule())
                    }
                }
            }

            if let shown = model.outcome?.query,
               shown.caseInsensitiveCompare(model.query.q.trimmingCharacters(in: .whitespacesAndNewlines)) != .orderedSame {
                Text("Showing results for “\(shown)”")
                    .font(.caption2)
                    .foregroundStyle(Palette.mutedFg)
            }
            if let notice = model.truncationNotice {
                notes(notice, tint: Palette.warn)
            }
            if let notice = model.fullScanNotice {
                notes(notice, tint: Palette.mutedFg)
            }

            inlineDisclaimer
        }
    }

    private func notes(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(tint)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// One line, always present with the results; the full text on tap.
    private var inlineDisclaimer: some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { disclaimerExpanded.toggle() }
        } label: {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "info.circle")
                    .font(.caption2)
                    .foregroundStyle(Palette.primary)
                    .padding(.top, 1)
                if disclaimerExpanded {
                    Text("Screening intelligence, not legal advice. Hits are leads to verify, not determinations. Confirm against the issuing authority — OFAC, EU, UN, UK OFSI, BIS or DDTC — before any compliance decision. Export-control listings carry licence obligations, not asset freezes. No match is not a clearance.")
                        .font(.caption2)
                        .foregroundStyle(Palette.body)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Leads to verify — not determinations.")
                        .font(.caption2)
                        .foregroundStyle(Palette.mutedFg)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8))
                        .foregroundStyle(Palette.mutedFg)
                }
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(.plain)
    }

    private struct StrengthBand {
        let label: String
        let count: Int
        let tint: Color
    }

    private var strengthBreakdown: [StrengthBand] {
        var identifier = 0, exact = 0, strong = 0, fuzzy = 0, weak = 0
        for hit in model.hits {
            switch hit.match.matchType {
            case "identifier": identifier += 1
            case "exact": exact += 1
            case "strong", "strong_alias": strong += 1
            case "fuzzy", "weak_alias": fuzzy += 1
            default: weak += 1
            }
        }
        var out: [StrengthBand] = []
        if identifier > 0 { out.append(.init(label: "identifier", count: identifier, tint: Palette.destructive)) }
        if exact > 0 { out.append(.init(label: "exact", count: exact, tint: Palette.destructive)) }
        if strong > 0 { out.append(.init(label: "strong", count: strong, tint: Palette.warn)) }
        if fuzzy > 0 { out.append(.init(label: "fuzzy", count: fuzzy, tint: Palette.mutedFg)) }
        if weak > 0 { out.append(.init(label: "weak", count: weak, tint: Palette.mutedFg)) }
        return out
    }

    // MARK: - Idle

    private var idleState: some View {
        VStack(alignment: .leading, spacing: 12) {
            if service.isStale { StaleBanner(service: service) }

            if !recents.items.isEmpty {
                Card(title: "Recently opened") {
                    VStack(spacing: 0) {
                        let head = Array(recents.items.prefix(6))
                        ForEach(head) { item in
                            RecentRecordRow(item: item)
                            if item.id != head.last?.id { Divider() }
                        }
                    }
                }
            }

            Card(title: "What this screens",
                 subtitle: "\(service.recordCount.formatted()) records across \(service.meta.authorities.joined(separator: " · "))") {
                VStack(alignment: .leading, spacing: 8) {
                    bullet("Fuzzy, multilingual matching across primary names and every listed alias, including native-script forms.")
                    bullet("Identifiers — passport, national ID, tax number, IMO, crypto address — matched exactly.")
                    bullet("The 50 Percent Rule ownership network around any hit, so a clean name owned by a blocked person still surfaces.")
                    bullet("All of it on this device. Your query is never sent anywhere, and the app screens with no network at all.")
                }
            }

            DisclaimerBanner()
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Circle().fill(Palette.primary).frame(width: 5, height: 5).padding(.top, 6)
            Text(text)
                .font(.caption)
                .foregroundStyle(Palette.body)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var noHits: some View {
        VStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.title)
                .foregroundStyle(Palette.mutedFg)
            Text("No hit above \(String(format: "%.2f", model.query.threshold))")
                .font(.headline)
                .foregroundStyle(Palette.foreground)
            Text("No match is not a clearance. Widen the threshold, drop any filters, or try an alias or an identifier.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Palette.mutedFg)
                .padding(.horizontal, 30)
            HStack(spacing: 10) {
                if model.query.threshold > 0.85 {
                    Button("Widen to 0.85") {
                        model.query.threshold = 0.85
                        model.runNow()
                    }
                    .buttonStyle(.borderedProminent)
                }
                if model.query.hasFilters {
                    Button("Clear filters") { model.clearFilters() }
                        .buttonStyle(.bordered)
                }
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
    }
}

// MARK: - Result row

/// One hit. Leads with the score and what kind of match it is, because the first
/// question on any alert is "what actually matched, and how well". The authority
/// is a colour bar rather than a tag so the row stays two or three lines tall and
/// a screenful shows results rather than chrome.
struct ResultRow: View {
    let record: ScreeningRecord
    let match: MatchResult

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(Palette.authority(record.authority))
                .frame(width: 4)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(record.name)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(Palette.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                        Text(provenance)
                            .font(.caption2)
                            .foregroundStyle(Palette.mutedFg)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 3) {
                        ScoreBadge(score: match.score)
                        Text(strengthLabel)
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(Palette.score(match.score))
                    }
                }

                if !match.matchedName.isEmpty, match.matchedName != record.name {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.turn.down.right")
                            .font(.system(size: 9))
                            .foregroundStyle(Palette.mutedFg)
                        Text("\(match.matchedField): \(match.matchedName)")
                            .font(.caption)
                            .foregroundStyle(Palette.body)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }

                HStack(spacing: 6) {
                    if hasOwnership {
                        Label("50% Rule", systemImage: "building.2.crop.circle")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Palette.warn)
                    }
                    if match.conflict {
                        Label("conflict", systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Palette.warn)
                    }
                    if match.corroborated {
                        Label("corroborated", systemImage: "checkmark.seal.fill")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Palette.ok)
                    }
                    if !programsLine.isEmpty {
                        Text(programsLine)
                            .font(.system(size: 10))
                            .foregroundStyle(Palette.primary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.mutedFg)
                }
            }
            .padding(.vertical, 11)
            .padding(.horizontal, 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Palette.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var provenance: String {
        [record.authority, record.list, record.type]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private var programsLine: String {
        let head = record.programs.prefix(2).joined(separator: ", ")
        if record.programs.count > 2 { return head + " +\(record.programs.count - 2)" }
        return head
    }

    private var hasOwnership: Bool {
        record.relationships.contains { Ownership.isOwnership($0.type) }
    }

    /// The scorer's own classification, in the words an analyst triages by.
    private var strengthLabel: String {
        switch match.matchType {
        case "identifier": return "identifier"
        case "exact": return "exact"
        case "strong": return "strong"
        case "strong_alias": return "strong alias"
        case "fuzzy": return "fuzzy"
        case "weak_alias": return "weak alias"
        default: return "weak"
        }
    }
}

/// A previously opened record, reopened directly rather than re-run as a query —
/// a name typed back into the search field is a different question from the
/// record you were just looking at.
struct RecentRecordRow: View {
    @Environment(SnapshotService.self) private var service
    let item: RecentStore.Item

    private var recordIndex: Int? { service.engine?.recordIndex(forID: item.id) }

    var body: some View {
        if let recordIndex {
            NavigationLink(value: HitRoute(recordIndex: recordIndex, match: nil)) {
                content
            }
            .buttonStyle(.plain)
        } else {
            content.opacity(0.5)
        }
    }

    private var content: some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(Palette.authority(item.authority))
                .frame(width: 3, height: 30)
                .clipShape(Capsule())
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                    .font(.callout)
                    .foregroundStyle(Palette.foreground)
                    .lineLimit(1)
                Text("\(item.authority) · \(item.list)")
                    .font(.caption2)
                    .foregroundStyle(Palette.mutedFg)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: recordIndex == nil ? "questionmark.circle" : "chevron.right")
                .font(.caption)
                .foregroundStyle(Palette.mutedFg)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}

// MARK: - Query settings

/// Every control that changes what the engine is asked, in one place. Nothing is
/// applied after the fact — the hit count is always the engine's own.
struct QuerySheet: View {
    @Bindable var model: SearchModel
    let meta: SnapshotMetaData
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Threshold")
                                .font(.callout)
                            Spacer()
                            Text(String(format: "%.2f", model.query.threshold))
                                .font(.callout.monospacedDigit().weight(.semibold))
                                .foregroundStyle(Palette.primary)
                        }
                        Slider(value: $model.query.threshold, in: 0.80...1.0, step: 0.01)
                            .tint(Palette.primary)
                        Text(model.query.threshold < ScreeningEngine.defaultThreshold
                             ? "Below 0.95 every record is scored — slower, a wider net, and more false positives to triage."
                             : "Default. Recall-safe: every hit that can reach 0.95 is reachable from the candidate index.")
                            .font(.caption)
                            .foregroundStyle(Palette.mutedFg)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("Match strength")
                }

                Section("Narrow the list") {
                    Picker("Authority", selection: $model.query.authority) {
                        Text("Any").tag("")
                        ForEach(meta.authorities, id: \.self) { Text($0).tag($0) }
                    }
                    Picker("List", selection: $model.query.list) {
                        Text("Any").tag("")
                        ForEach(meta.lists, id: \.self) { Text($0).tag($0) }
                    }
                    Picker("Program", selection: $model.query.program) {
                        Text("Any").tag("")
                        ForEach(meta.programs, id: \.self) { Text($0).tag($0) }
                    }
                }

                Section {
                    TextField("Year of birth (e.g. 1968)", text: $model.query.yob)
                        .keyboardType(.numberPad)
                    TextField("Country", text: $model.query.country)
                        .autocorrectionDisabled()
                } header: {
                    Text("Corroborating detail")
                } footer: {
                    Text("These do not filter the list — they raise or lower a candidate's score, and flag a hit whose date of birth or country contradicts what you supplied.")
                }
            }
            .navigationTitle("Query")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Reset") { model.resetQuerySettings() }
                        .disabled(!model.query.isAdjusted)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Apply") {
                        model.runNow()
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }
}

struct HitRoute: Hashable {
    let recordIndex: Int
    /// Why this record surfaced. It belongs to the hit rather than the stored
    /// record, so it travels with the navigation rather than being re-derived.
    var match: MatchResult?
}

/// Navigation payload for the ownership graph — an id plus the label to show
/// while the network is being built.
struct NetworkRoute: Hashable {
    let id: String
    let name: String
}
